/**
 * Replica placement: a pure, deterministic function from a request and a
 * snapshot of the cluster to a node per replica, or a typed reason why not.
 *
 * Filters, in order: node online, not excluded (the node being drained or
 * the offline node being replaced, ADR 0005), the pinned node (a service
 * whose volume lives there), agent protocol recent enough, Docker
 * available, node selector matches, the environment may span to the node
 * (its nodes and this one are all on a ready mesh, ADR 0005), the node can
 * pull the image (git-built images), volume disk fits, memory fits, CPU
 * fits. Memory is never overcommitted; CPU limits may add up to
 * {@link CPU_OVERCOMMIT_RATIO} times a node's cores.
 *
 * Scoring, for each replica in turn: one point per replica of the same
 * service on the node plus half a point per same-service replica in the
 * node's zone (spread), then most allocated after placement (bin-packing,
 * so whole nodes stay free for large workloads), then node ID.
 *
 * @module
 */
import type { NodeStatus } from "./constants";

/** CPU limits on a node may add up to this many times its cores. */
export const CPU_OVERCOMMIT_RATIO = 2;

/**
 * Score subtracted per same-service replica already on a node. It exceeds
 * the largest bin-packing score (1), so spreading always wins over packing.
 */
export const SPREAD_PENALTY = 1;

/**
 * Score subtracted per same-service replica in the node's zone, the node's
 * own included, so replicas spread across zones before they double up
 * inside one (ADR 0005, "Scheduler across nodes").
 */
export const ZONE_SPREAD_PENALTY = 0.5;

/** Node label naming the failure zone a node is in. */
export const ZONE_LABEL = "topology.roundhouse.io/zone";

/** A node as the scheduler sees it. Build it from `nodes` and current `placements`. */
export interface SchedulerNode {
  id: string;
  status: NodeStatus;
  /** `capabilities.docker` from the agent's last hello. */
  docker: boolean;
  labels: Readonly<Record<string, string>>;
  /** Total CPU in thousandths of a core (cores × 1000). */
  cpuMillis: number;
  /** Memory available to workloads, in MiB (total minus a system reserve). */
  memoryMb: number;
  /** Sum of the CPU limits of every replica already placed on the node. */
  allocatedCpuMillis: number;
  /** Sum of the memory limits of every replica already placed on the node. */
  allocatedMemoryMb: number;
  /** Replicas already on the node, counted per service ID. */
  serviceReplicas: Readonly<Record<string, number>>;
  /**
   * Whether the node can pull the builder's images: shared S3 storage, the
   * builder itself, or a fresh mesh handshake with the builder.
   */
  reachesRegistry: boolean;
  /** `hello.protocol_version` of the node's agent; unchecked when absent. */
  protocolVersion?: number;
  /** Disk available to volumes, in MiB; unchecked when absent (not reported yet). */
  diskMb?: number;
  /** Sum of the quotas of the volumes the node already holds (ADR 0004). */
  allocatedDiskMb?: number;
  /**
   * The node is on the WireGuard mesh and reported it ready (ADR 0005), so
   * an environment may span it and other ready nodes.
   */
  meshReady?: boolean;
  /** The {@link ZONE_LABEL} label; `null` or absent for no zone. */
  zone?: string | null;
}

/** What to place. */
export interface ScheduleRequest {
  serviceId: string;
  replicas: number;
  /** Per-replica CPU limit. */
  cpuMillis: number;
  /** Per-replica memory limit. */
  memoryMb: number;
  /** Labels a node must carry with exactly these values. */
  nodeSelector: Readonly<Record<string, string>>;
  /** The image lives in the builder's local registry (git sources). */
  requiresRegistry: boolean;
  /** Oldest agent protocol that can run the replica, e.g. `VOLUMES_PROTOCOL_VERSION`. */
  minProtocolVersion?: number;
  /** The only node the replica may run on: where its volume's data lives (ADR 0004). */
  pinnedNodeId?: string | null;
  /** Quota of a volume created with this placement, in MiB; 0 when none. */
  diskMb?: number;
  /**
   * Nodes already running other services of the replica's environment.
   * When given, a node outside them is taken only if it and all of them are
   * `meshReady`, since replicas reach each other across nodes only over the
   * mesh. Replicas placed by this call count too.
   */
  environmentNodeIds?: readonly string[];
  /** Nodes that may not take the replica: the one being drained or replaced. */
  excludeNodeIds?: readonly string[];
}

