/**
 * Recovering a volume whose node is lost (ADR 0004, `target_node_id` on
 * `POST /v1/backups/{id}/restore`): an `in_place` restore that cannot run on
 * the volume's node, because that node is offline or removed, runs on a
 * chosen node instead.
 *
 * {@link startVolumeRecovery} checks the request, then in one batch marks the
 * old volume `abandoned`, creates an empty volume pinned to the target, and
 * records the restore with its `target_node_id`. It then redeploys the
 * service's last deployment (same image and config) onto the target.
 * `RestoreWorkflow` waits until that deployment is active and the new volume
 * ready, as for a `new_service` restore, and restores the backup into it.
 *
 * SECURITY: the volume's node must not be online. A reachable node still
 * holds the live data, which a move copies without loss; recovery would
 * throw away everything written since the backup.
 *
 * @module
 */
import {
  type backups,
  deployments,
  nodes,
  type projects,
  restores,
  type services,
  volumes,
} from "@roundhouse/db";
import { newId, type VolumeStatusName } from "@roundhouse/shared";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { type AppContext, type Caller, clientIp } from "../../context";
import { auditInsert } from "../audit";
import { createDeployment } from "../deployments";
import { refreshNodes } from "../desired-state";
import { ApiError, conflict, isUniqueViolation, notFound } from "../errors";
import { effectiveStatus } from "../nodes";
import { publicOrigin } from "../origin";
import { eligibilityContext, targetIneligibility } from "../volume-migrations";
import { assertNotMoving, volumeOf } from "../volumes";
import { failRestore, type RestoreRow } from "./restores";

/** Volume statuses a recovery replaces; a moving or deleted volume is left alone. */
export const RECOVERABLE_VOLUME_STATUSES: readonly VolumeStatusName[] = [
  "pending",
  "ready",
  "degraded",
  "error",
];

/** Deployment statuses whose image and config the recovery redeploys. */
const REDEPLOYABLE = ["active", "crashed"] as const;

/** What {@link startVolumeRecovery} needs from the restore route. */
export interface VolumeRecoveryInput {
  backup: typeof backups.$inferSelect;
  service: typeof services.$inferSelect;
  project: typeof projects.$inferSelect;
  caller: Caller;
  targetNodeId: string;
}

/**
 * Starts recovering the backup's volume onto `targetNodeId`. The caller has
 * already checked `backups:restore`, a fresh session, `confirm`, that the
 * backup succeeded, and that no other restore runs for the service.
 *
 * @param c - Request context.
 * @param input - The backup, its service and project, the caller, and the target.
 * @returns The queued restore; the caller starts its workflow.
 * @throws {ApiError} 403 without `services:manage` and `deployments:create`;
 *   404 for an unknown target; 409 when there is no placed volume, it is
 *   moving, its node is online, or there is nothing to redeploy; 422
 *   `migration_target_ineligible` when the target can't take the volume.
 */
export async function startVolumeRecovery(
  c: AppContext,
  input: VolumeRecoveryInput,
): Promise<RestoreRow> {
  const { backup, service, project, caller } = input;
  if (!caller.allows("services:manage") || !caller.allows("deployments:create")) {
    throw new ApiError(
      403,
      "forbidden",
      "Recovering onto another server replaces the volume and redeploys: it needs services:manage and deployments:create",
    );
  }
  const db = c.get("db");
  const volume = await volumeOf(db, service.id, backup.environmentId);
  if (!volume?.nodeId) {
    throw conflict("The service has no placed volume in this environment; deploy it instead");
  }
  if (!RECOVERABLE_VOLUME_STATUSES.includes(volume.status)) {
    throw conflict(`The volume is ${volume.status.replace(/_/g, " ")}; it can't be recovered`);
  }
  await assertNotMoving(db, volume);

  const [source] = await db.select().from(nodes).where(eq(nodes.id, volume.nodeId)).limit(1);
  if (source && !source.deletedAt && effectiveStatus(source) !== "offline") {
    throw conflict(
      `The volume's server ${source.name} is ${effectiveStatus(source)}; recovery is for a lost server. Move the volume instead, which keeps every write`,
    );
  }
  const [target] = await db
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.id, input.targetNodeId),
        eq(nodes.workspaceId, project.workspaceId),
        isNull(nodes.deletedAt),
      ),
    )
    .limit(1);
  if (!target) throw notFound("Node");
  const reason = targetIneligibility(target, await eligibilityContext(db, volume));
  if (reason) throw new ApiError(422, "migration_target_ineligible", `${target.name}: ${reason}`);

  const [last] = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.serviceId, service.id),
        eq(deployments.environmentId, backup.environmentId),
        inArray(deployments.status, [...REDEPLOYABLE]),
      ),
    )
    .orderBy(desc(deployments.id))
    .limit(1);
  if (!last) {
    throw conflict("The service has no active deployment to start on the new server");
  }

  const now = new Date();
  const id = newId("restore");
  const volumeId = newId("volume");
  let restore: RestoreRow | undefined;
  try {
    const [, , [inserted]] = await db.batch([
      db
        .update(volumes)
        .set({ status: "abandoned", updatedAt: now })
        .where(
          and(eq(volumes.id, volume.id), inArray(volumes.status, [...RECOVERABLE_VOLUME_STATUSES])),
        ),
      db.insert(volumes).values({
        id: volumeId,
        projectId: volume.projectId,
        environmentId: volume.environmentId,
        serviceId: volume.serviceId,
        mountPath: volume.mountPath,
        sizeMb: volume.sizeMb,
        // Pinned before the redeploy, so the scheduler places the replica on the target.
        nodeId: target.id,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      }),
      db
        .insert(restores)
        .values({
          id,
          backupId: backup.id,
          mode: "in_place",
          targetServiceId: backup.serviceId,
          targetEnvironmentId: backup.environmentId,
          targetNodeId: target.id,
          safetyBackupId: null,
          status: "queued",
          requestedBy: caller.user.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
      auditInsert(db, {
        workspaceId: project.workspaceId,
        ...caller.actor,
        action: "restore.started",
        targetType: "restore",
        targetId: id,
        metadata: {
          project_id: project.id,
          backup_id: backup.id,
          mode: "in_place",
          service_id: backup.serviceId,
          environment_id: backup.environmentId,
          safety_backup_id: null,
          recovery: {
            lost_node_id: volume.nodeId,
            target_node_id: target.id,
            abandoned_volume_id: volume.id,
            volume_id: volumeId,
          },
        },
        ip: clientIp(c),
      }),
    ]);
    restore = inserted;
  } catch (err) {
    // Two recoveries at once: the partial unique index on live volumes lets one win.
    if (isUniqueViolation(err, "volumes")) {
      throw conflict("The volume was replaced meanwhile; reload and try again");
    }
    throw err;
  }

  try {
    await createDeployment(
      { db, env: c.env },
      {
        projectId: project.id,
        serviceId: service.id,
        environmentId: backup.environmentId,
        trigger: "recovery",
        triggeredBy: caller.user.id,
        origin: publicOrigin(c),
        rollbackOf: last,
      },
    );
  } catch (err) {
    // NOTE: The new volume stays pinned to the target: deploying the service
    // places it there, and restoring the backup again finishes the recovery.
    const message = err instanceof Error ? err.message : String(err);
    await failRestore(db, id, `redeploy_failed: ${message}`);
    throw err;
  }
  await refreshNodes(c.env, db, source && !source.deletedAt ? [source.id, target.id] : [target.id]);
  return restore!;
}
