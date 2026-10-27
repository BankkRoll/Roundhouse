/**
 * The cluster snapshot `schedule()` places replicas and job runs against:
 * every node of a workspace that can run sealed workloads, with what is
 * already allocated on it, its zone label, its mesh readiness and whether
 * it can pull the image's registry (`lib/registry.ts`). Shared by the deploy pipeline and the cron
 * runner (ADR 0010), so a running job counts against its node exactly like
 * a replica does.
 *
 * @module
 */
import {
  builds,
  cronRuns,
  type Db,
  deployments,
  nodes,
  PLACEMENT_ONLY_STATES,
  placements,
  serviceConfigs,
  volumes,
} from "@roundhouse/db";
import { MAX_WORKLOADS_PER_NODE } from "@roundhouse/protocol";
import {
  LIVE_VOLUME_STATUSES,
  PLACED_CRON_RUN_STATUSES,
  type ResourcesConfig,
  type SchedulerNode,
  ZONE_LABEL,
} from "@roundhouse/shared";
import { and, eq, inArray, isNotNull, isNull, ne, notInArray, sum } from "drizzle-orm";
import { LIVE_DEPLOYMENT_STATUSES, runsSealedWorkloads } from "./desired-state";
import { isMeshed } from "./mesh";
import { effectiveStatus } from "./nodes";
import { nodesReachingRegistry } from "./registry";
import { getMeshSettings } from "./settings";

/** Memory kept back on every node for the OS, Docker, the agent and Caddy. */
export const SYSTEM_RESERVED_MB = 256;

/** A node row as the snapshot read it. */
export type SnapshotNode = typeof nodes.$inferSelect;

/** What {@link schedulerSnapshot} returns. */
export interface SchedulerSnapshot {
  /** Nodes that run sealed workloads, as `schedule()` takes them. */
  nodes: SchedulerNode[];
  /** The same nodes' rows, by ID. */
  rows: Map<string, SnapshotNode>;
}

/**
 * Nodes running live replicas of an environment's other services: where
 * the environment already lives, for `ScheduleRequest.environmentNodeIds`.
 *
 * @param db - Database client.
 * @param environmentId - The environment.
 * @param serviceId - The service being placed; its own replicas don't count.
 * @returns Distinct node IDs.
 */
export async function environmentNodeIds(
  db: Db,
  environmentId: string,
  serviceId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ nodeId: placements.nodeId })
    .from(placements)
    .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
    .where(
      and(
        eq(deployments.environmentId, environmentId),
        ne(deployments.serviceId, serviceId),
        inArray(deployments.status, [...LIVE_DEPLOYMENT_STATUSES]),
        notInArray(placements.state, [...PLACEMENT_ONLY_STATES]),
      ),
    );
  return rows.map((r) => r.nodeId);
}

/**
 * Reads the scheduler's view of a workspace.
 *
 * Allocated resources are every replica of a live deployment (but the one
 * being placed) plus every cron run in `starting` or `running`, each at its
 * config version's limits. A node at the protocol's workload cap is offered
 * with no memory, so nothing more lands there.
 *
 * @param db - Database client.
 * @param options - The workspace; the deployment being placed, whose own
 *   placements don't count; and the builder whose registry holds the image
 *   (`nodesReachingRegistry` decides who can pull from it).
 * @returns The snapshot.
 */