/** One replica's node. */
export interface Placement {
  replica: number;
  nodeId: string;
}

/** Why a node could not take a replica, in filter order. */
export const SCHEDULE_FAILURE_REASONS = [
  "no_nodes",
  "offline",
  "excluded",
  "pinned_elsewhere",
  "agent_outdated",
  "no_docker",
  "selector_mismatch",
  "mesh_unready",
  "registry_unreachable",
  "insufficient_disk",
  "insufficient_memory",
  "insufficient_cpu",
] as const;

/** Why scheduling failed; see {@link SCHEDULE_FAILURE_REASONS}. */
export type ScheduleFailureReason = (typeof SCHEDULE_FAILURE_REASONS)[number];

/** Result of {@link schedule}. */
export type ScheduleResult =
  | { ok: true; placements: Placement[] }
  | {
      ok: false;
      /**
       * The filter that eliminated the last candidates for `replica`, so the
       * most specific explanation: `insufficient_memory` means some nodes
       * passed every earlier filter.
       */
      reason: ScheduleFailureReason;
      /** First replica that could not be placed. */
      replica: number;
      /** Why each node was rejected for that replica, sorted by node ID. */
      rejected: { nodeId: string; reason: Exclude<ScheduleFailureReason, "no_nodes"> }[];
    };

type NodeRejection = Exclude<ScheduleFailureReason, "no_nodes">;

function rejection(
  node: SchedulerNode,
  req: ScheduleRequest,
  alloc: { cpu: number; mem: number },
  hosts: ReadonlySet<string> | null,
  ready: ReadonlyMap<string, boolean>,
): NodeRejection | null {
  if (node.status !== "online") return "offline";
  if (req.excludeNodeIds?.includes(node.id)) return "excluded";
  if (req.pinnedNodeId && node.id !== req.pinnedNodeId) return "pinned_elsewhere";
  if (
    req.minProtocolVersion !== undefined &&
    node.protocolVersion !== undefined &&
    node.protocolVersion < req.minProtocolVersion
  ) {
    return "agent_outdated";
  }
  if (!node.docker) return "no_docker";
  for (const [key, value] of Object.entries(req.nodeSelector)) {
    if (!Object.hasOwn(node.labels, key) || node.labels[key] !== value) return "selector_mismatch";
  }
  if (hosts && [...hosts].some((h) => h !== node.id)) {
    // Unknown hosts (removed nodes) don't block: their replicas are going away.
    const spannable =
      node.meshReady === true && [...hosts].every((h) => h === node.id || ready.get(h) !== false);
    if (!spannable) return "mesh_unready";
  }
  if (req.requiresRegistry && !node.reachesRegistry) return "registry_unreachable";
  if (
    req.diskMb &&
    node.diskMb !== undefined &&
    (node.allocatedDiskMb ?? 0) + req.diskMb > node.diskMb
  ) {
    return "insufficient_disk";
  }
  if (alloc.mem + req.memoryMb > node.memoryMb) return "insufficient_memory";
  if (alloc.cpu + req.cpuMillis > node.cpuMillis * CPU_OVERCOMMIT_RATIO) return "insufficient_cpu";
  return null;
}

/**
 * Packing score after placing one more replica: mean of memory and CPU
 * utilisation, each in [0, 1], with CPU measured against overcommitted
 * capacity.
 */
