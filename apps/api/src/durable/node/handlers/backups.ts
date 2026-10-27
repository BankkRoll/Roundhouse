/**
 * The node Durable Object's backup and restore frames (ADR 0004):
 *
 * - `backup_parts_request`: presigns the next part URLs and answers with a
 *   signed `backup_parts`, the URLs sealed to this node;
 * - `backup_progress`: records uploaded parts (`backup_parts`) for
 *   `CompleteMultipartUpload`;
 * - `backup_result` / `restore_result`: records the agent's outcome and
 *   wakes the waiting workflow, which reads it back from D1. A volume
 *   migration's copy-out is a backup (`trigger: migration`) and its copy-in
 *   answers with the migration ID as `restore_id`; both wake the migration.
 *
 * SECURITY: every frame is checked against the row's `node_id`, so an agent
 * can only report on (or get URLs for) backups and restores sent to it.
 * Frames about anything else are dropped silently.
 *
 * @module
 */
import { backupParts, backups, type Db, nodes, restores } from "@roundhouse/db";
import type {
  BackupJob,
  BackupParts,
  BackupPartsRequest,
  BackupProgress,
  BackupResult,
  RestoreJob,
  RestoreResult,
  VolumeCopyIn,
  VolumeCopyOut,
} from "@roundhouse/protocol";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Env } from "../../../env";
import { scrubError, sealPartUrls, wakeBackupWorkflow } from "../../../lib/backups/backups";
import { RESTORE_EVENT, wakeRestoreWorkflow } from "../../../lib/backups/restores";
import { loadBackupStorage } from "../../../lib/backups/storage";
import { onMigrationCopyIn, wakeMigrationOfBackup } from "../../../lib/volume-migrations";

type Header = "id" | "node_id" | "iat" | "exp";

/**
 * Body of a `backup_job`, `restore_job`, `volume_copy_out` or
 * `volume_copy_in`; the Durable Object adds the signed header.
 */
export type BackupJobFrameBody =
  | Omit<BackupJob, Header>
  | Omit<RestoreJob, Header>
  | Omit<VolumeCopyOut, Header>
  | Omit<VolumeCopyIn, Header>;

/** Body of a `backup_parts` frame; the Durable Object adds the signed header. */
export type BackupPartsBody = Omit<BackupParts, Header>;

/** A backup or restore frame from an agent. */
export type BackupFrame = BackupPartsRequest | BackupProgress | BackupResult | RestoreResult;

/** What the handlers need from the Durable Object. */
export interface BackupFrameContext {
  db: Db;
  env: Env;
  /** The reporting node, as authenticated at connect. */
  nodeId: string;
  /** Signs and sends a `backup_parts` frame to this node with the credential TTL. */
  reply(frame: BackupPartsBody): Promise<void>;
}

// D1 binds at most 100 parameters per statement; a part row takes four.
const PARTS_PER_STATEMENT = 24;

/**
 * Handles one backup or restore frame.
 *
 * @param ctx - Database, bindings, node and reply channel.
 * @param frame - The validated frame.
 */
export async function onBackupFrame(ctx: BackupFrameContext, frame: BackupFrame): Promise<void> {
  switch (frame.type) {
    case "backup_parts_request":
      return onPartsRequest(ctx, frame);
    case "backup_progress":
      return onProgress(ctx, frame);
    case "backup_result":
      return onBackupResult(ctx, frame);
    case "restore_result":
      return onRestoreResult(ctx, frame);
  }
}

/** A running backup of this node's, or `undefined`. */
async function runningBackup(ctx: BackupFrameContext, backupId: string) {
  const [row] = await ctx.db
    .select()
    .from(backups)
    .where(
      and(eq(backups.id, backupId), eq(backups.nodeId, ctx.nodeId), eq(backups.status, "running")),
    )
    .limit(1);
  return row;
}

async function onPartsRequest(ctx: BackupFrameContext, frame: BackupPartsRequest) {
  const backup = await runningBackup(ctx, frame.backup_id);
  if (!backup?.uploadId) return;
  const [node] = await ctx.db
    .select({ key: nodes.encryptionPublicKey })
    .from(nodes)
    .where(and(eq(nodes.id, ctx.nodeId), isNull(nodes.deletedAt)))
    .limit(1);
  const storage = await loadBackupStorage(ctx.db, ctx.env);
  if (!node?.key || !storage) return;
  const sealed = await sealPartUrls(
    storage,
    { id: backup.id, objectKey: backup.objectKey, uploadId: backup.uploadId },
    { id: ctx.nodeId, publicKey: node.key },
    frame.from_part,
    frame.count,
  );
  if (!sealed) return;
  await ctx.reply({ type: "backup_parts", backup_id: backup.id, parts_sealed: sealed });
}

async function onProgress(ctx: BackupFrameContext, frame: BackupProgress) {
  const backup = await runningBackup(ctx, frame.backup_id);
  if (!backup?.partSizeBytes) return;
  const limit = backup.partSizeBytes;
  const parts = frame.parts.filter((p) => p.size <= limit);
  const statements = [];
  for (let i = 0; i < parts.length; i += PARTS_PER_STATEMENT) {
    statements.push(
      ctx.db
        .insert(backupParts)
        .values(
          parts.slice(i, i + PARTS_PER_STATEMENT).map((p) => ({
            backupId: backup.id,
            partNumber: p.part_number,
            etag: p.etag,
            size: p.size,
          })),
        )
        .onConflictDoUpdate({
          target: [backupParts.backupId, backupParts.partNumber],
          set: { etag: sql`excluded.etag`, size: sql`excluded.size` },
        }),
    );
  }
  statements.push(
    ctx.db
      .update(backups)
      .set({ bytesRaw: frame.bytes_raw, updatedAt: new Date() })
      .where(and(eq(backups.id, backup.id), eq(backups.status, "running"))),
  );
  await ctx.db.batch(statements as [(typeof statements)[number], ...typeof statements]);
}

async function onBackupResult(ctx: BackupFrameContext, frame: BackupResult) {
  const backup = await runningBackup(ctx, frame.backup_id);
  if (!backup) return;
  const now = new Date();
  const answered = and(
    eq(backups.id, backup.id),
    eq(backups.status, "running"),
    isNull(backups.sha256),
    isNull(backups.error),
  );
  if (frame.ok) {
    await ctx.db
      .update(backups)
      .set({
        partCount: frame.part_count!,
        bytesRaw: frame.bytes_raw!,
        bytesStored: frame.bytes_stored!,
        sha256: frame.sha256!,
        updatedAt: now,
      })
      .where(answered);
  } else {
    await ctx.db
      .update(backups)
      .set({ error: scrubError(frame.error ?? "backup failed"), updatedAt: now })
      .where(answered);
  }
  if (backup.trigger === "migration") await wakeMigrationOfBackup(ctx.env, ctx.db, backup.id);
  else await wakeBackupWorkflow(ctx.env, backup.id);
}

async function onRestoreResult(ctx: BackupFrameContext, frame: RestoreResult) {
  const now = new Date();
  const [row] = await ctx.db
    .update(restores)
    .set({
      error: frame.ok ? null : scrubError(frame.error ?? "restore failed"),
      finishedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(restores.id, frame.restore_id),
        eq(restores.nodeId, ctx.nodeId),
        eq(restores.status, "running"),
        isNull(restores.finishedAt),
      ),
    )
    .returning({ id: restores.id });
  if (row) {
    await wakeRestoreWorkflow(ctx.env, row.id, RESTORE_EVENT);
    return;
  }
  await onMigrationCopyIn(ctx.env, ctx.db, ctx.nodeId, frame);
}