export async function schedulerSnapshot(
  db: Db,
  options: {
    workspaceId: string;
    excludeDeploymentId?: string;
    registryNodeId: string | null;
  },
): Promise<SchedulerSnapshot> {
  const workspaceNodes = (
    await db
      .select()
      .from(nodes)
      .where(and(eq(nodes.workspaceId, options.workspaceId), isNull(nodes.deletedAt)))
  ).filter(runsSealedWorkloads);
  const mesh = await getMeshSettings(db);
  const configOfDeployment = and(
    eq(serviceConfigs.serviceId, deployments.serviceId),
    eq(serviceConfigs.environmentId, deployments.environmentId),
    eq(serviceConfigs.version, deployments.configVersion),
  );
  const [replicas, jobs, volumeQuotas] = await Promise.all([
    db
      .select({
        nodeId: placements.nodeId,
        serviceId: deployments.serviceId,
        resources: serviceConfigs.resources,
      })
      .from(placements)
      .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
      .innerJoin(serviceConfigs, configOfDeployment)
      .where(
        and(
          inArray(deployments.status, [...LIVE_DEPLOYMENT_STATUSES]),
          notInArray(placements.state, [...PLACEMENT_ONLY_STATES]),
          ...(options.excludeDeploymentId ? [ne(deployments.id, options.excludeDeploymentId)] : []),
        ),
      ),
    db
      .select({
        nodeId: cronRuns.nodeId,
        serviceId: cronRuns.serviceId,
        resources: serviceConfigs.resources,
      })
      .from(cronRuns)
      .innerJoin(deployments, eq(deployments.id, cronRuns.deploymentId))
      .innerJoin(serviceConfigs, configOfDeployment)
      .where(
        and(inArray(cronRuns.status, [...PLACED_CRON_RUN_STATUSES]), isNotNull(cronRuns.nodeId)),
      ),
    db
      .select({ nodeId: volumes.nodeId, total: sum(volumes.sizeMb) })
      .from(volumes)
      .where(and(isNotNull(volumes.nodeId), inArray(volumes.status, [...LIVE_VOLUME_STATUSES])))
      .groupBy(volumes.nodeId),
  ]);
  const allocations: { nodeId: string; serviceId: string; resources: ResourcesConfig }[] = [
    ...replicas,
    ...jobs.map((j) => ({ ...j, nodeId: j.nodeId! })),
  ];
  const quotaOf = new Map(volumeQuotas.map((q) => [q.nodeId, Number(q.total ?? 0)]));
  const reaching = await nodesReachingRegistry(db, workspaceNodes, options.registryNodeId, mesh);
  const schedulerNodes = workspaceNodes.map((n): SchedulerNode => {
    const mine = allocations.filter((a) => a.nodeId === n.id);
    const serviceReplicas: Record<string, number> = {};
    for (const a of mine) serviceReplicas[a.serviceId] = (serviceReplicas[a.serviceId] ?? 0) + 1;
    const full = mine.length >= MAX_WORKLOADS_PER_NODE;
    return {
      id: n.id,
      status: effectiveStatus(n),
      docker: n.capabilities?.docker ?? false,
      labels: n.labels,
      cpuMillis: (n.cpuTotal ?? 0) * 1000,
      memoryMb: full
        ? 0
        : Math.max(0, Math.floor((n.memTotal ?? 0) / 2 ** 20) - SYSTEM_RESERVED_MB),
      allocatedCpuMillis: mine.reduce((total, a) => total + a.resources.cpu_millis, 0),
      allocatedMemoryMb: mine.reduce((total, a) => total + a.resources.memory_mb, 0),
      serviceReplicas,
      reachesRegistry: reaching.has(n.id),
      protocolVersion: n.protocolVersion,
      ...(n.diskTotal ? { diskMb: Math.floor(n.diskTotal / 2 ** 20) } : {}),
      allocatedDiskMb: quotaOf.get(n.id) ?? 0,
      meshReady: isMeshed(n, mesh) && n.meshReady,
      zone: n.labels[ZONE_LABEL] ?? null,
    };
  });
  return { nodes: schedulerNodes, rows: new Map(workspaceNodes.map((n) => [n.id, n])) };
}

/**
 * The node that built a deployment's image, following rollbacks to the
 * build: the registry holding it.
 *
 * @param db - Database client.
 * @param deploymentId - The deployment.
 * @returns The builder's ID, or `null` for images from elsewhere.
 */
export async function builderOfDeployment(db: Db, deploymentId: string): Promise<string | null> {
  let id: string | null = deploymentId;
  for (let hops = 0; id && hops < 32; hops++) {
    const [row]: { buildId: string | null; rollbackOf: string | null }[] = await db
      .select({ buildId: deployments.buildId, rollbackOf: deployments.rollbackOf })
      .from(deployments)
      .where(eq(deployments.id, id))
      .limit(1);
    if (!row) return null;
    if (row.buildId) {
      const [build] = await db
        .select({ nodeId: builds.nodeId })
        .from(builds)
        .where(eq(builds.id, row.buildId))
        .limit(1);
      return build?.nodeId ?? null;
    }
    id = row.rollbackOf;
  }
  return null;
}
