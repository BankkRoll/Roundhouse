/**
 * Replica placement: a pure, deterministic function from a request and a
 * snapshot of the cluster to a node per replica, or a typed reason why not.
 *
 * Filters, in order: node online, Docker available, node selector matches,
 * the node can pull from the builder's registry (git-built images), memory
 * fits, CPU fits. Memory is never overcommitted; CPU limits may add up to
 * {@link CPU_OVERCOMMIT_RATIO} times a node's cores.
 *
 * Scoring, for each replica in turn: fewest replicas of the same service on
 * the node first (spread), then most allocated after placement (bin-packing,
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
   * Whether the node can pull from the builder's registry: the builder
   * itself until the Phase 2 mesh exposes the registry to every node.
   */
  reachesRegistry: boolean;
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
  "no_docker",
  "selector_mismatch",
  "registry_unreachable",
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
): NodeRejection | null {
  if (node.status !== "online") return "offline";
  if (!node.docker) return "no_docker";
  for (const [key, value] of Object.entries(req.nodeSelector)) {
    if (!Object.hasOwn(node.labels, key) || node.labels[key] !== value) return "selector_mismatch";
  }
  if (req.requiresRegistry && !node.reachesRegistry) return "registry_unreachable";
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
  const placements: Placement[] = [];

  for (let replica = 0; replica < request.replicas; replica++) {
    let best: { node: SchedulerNode; score: number } | undefined;
    const rejected: { nodeId: string; reason: NodeRejection }[] = [];
    for (const node of sorted) {
      const a = alloc.get(node.id)!;
      const reason = rejection(node, request, a);
      if (reason) {
        rejected.push({ nodeId: node.id, reason });
        continue;
      }
      const score = packingScore(node, request, a) - SPREAD_PENALTY * a.same;
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
    placements.push({ replica, nodeId: best.node.id });
  }
  return { ok: true, placements };
}
