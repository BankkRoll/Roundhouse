/**
 * The cluster snapshot `schedule()` places replicas and job runs against:
 * every node of a workspace that can run sealed workloads, with what is
 * already allocated on it. Shared by the deploy pipeline and the cron
 * runner (ADR 0010), so a running job counts against its node exactly like
 * a replica does.
 *
 * @module
 */
import {
  cronRuns,
  type Db,
  deployments,
  nodes,
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
} from "@roundhouse/shared";
import { and, eq, inArray, isNotNull, isNull, ne, sum } from "drizzle-orm";
import { LIVE_DEPLOYMENT_STATUSES, runsSealedWorkloads } from "./desired-state";
import { effectiveStatus } from "./nodes";

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
 * Reads the scheduler's view of a workspace.
 *
 * Allocated resources are every replica of a live deployment (but the one
 * being placed) plus every cron run in `starting` or `running`, each at its
 * config version's limits. A node at the protocol's workload cap is offered
 * with no memory, so nothing more lands there.
 *
 * @param db - Database client.
 * @param options - The workspace; the deployment being placed, whose own
 *   placements don't count; and the node whose local registry holds the
 *   image (only it can pull it until the mesh).
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
      // Until the Phase 2 mesh, only the builder itself can pull from its registry.
      reachesRegistry: options.registryNodeId !== null && n.id === options.registryNodeId,
      protocolVersion: n.protocolVersion,
      ...(n.diskTotal ? { diskMb: Math.floor(n.diskTotal / 2 ** 20) } : {}),
      allocatedDiskMb: quotaOf.get(n.id) ?? 0,
    };
  });
  return { nodes: schedulerNodes, rows: new Map(workspaceNodes.map((n) => [n.id, n])) };
}
