/**
 * Backups (ADR 0004, "Backups"): the decisions and D1/S3 operations the
 * routes, the backup workflow, the node Durable Object, the minute tick and
 * hourly retention share.
 *
 * - Creating a backup row and starting its workflow ({@link requestBackup},
 *   {@link startBackupWorkflow}); waking it ({@link wakeBackupWorkflow}).
 * - Sealing presigned part URLs to the backup's node ({@link sealPartUrls}).
 * - Checking the agent's parts and completing the upload
 *   ({@link completeUpload}).
 * - Failing a backup: abort the upload, mark it, audit `backup.failed` as the
 *   system ({@link failBackup}).
 * - Retention per policy ({@link applyBackupRetention}) and deletion
 *   ({@link deleteBackup}): the S3 object first, then the row.
 *
 * Nothing here returns a presigned URL, a key or a sealed box to a caller
 * that would persist it: Workflow step results are stored, so the steps that
 * presign also seal and send in the same step.
 *
 * @module
 */
import {
  backupParts,
  backupPolicies,
  backups,
  type Db,
  projects,
  restores,
  services,
} from "@roundhouse/db";
import {
  backupPartsAad,
  MAX_BACKUP_PARTS,
  MAX_BACKUP_PARTS_PER_FRAME,
  SealedBackupPartsSchema,
  type SealedBox,
  sealBox,
} from "@roundhouse/protocol";
import {
  type BackupMethodName,
  type BackupTrigger,
  backupObjectKey,
  newId,
  selectExpiredBackups,
} from "@roundhouse/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Env } from "../../env";
import { auditInsert } from "../audit";
import { disposeRpc } from "../deployments";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  deleteObject,
  headObject,
  presignUploadPart,
  type S3Config,
} from "../s3";

/** A `backups` row. */
export type BackupRow = typeof backups.$inferSelect;

/** How long the agent gets for one backup or restore (`timeout_s`). */
export const BACKUP_TIMEOUT_S = 6 * 60 * 60;

/** Extra wait past `timeout_s` before the workflow gives up on the agent (ADR 0004). */
export const BACKUP_WAIT_GRACE_S = 5 * 60;

/** Presigned part URLs sent with `backup_job` (protocol limit 16). */
export const FIRST_JOB_PARTS = 16;

/** Longest error text stored on a backup or restore. */
export const MAX_ERROR_CHARS = 500;

/** Workflow event the node Durable Object sends when a backup's agent answers. */
export const BACKUP_EVENT = "backup";

/**
 * The method a service is backed up with: database services dump with the
 * engine's own tool, everything else snapshots the volume.
 *
 * @param engine - `services.database_engine`.
 * @returns `dump` or `snapshot`.
 */
export function backupMethodFor(engine: string | null): BackupMethodName {
  return engine ? "dump" : "snapshot";
}

/**
 * Makes an error safe to store and show: URLs (a Go `url.Error` quotes the
 * whole presigned URL) and anything that looks like a signature or key
 * are replaced, and the text is capped.
 *
 * @param text - Raw error text from the agent, S3 or a step.
 * @returns At most {@link MAX_ERROR_CHARS} characters.
 * @example
 * scrubError('Put "https://s3.example/b/k?X-Amz-Signature=ab": timeout'); // 'Put "<url>": timeout'
 */
