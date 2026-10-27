/**
 * Moving replicas between nodes (ADR 0005, "Node lifecycle"), shared by the
 * drain workflow and the node Durable Object's offline handling.
 *
 * A move inserts a second placement for the same deployment replica on
 * another node (`replaces_workload_id` names the old one) and pushes it.
 * Once the new one is healthy the old row is deleted and its node drops
 * the container: there is never an `ended_at` sweep, so every reader that
 * lists placements only has to tolerate two rows per replica for a moment.
 *
 * - {@link placeReplacement}: schedule one replica elsewhere and insert it.
 * - {@link rescheduleOfflineNode}: after `RESCHEDULE_AFTER_MS` of silence,
 *   stateless replicas are replaced without waiting (the old ones become
 *   `lost`), stateful services are marked `degraded` (`node_offline`).
 * - {@link onReplacementHealthy}: drops a `lost` replaced row once its
 *   replacement serves.
 * - {@link recoverNodeServices}: a node back online (or resumed) clears the
 *   health it caused.
 *
 * Health changes are published to the project's room as `service.updated`,
 * so the dashboard's Degraded badges follow without a reload.
 *
 * Only replicas of settled deployments (`active`, `crashed`) move: a
 * deployment still rolling out decides its own fate.
 *
 * @module
 */
import {
  type Db,
  deployments,
  nodes,
  PLACEMENT_ONLY_STATES,
  placements,
  projects,
  serviceConfigs,
  services,
  volumes,
} from "@roundhouse/db";
import { REGISTRY_LISTEN } from "@roundhouse/protocol";
import {
  newId,
  type ScheduleFailureReason,
  type ServiceHealthReason,
  schedule,
} from "@roundhouse/shared";
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { recordAudit } from "./audit";
import { type RefreshEnv, refreshNodes } from "./desired-state";
import { publish } from "./realtime";
import { builderOfDeployment, environmentNodeIds, schedulerSnapshot } from "./scheduling";
import { toApiService } from "./serialize";

/** Bindings that publish health changes to project rooms. */
export type HealthEnv = Parameters<typeof publish>[0];

/** Deployments whose replicas move: settled ones. */
export const MOVABLE_DEPLOYMENT_STATUSES = ["active", "crashed"] as const;

/** A placement row. */
type PlacementRow = typeof placements.$inferSelect;

/** A replica on a node, with what a move needs. */
export interface MovableReplica {
  placement: PlacementRow;
  serviceId: string;
  serviceName: string;
  environmentId: string;
  workspaceId: string;
  /** A database or a service with a volume: its data lives on the node. */
  stateful: boolean;
}

/**
 * The live replicas of settled deployments on a node, stateless first.
 *
 * @param db - Database client.
 * @param nodeId - The node.
 * @returns Its replicas, with whether each holds data there.
 */
export async function replicasOnNode(db: Db, nodeId: string): Promise<MovableReplica[]> {
  const rows = await db
    .select({
      placement: placements,
      serviceId: deployments.serviceId,
      environmentId: deployments.environmentId,
      serviceName: services.name,
      databaseEngine: services.databaseEngine,
      workspaceId: projects.workspaceId,
    })
    .from(placements)
    .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .where(
      and(
        eq(placements.nodeId, nodeId),
        inArray(deployments.status, [...MOVABLE_DEPLOYMENT_STATUSES]),
        notInArray(placements.state, [...PLACEMENT_ONLY_STATES]),
        isNull(services.deletedAt),
      ),
    )
    .orderBy(placements.workloadId);
  if (!rows.length) return [];
  const serviceIds = [...new Set(rows.map((r) => r.serviceId))];
  const withVolume = new Set<string>();
  // D1 caps bound parameters at 100 per statement.
  for (let i = 0; i < serviceIds.length; i += 50) {
    const held = await db
      .select({ serviceId: volumes.serviceId, environmentId: volumes.environmentId })
      .from(volumes)
      .where(
        and(
          inArray(volumes.serviceId, serviceIds.slice(i, i + 50)),
          notInArray(volumes.status, ["deleted", "abandoned"]),
        ),
      );
    for (const v of held) withVolume.add(`${v.serviceId}:${v.environmentId}`);
  }
  return rows
    .map((r) => ({
      placement: r.placement,
      serviceId: r.serviceId,
      serviceName: r.serviceName,
      environmentId: r.environmentId,
      workspaceId: r.workspaceId,
      stateful: r.databaseEngine !== null || withVolume.has(`${r.serviceId}:${r.environmentId}`),
    }))
    .sort((a, b) => Number(a.stateful) - Number(b.stateful));
}

