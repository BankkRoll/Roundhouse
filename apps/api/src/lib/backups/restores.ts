/**
 * Restores (ADR 0004, "Restore"): starting and waking the restore
 * workflow, sealing what the agent needs to read a backup, and failing a
 * restore with its `restore.failed` audit entry.
 *
 * SECURITY: the download URL and the project's age identity reach a node
 * only inside a `restore` box sealed to that node and bound to the restore
 * ID, in a frame that expires within 60 s.
 *
 * @module
 */
import { backups, type Db, projects, restores } from "@roundhouse/db";
import {
  restoreSecretsAad,
  type SealedBox,
  SealedRestoreSecretsSchema,
  sealBox,
} from "@roundhouse/protocol";
import { and, eq, inArray } from "drizzle-orm";
import type { Env } from "../../env";
import { auditInsert } from "../audit";
import { disposeRpc } from "../deployments";
import { presignGet, RESTORE_URL_TTL_S, type S3Config } from "../s3";
import { scrubError } from "./backups";

/** A `restores` row. */
export type RestoreRow = typeof restores.$inferSelect;

/** Workflow event the node Durable Object sends on `restore_result`. */
export const RESTORE_EVENT = "restore";

/** Workflow event a finished safety backup sends to its restore. */
export const SAFETY_BACKUP_EVENT = "safety";

/**
 * Starts a restore's workflow (instance ID = restore ID).
 *
 * @param env - Bindings with `RESTORE_WORKFLOW`.
 * @param restoreId - The restore.
 */
export async function startRestoreWorkflow(
  env: Pick<Env, "RESTORE_WORKFLOW">,
  restoreId: string,
): Promise<void> {
  disposeRpc(await env.RESTORE_WORKFLOW.create({ id: restoreId, params: { restoreId } }));
}

/**
 * Wakes a restore's workflow so it re-reads D1. Lost wake-ups are harmless.
 *
 * @param env - Bindings with `RESTORE_WORKFLOW`.
 * @param restoreId - The restore (its workflow instance ID).
 * @param type - {@link RESTORE_EVENT} or {@link SAFETY_BACKUP_EVENT}.
 */
export async function wakeRestoreWorkflow(
  env: Pick<Env, "RESTORE_WORKFLOW">,
  restoreId: string,
  type: typeof RESTORE_EVENT | typeof SAFETY_BACKUP_EVENT,
): Promise<void> {
  try {
    const instance = await env.RESTORE_WORKFLOW.get(restoreId);
    try {
      await instance.sendEvent({ type, payload: {} });
    } finally {
      disposeRpc(instance);
    }
  } catch (err) {
    console.warn("restore wake-up failed", restoreId, err instanceof Error ? err.name : "error");
  }
}

/**
 * Wakes the restores waiting on a safety backup that just finished.
 *
 * @param env - Bindings with `DB`-backed client and `RESTORE_WORKFLOW`.
 * @param db - Database client.
 * @param backupId - The finished `pre_restore` backup.
 */
export async function wakeRestoresAwaiting(
  env: Pick<Env, "RESTORE_WORKFLOW">,
  db: Db,
  backupId: string,
): Promise<void> {
  const waiting = await db
    .select({ id: restores.id })
    .from(restores)
    .where(
      and(eq(restores.safetyBackupId, backupId), inArray(restores.status, ["queued", "running"])),
    );
  for (const r of waiting) await wakeRestoreWorkflow(env, r.id, SAFETY_BACKUP_EVENT);
}

/**
 * Presigns a `GET` of the backup object (valid one hour) and seals it with
 * the age identity to the target node (`restore` box, AAD bound to node and
 * restore).
 *
 * @param s3 - The backup bucket.
 * @param objectKey - The backup's object.
 * @param identity - The project's age identity.
 * @param node - The node's ID and X25519 public key.
 * @param restoreId - The restore.
 * @returns The sealed box.
 */
export async function sealRestoreSecrets(
  s3: S3Config,
  objectKey: string,
  identity: string,
  node: { id: string; publicKey: string },
  restoreId: string,
): Promise<SealedBox> {
  const payload = SealedRestoreSecretsSchema.parse({
    download_url: await presignGet(s3, objectKey, RESTORE_URL_TTL_S),
    age_identity: identity,
  });
  return sealBox(
    node.publicKey,
    JSON.stringify(payload),
    "restore",
    restoreSecretsAad(node.id, restoreId),
  );
}

/**
 * Fails a restore that hasn't finished, audited as `restore.failed` by the
 * system.
 *
 * @param db - Database client.
 * @param restoreId - The restore.
 * @param error - Why; scrubbed before it is stored.
 * @returns Whether this call failed it.
 */
export async function failRestore(db: Db, restoreId: string, error: string): Promise<boolean> {
  const message = scrubError(error);
  const now = new Date();
  const [row] = await db
    .update(restores)
    .set({ status: "failed", error: message, finishedAt: now, updatedAt: now })
    .where(and(eq(restores.id, restoreId), inArray(restores.status, ["queued", "running"])))
    .returning();
  if (!row) return false;
  await auditRestore(db, row, "restore.failed", { error: message });
  return true;
}

/**
 * Records a system audit entry about a restore.
 *
 * @param db - Database client.
 * @param restore - The restore row.
 * @param action - `restore.succeeded` or `restore.failed`.
 * @param extra - More metadata; never a URL or key.
 */
export async function auditRestore(
  db: Db,
  restore: RestoreRow,
  action: "restore.succeeded" | "restore.failed",
  extra: Record<string, unknown> = {},
): Promise<void> {
  const [owner] = await db
    .select({ workspaceId: projects.workspaceId, projectId: projects.id })
    .from(backups)
    .innerJoin(projects, eq(projects.id, backups.projectId))
    .where(eq(backups.id, restore.backupId))
    .limit(1);
  if (!owner) return;
  await auditInsert(db, {
    workspaceId: owner.workspaceId,
    actorType: "system",
    actorId: null,
    action,
    targetType: "restore",
    targetId: restore.id,
    metadata: {
      project_id: owner.projectId,
      backup_id: restore.backupId,
      mode: restore.mode,
      service_id: restore.targetServiceId,
      environment_id: restore.targetEnvironmentId,
      ...extra,
    },
  });
}

/**
 * Name of the service a `new_service` restore creates (ADR 0004).
 *
 * @param slug - The backed-up service's slug.
 * @param at - Unix ms of the restore.
 * @returns `<slug>-restore-<yyyymmdd>`.
 */
export function restoreServiceSlug(slug: string, at: number): string {
  const d = new Date(at).toISOString().slice(0, 10).replace(/-/g, "");
  return `${slug}-restore-${d}`;
}