function packingScore(
  node: SchedulerNode,
  req: ScheduleRequest,
  alloc: { cpu: number; mem: number },
) {
  const mem = node.memoryMb > 0 ? (alloc.mem + req.memoryMb) / node.memoryMb : 1;
  const cpuCap = node.cpuMillis * CPU_OVERCOMMIT_RATIO;
  const cpu = cpuCap > 0 ? (alloc.cpu + req.cpuMillis) / cpuCap : 1;
  return (mem + cpu) / 2;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Chooses a node for every replica of a deployment. Deterministic: the same
 * request and nodes, in any order, give the same placements.
 *
 * @param request - Service, replica count, per-replica limits and constraints.
 * @param nodes - Cluster snapshot, including what is already allocated.
 * @returns A placement per replica, or the first replica that did not fit
 *   with the reason and per-node rejections. Nothing is placed on failure.
 * @example
 * const result = schedule(
 *   { serviceId: "svc_1", replicas: 2, cpuMillis: 500, memoryMb: 256, nodeSelector: {}, requiresRegistry: false },
 *   nodes,
 * );
 * if (!result.ok) console.log(result.reason); // e.g. "insufficient_memory"
 */
export function schedule(
  request: ScheduleRequest,
  nodes: readonly SchedulerNode[],
): ScheduleResult {
  const sorted = [...nodes].sort(byId);
  if (sorted.length === 0) return { ok: false, reason: "no_nodes", replica: 0, rejected: [] };

  const alloc = new Map(
    sorted.map((n) => [
      n.id,
      {
        cpu: n.allocatedCpuMillis,
        mem: n.allocatedMemoryMb,
        same: n.serviceReplicas[request.serviceId] ?? 0,
      },
    ]),
  );
  const zoneOf = new Map(sorted.map((n) => [n.id, n.zone ?? null]));
  const zoneCounts = new Map<string, number>();
  for (const n of sorted) {
    const same = n.serviceReplicas[request.serviceId] ?? 0;
    if (n.zone && same) zoneCounts.set(n.zone, (zoneCounts.get(n.zone) ?? 0) + same);
  }
  const placements: Placement[] = [];
  const hosts = request.environmentNodeIds ? new Set(request.environmentNodeIds) : null;
  const ready = new Map(sorted.map((n) => [n.id, n.meshReady === true]));

  for (let replica = 0; replica < request.replicas; replica++) {
    let best: { node: SchedulerNode; score: number } | undefined;
    const rejected: { nodeId: string; reason: NodeRejection }[] = [];
    for (const node of sorted) {
      const a = alloc.get(node.id)!;
      const reason = rejection(node, request, a, hosts, ready);
      if (reason) {
        rejected.push({ nodeId: node.id, reason });
        continue;
      }
      const zone = zoneOf.get(node.id);
      const score =
        packingScore(node, request, a) -
        SPREAD_PENALTY * a.same -
        (zone ? ZONE_SPREAD_PENALTY * (zoneCounts.get(zone) ?? 0) : 0);
      // Strictly greater, so ties keep the lower node ID.
      if (!best || score > best.score) best = { node, score };
    }
    if (!best) {
      const order = SCHEDULE_FAILURE_REASONS as readonly string[];
      const reason = rejected.reduce<NodeRejection>(
        (deepest, r) => (order.indexOf(r.reason) > order.indexOf(deepest) ? r.reason : deepest),
        "offline",
      );
      return { ok: false, reason, replica, rejected };
    }
    const a = alloc.get(best.node.id)!;
    a.cpu += request.cpuMillis;
    a.mem += request.memoryMb;
    a.same += 1;
    const zone = zoneOf.get(best.node.id);
    if (zone) zoneCounts.set(zone, (zoneCounts.get(zone) ?? 0) + 1);
    placements.push({ replica, nodeId: best.node.id });
    hosts?.add(best.node.id);
  }
  return { ok: true, placements };
}