/** Outcome of {@link placeReplacement}. */
export type Replacement =
  | { ok: true; nodeId: string; workloadId: string }
  | { ok: false; reason: ScheduleFailureReason | "gone" };

/**
 * Schedules one replica on another node and inserts its placement. The
 * vacated node is excluded, and it doesn't count as a node the environment
 * lives on, so a dead node never blocks the span rule.
 *
 * @param db - Database client.
 * @param old - The placement being replaced.
 * @param vacated - The node being left.
 * @returns Where the replacement went, or why it couldn't be placed.
 */
export async function placeReplacement(
  db: Db,
  old: PlacementRow,
  vacated: string,
): Promise<Replacement> {
  const [row] = await db
    .select({ deployment: deployments, config: serviceConfigs, workspaceId: projects.workspaceId })
    .from(deployments)
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .innerJoin(
      serviceConfigs,
      and(
        eq(serviceConfigs.serviceId, deployments.serviceId),
        eq(serviceConfigs.environmentId, deployments.environmentId),
        eq(serviceConfigs.version, deployments.configVersion),
      ),
    )
    .where(eq(deployments.id, old.deploymentId))
    .limit(1);
  if (!row?.deployment.image) return { ok: false, reason: "gone" };
  const d = row.deployment;
  const local = d.image!.startsWith(`${REGISTRY_LISTEN}/`);
  const { nodes: candidates } = await schedulerSnapshot(db, {
    workspaceId: row.workspaceId,
    registryNodeId: local ? await builderOfDeployment(db, d.id) : null,
  });
  const result = schedule(
    {
      serviceId: d.serviceId,
      replicas: 1,
      cpuMillis: row.config.resources.cpu_millis,
      memoryMb: row.config.resources.memory_mb,
      nodeSelector: row.config.placement.node_selector,
      requiresRegistry: local,
      excludeNodeIds: [vacated],
      environmentNodeIds: (await environmentNodeIds(db, d.environmentId, d.serviceId)).filter(
        (id) => id !== vacated,
      ),
    },
    candidates,
  );
  if (!result.ok) return { ok: false, reason: result.reason };
  const nodeId = result.placements[0]!.nodeId;
  const workloadId = newId("workload");
  await db.insert(placements).values({
    id: newId("placement"),
    deploymentId: d.id,
    replica: old.replica,
    nodeId,
    workloadId,
    replacesWorkloadId: old.workloadId,
  });
  return { ok: true, nodeId, workloadId };
}

/**
 * Marks a service `degraded` (once), audits it and tells its project.
 *
 * @param env - Bindings with the project rooms.
 * @param db - Database client.
 * @param r - The stateful replica.
 * @param reason - Why.
 * @param nodeId - The node that caused it.
 * @returns Whether its health changed.
 */
export async function degradeService(
  env: HealthEnv,
  db: Db,
  r: Pick<MovableReplica, "serviceId" | "environmentId" | "workspaceId">,
  reason: ServiceHealthReason,
  nodeId: string,
): Promise<boolean> {
  const [changed] = await db
    .update(services)
    .set({ health: "degraded", healthReason: reason })
    .where(and(eq(services.id, r.serviceId), eq(services.health, "ok")))
    .returning();
  if (!changed) return false;
  await recordAudit(db, {
    workspaceId: r.workspaceId,
    actorType: "system",
    actorId: null,
    action: "service.degraded",
    targetType: "service",
    targetId: r.serviceId,
    metadata: { reason, node_id: nodeId, environment_id: r.environmentId },
  });
  const [node] = await db
    .select({ id: nodes.id, name: nodes.name })
    .from(nodes)
    .where(eq(nodes.id, nodeId))
    .limit(1);
  await publish(env, changed.projectId, {
    type: "service.updated",
    service: toApiService(changed, node ?? null),
  });
  return true;
}