export function scrubError(text: string): string {
  const cleaned = text
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<url>")
    .replace(/X-Amz-[A-Za-z]+=[^\s&"']+/g, "<redacted>")
    .replace(/AGE-SECRET-KEY-1[0-9A-Z]+/g, "<redacted>")
    .trim();
  return (cleaned || "backup failed").slice(0, MAX_ERROR_CHARS);
}

// -----------------------------------------------------------------------------
// Creating and starting
// -----------------------------------------------------------------------------

/** What a new backup is of and why it was taken. */
export interface NewBackup {
  projectId: string;
  serviceId: string;
  environmentId: string;
  trigger: BackupTrigger;
  method: BackupMethodName;
  engine: string | null;
  engineVersion: string | null;
  volumeId: string | null;
  /** Exempt from `keep_last`; manual backups are pinned. */
  pinned: boolean;
  requestedBy: string | null;
  policyId?: string | null;
  /** The schedule slot, for `trigger: "schedule"`. */
  scheduledFor?: number | null;
}

/**
 * Inserts a `queued` backup. A scheduled slot that already has a backup
 * (a duplicate tick) yields that one instead.
 *
 * @param db - Database client.
 * @param input - The backup.
 * @returns The row.
 */
export async function createBackupRow(db: Db, input: NewBackup): Promise<BackupRow> {
  const id = newId("backup");
  const now = new Date();
  const [row] = await db
    .insert(backups)
    .values({
      id,
      projectId: input.projectId,
      serviceId: input.serviceId,
      environmentId: input.environmentId,
      volumeId: input.volumeId,
      policyId: input.policyId ?? null,
      trigger: input.trigger,
      scheduledFor: input.scheduledFor != null ? new Date(input.scheduledFor) : null,
      method: input.method,
      engine: input.engine as BackupRow["engine"],
      engineVersion: input.engineVersion,
      status: "queued",
      objectKey: backupObjectKey({
        projectId: input.projectId,
        serviceId: input.serviceId,
        environmentId: input.environmentId,
        id,
      }),
      pinned: input.pinned,
      requestedBy: input.requestedBy,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [existing] = await db
    .select()
    .from(backups)
    .where(
      and(
        eq(backups.policyId, input.policyId ?? ""),
        eq(backups.scheduledFor, new Date(input.scheduledFor ?? 0)),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("backup insert conflicted with no existing slot");
  return existing;
}

/**
 * Starts a backup's workflow (instance ID = backup ID). Starting one that
 * already exists is a no-op, so retries and duplicate ticks are harmless.
 *
 * @param env - Bindings with `BACKUP_WORKFLOW`.
 * @param backupId - The backup.
 */
export async function startBackupWorkflow(
  env: Pick<Env, "BACKUP_WORKFLOW">,
  backupId: string,
): Promise<void> {
  try {
    disposeRpc(await env.BACKUP_WORKFLOW.create({ id: backupId, params: { backupId } }));
  } catch (err) {
    // An existing instance means a previous attempt got there first.
    try {
      disposeRpc(await env.BACKUP_WORKFLOW.get(backupId));
    } catch {
      throw err;
    }
  }
}

/**
 * Creates a backup and starts its workflow.
 *
 * @param env - Bindings with `BACKUP_WORKFLOW`.
 * @param db - Database client.
 * @param input - The backup.
 * @returns The `queued` row.
 */
export async function requestBackup(
  env: Pick<Env, "BACKUP_WORKFLOW">,
  db: Db,
  input: NewBackup,
): Promise<BackupRow> {
  const row = await createBackupRow(db, input);
  await startBackupWorkflow(env, row.id);
  return row;
}

/**
 * Wakes a backup's workflow so it re-reads D1. Lost wake-ups are harmless:
 * the workflow checks D1 before every wait.
 *
 * @param env - Bindings with `BACKUP_WORKFLOW`.
 * @param backupId - The backup (its workflow instance ID).
 */
export async function wakeBackupWorkflow(
  env: Pick<Env, "BACKUP_WORKFLOW">,
  backupId: string,
): Promise<void> {
  try {
    const instance = await env.BACKUP_WORKFLOW.get(backupId);
    try {
      await instance.sendEvent({ type: BACKUP_EVENT, payload: {} });
    } finally {
      disposeRpc(instance);
    }
  } catch (err) {
    console.warn("backup wake-up failed", backupId, err instanceof Error ? err.name : "error");
  }
}

// -----------------------------------------------------------------------------
// Parts
// -----------------------------------------------------------------------------

/**
 * Presigns consecutive `UploadPart` URLs and seals them to the backup's
 * node (`backup-parts` box, AAD bound to node and backup), each valid for
 * one hour and for one part of this one object.
 *
 * @param s3 - The backup bucket.
 * @param backup - The backup's ID, object key and upload ID.
 * @param node - The node's ID and X25519 public key.
 * @param fromPart - First part number.
 * @param count - How many, capped at 32 and at part 10,000.
 * @returns The sealed box, or `null` when no part number is left.
 */
export async function sealPartUrls(
  s3: S3Config,
  backup: { id: string; objectKey: string; uploadId: string },
  node: { id: string; publicKey: string },
  fromPart: number,
  count: number,
): Promise<SealedBox | null> {
  const last = Math.min(
    MAX_BACKUP_PARTS,
    fromPart + Math.min(count, MAX_BACKUP_PARTS_PER_FRAME) - 1,
  );
  if (fromPart < 1 || last < fromPart) return null;
  const parts = [];
  for (let n = fromPart; n <= last; n++) {
    parts.push({
      part_number: n,
      url: await presignUploadPart(s3, backup.objectKey, backup.uploadId, n),
    });
  }
  const payload = SealedBackupPartsSchema.parse({ parts });
  return sealBox(
    node.publicKey,
    JSON.stringify(payload),
    "backup-parts",
    backupPartsAad(node.id, backup.id),
  );
}

/** Why the agent's upload can't be completed as reported. */
export class BackupIntegrityError extends Error {
  override name = "BackupIntegrityError";
}

/**
 * Checks the parts the agent reported against its result and R2's rules
 * (consecutive from 1, every part but the last exactly `part_size_bytes`),
 * completes the upload, and checks the object's size.
 *
 * @param db - Database client.
 * @param s3 - The backup bucket.
 * @param backup - A running backup whose agent reported success.
 * @throws {BackupIntegrityError} When the parts or the object don't add up.
 */
export async function completeUpload(db: Db, s3: S3Config, backup: BackupRow): Promise<void> {
  const { uploadId, partSizeBytes, partCount, bytesStored } = backup;
  if (!uploadId || !partSizeBytes || !partCount || bytesStored === null) {
    throw new BackupIntegrityError("backup has no completed upload to finish");
  }
  const parts = await db
    .select()
    .from(backupParts)
    .where(eq(backupParts.backupId, backup.id))
    .orderBy(asc(backupParts.partNumber));
  if (parts.length !== partCount) {
    throw new BackupIntegrityError(
      `agent reported ${partCount} parts but uploaded ${parts.length}`,
    );
  }
  let total = 0;
  for (const [i, p] of parts.entries()) {
    if (p.partNumber !== i + 1) throw new BackupIntegrityError(`part ${i + 1} is missing`);
    const isLast = i === parts.length - 1;
    if (isLast ? p.size > partSizeBytes : p.size !== partSizeBytes) {
      throw new BackupIntegrityError(`part ${p.partNumber} has the wrong size`);
    }
    total += p.size;
  }
  if (total !== bytesStored) {
    throw new BackupIntegrityError("uploaded parts don't add up to the reported size");
  }
  await completeMultipartUpload(
    s3,
    backup.objectKey,
    uploadId,
    parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
  );
  const head = await headObject(s3, backup.objectKey);
  if (!head || head.size !== bytesStored) {
    throw new BackupIntegrityError("stored object size doesn't match the upload");
  }
}

// -----------------------------------------------------------------------------
// Failing and deleting
// -----------------------------------------------------------------------------

/**
 * Fails a backup that hasn't finished: aborts its multipart upload (best
 * effort), marks it `failed` with a scrubbed error, and audits
 * `backup.failed` as the system. A backup that already finished is left
 * alone.
 *
 * @param db - Database client.
 * @param s3 - The bucket, or `null` when storage isn't configured.
 * @param backupId - The backup.
 * @param error - Why; scrubbed before it is stored.
 * @returns Whether this call failed it.
 */
export async function failBackup(
  db: Db,
  s3: S3Config | null,
  backupId: string,
  error: string,
): Promise<boolean> {
  const [row] = await db.select().from(backups).where(eq(backups.id, backupId)).limit(1);
  if (!row || (row.status !== "queued" && row.status !== "running")) return false;
  if (s3 && row.uploadId) {
    try {
      await abortMultipartUpload(s3, row.objectKey, row.uploadId);
    } catch (err) {
      // NOTE: the bucket's lifecycle rule aborts incomplete uploads after a day anyway.
      console.warn("abort multipart upload failed", err instanceof Error ? err.message : "error");
    }
  }
  const message = scrubError(error);
  const [project] = await db
    .select({ workspaceId: projects.workspaceId })
    .from(projects)
    .where(eq(projects.id, row.projectId))
    .limit(1);
  const now = new Date();
  const [updated] = await db.batch([
    db
      .update(backups)
      .set({ status: "failed", error: message, finishedAt: now, updatedAt: now })
      .where(and(eq(backups.id, backupId), inArray(backups.status, ["queued", "running"])))
      .returning({ id: backups.id }),
    db.delete(backupParts).where(eq(backupParts.backupId, backupId)),
  ]);
  if (!updated.length) return false;
  if (project) {
    await auditInsert(db, {
      workspaceId: project.workspaceId,
      actorType: "system",
      actorId: null,
      action: "backup.failed",
      targetType: "backup",
      targetId: backupId,
      metadata: {
        project_id: row.projectId,
        service_id: row.serviceId,
        environment_id: row.environmentId,
        trigger: row.trigger,
        error: message,
      },
    });
  }
  return true;
}

/**
 * Deletes a finished backup: the S3 object first, then the row is marked
 * `deleted`, so a failed delete leaves the row for the next attempt.
 *
 * @param db - Database client.
 * @param s3 - The bucket.
 * @param backup - A `succeeded` or `failed` backup.
 * @returns Whether this call marked it deleted.
 */
export async function deleteBackup(db: Db, s3: S3Config, backup: BackupRow): Promise<boolean> {
  if (backup.status !== "succeeded" && backup.status !== "failed") return false;
  await deleteObject(s3, backup.objectKey);
  const now = new Date();
  const updated = await db
    .update(backups)
    .set({ status: "deleted", updatedAt: now })
    .where(and(eq(backups.id, backup.id), inArray(backups.status, ["succeeded", "failed"])))
    .returning({ id: backups.id });
  return updated.length > 0;
}

/**
 * Applies a service's backup policy in one environment (ADR 0004,
 * "Retention"): deletes what {@link selectExpiredBackups} picks. Without a
 * policy nothing is deleted. A backup a running restore reads is kept.
 *
 * @param db - Database client.
 * @param s3 - The bucket.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @param now - Unix ms.
 * @returns How many backups were deleted.
 */
export async function applyBackupRetention(
  db: Db,
  s3: S3Config,
  serviceId: string,
  environmentId: string,
  now = Date.now(),
): Promise<number> {
  const [policy] = await db
    .select({ keepLast: backupPolicies.keepLast, maxAgeDays: backupPolicies.maxAgeDays })
    .from(backupPolicies)
    .where(
      and(eq(backupPolicies.serviceId, serviceId), eq(backupPolicies.environmentId, environmentId)),
    )
    .limit(1);
  if (!policy) return 0;
  const rows = await db
    .select()
    .from(backups)
    .where(
      and(
        eq(backups.serviceId, serviceId),
        eq(backups.environmentId, environmentId),
        inArray(backups.status, ["succeeded", "failed"]),
      ),
    );
  const expired = new Set(
    selectExpiredBackups(
      rows.map((b) => ({
        id: b.id,
        trigger: b.trigger,
        status: b.status,
        pinned: b.pinned,
        createdAt: +b.createdAt,
      })),
      policy,
      now,
    ),
  );
  if (!expired.size) return 0;
  const inUse = new Set(
    (
      await db
        .select({ backupId: restores.backupId })
        .from(restores)
        .where(
          and(
            inArray(restores.backupId, [...expired].slice(0, 90)),
            inArray(restores.status, ["queued", "running"]),
          ),
        )
    ).map((r) => r.backupId),
  );
  let deleted = 0;
  for (const b of rows) {
    if (!expired.has(b.id) || inUse.has(b.id)) continue;
    try {
      if (await deleteBackup(db, s3, b)) deleted++;
    } catch (err) {
      console.warn("backup retention delete failed", err instanceof Error ? err.message : "error");
    }
  }
  return deleted;
}

/**
 * The service and project a backup belongs to, for routes and workflows.
 *
 * @param db - Database client.
 * @param backupId - The backup.
 * @returns The backup with its live service and project, or `undefined`.
 */
export async function backupWithOwners(db: Db, backupId: string) {
  const [row] = await db
    .select({ backup: backups, service: services, project: projects })
    .from(backups)
    .innerJoin(services, eq(services.id, backups.serviceId))
    .innerJoin(projects, eq(projects.id, backups.projectId))
    .where(eq(backups.id, backupId))
    .limit(1);
  return row;
}