/**
 * Clears the health a node caused: services degraded with `reasons` whose
 * stateful replica runs on it again. Audited as `service.recovered` and
 * published to the project.
 *
 * @param env - Bindings with the project rooms.
 * @param db - Database client.
 * @param nodeId - The node back online or resumed.
 * @param reasons - Which degradations it ends.
 * @returns IDs of the services that recovered.
 */
export async function recoverNodeServices(
  env: HealthEnv,
  db: Db,
  nodeId: string,
  reasons: readonly ServiceHealthReason[],
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ serviceId: services.id, workspaceId: projects.workspaceId })
    .from(placements)
    .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .where(
      and(
        eq(placements.nodeId, nodeId),
        eq(services.health, "degraded"),
        inArray(services.healthReason, [...reasons]),
      ),
    );
  const out: string[] = [];
  for (const r of rows) {
    const [done] = await db
      .update(services)
      .set({ health: "ok", healthReason: null })
      .where(and(eq(services.id, r.serviceId), eq(services.health, "degraded")))
      .returning();
    if (!done) continue;
    out.push(r.serviceId);
    await recordAudit(db, {
      workspaceId: r.workspaceId,
      actorType: "system",
      actorId: null,
      action: "service.recovered",
      targetType: "service",
      targetId: r.serviceId,
      metadata: { node_id: nodeId },
    });
    await publish(env, done.projectId, {
      type: "service.updated",
      service: toApiService(done, null),
    });
  }
  return out;
}

/**
 * Reschedules an offline node's stateless replicas (ADR 0005, "Offline
 * handling"), once per outage: each old placement becomes `lost` (out of
 * desired state, serving and the mesh) and gets a replacement elsewhere,
 * without waiting. Both may serve for a moment if the node comes back,
 * which is acceptable for stateless services. Stateful replicas stay; their
 * services are marked `degraded` (`node_offline`).
 *
 * @param env - Bindings with the node namespace.
 * @param db - Database client.
 * @param nodeId - The silent node.
 * @param now - Unix ms.
 * @returns What happened.
 */
export async function rescheduleOfflineNode(
  env: RefreshEnv & HealthEnv,
  db: Db,
  nodeId: string,
  now = Date.now(),
): Promise<{ moved: number; unplaced: number; degraded: number }> {
  const [claimed] = await db
    .update(nodes)
    .set({ rescheduledAt: new Date(now) })
    .where(
      and(
        eq(nodes.id, nodeId),
        isNull(nodes.deletedAt),
        eq(nodes.status, "offline"),
        isNull(nodes.rescheduledAt),
      ),
    )
    .returning({ id: nodes.id });
  const out = { moved: 0, unplaced: 0, degraded: 0 };
  if (!claimed) return out;
  const targets = new Set<string>();
  for (const r of await replicasOnNode(db, nodeId)) {
    if (r.stateful) {
      if (await degradeService(env, db, r, "node_offline", nodeId)) out.degraded++;
      continue;
    }
    const [lost] = await db
      .update(placements)
      .set({ state: "lost", updatedAt: new Date(now) })
      .where(and(eq(placements.id, r.placement.id), eq(placements.nodeId, nodeId)))
      .returning({ id: placements.id });
    if (!lost) continue;
    const placed = await placeReplacement(db, r.placement, nodeId);
    if (placed.ok) {
      targets.add(placed.nodeId);
      out.moved++;
    } else {
      out.unplaced++;
      console.warn("offline reschedule found no node", r.placement.workloadId, placed.reason);
    }
  }
  if (targets.size) await refreshNodes(env, db, [...targets]);
  return out;
}

/**
 * Deletes the `lost` placement a now-healthy replacement stood in for.
 *
 * @param db - Database client.
 * @param replacesWorkloadId - `replaces_workload_id` of the healthy placement.
 * @returns The node the deleted row was on, to refresh, or `null`.
 */
export async function onReplacementHealthy(
  db: Db,
  replacesWorkloadId: string,
): Promise<string | null> {
  const [gone] = await db
    .delete(placements)
    .where(and(eq(placements.workloadId, replacesWorkloadId), eq(placements.state, "lost")))
    .returning({ nodeId: placements.nodeId });
  return gone?.nodeId ?? null;
}
