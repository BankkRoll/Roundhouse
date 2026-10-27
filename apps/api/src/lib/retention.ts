/**
 * The hourly retention job (Cron Trigger): deletes what has outlived its use.
 *
 * - Log chunks whose newest line is older than `log_retention_days`: the R2
 *   object first, then its `log_chunks` row, so a failed R2 delete leaves
 *   the row for the next run instead of an orphaned object.
 * - GitHub delivery IDs past the redelivery window.
 * - Expired node join tokens, sessions, invites, Better Auth verifications,
 *   GitHub installation claims, and redeemed single-use nonces.
 * - Metrics samples of the D1 fallback older than 48 hours (ADR 0008).
 * - Backups past their policy (ADR 0004): the S3 object first, then the
 *   row; and backups and restores stuck far past their timeout, failed and
 *   their uploads aborted. See `./backups/schedule.ts`.
 * - Sign-in failure counters past their window and no longer locked.
 * - ACME challenges past their expiry, left by an issuance attempt that
 *   died before its cleanup step (ADR 0009).
 * - Web shell recordings of sessions that ended more than
 *   `shell_recording_retention_days` ago (ADR 0012): the R2 parts first,
 *   then the row's recording columns; the session row itself stays, as
 *   audit metadata. See `./shell-recording.ts`.
 *
 * Every deletion runs in bounded batches with a per-run cap, so one run
 * stays well inside a Worker's limits however much has piled up; whatever is
 * left is picked up next hour.
 *
 * @module
 */
import {
  acmeChallenges,
  consumedNonces,
  createDb,
  type Db,
  githubClaimStates,
  githubDeliveries,
  invites,
  logChunks,
  loginAttempts,
  nodeJoinTokens,
  sessions,
  verifications,
} from "@roundhouse/db";
import { D1_METRICS_RETENTION_MS, LOGIN_FAILURE_WINDOW_MS } from "@roundhouse/shared";
import { and, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Env } from "../env";
import { runBackupMaintenance } from "./backups/schedule";
import type { KeyEnv } from "./keyring";
import { getLogRetentionDays, getShellRecordingSettings } from "./settings";
import { pruneShellRecordings } from "./shell-recording";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Log chunks deleted per batch; one R2 `delete` call takes up to 1000 keys. */
export const LOG_CHUNK_BATCH = 500;

/** Rows deleted per statement for the other tables. */
export const ROW_BATCH = 500;

/** Batches per table per run. */
export const MAX_BATCHES_PER_RUN = 20;

/**
 * GitHub redelivers within days; a delivery ID only needs to outlive that
 * window to stop a replay.
 */
export const DELIVERY_RETENTION_MS = 14 * DAY_MS;

/**
 * Expired join tokens and invites are kept this long, so someone using a
 * stale link is told it expired rather than that it never existed.
 */
export const EXPIRED_GRACE_MS = 7 * DAY_MS;

/**
 * Metrics samples deleted per statement. Far larger than {@link ROW_BATCH}:
 * a busy install writes tens of thousands of samples an hour, and these
 * rows are tiny and deleted by `rowid` without binding their keys.
 */
export const METRICS_ROW_BATCH = 5000;

/** D1 binds at most 100 parameters per statement. */
const MAX_BOUND_IDS = 90;

/** Batch sizes and the per-run cap; overridable so tests can exercise batching. */
export interface RetentionLimits {
  logChunkBatch: number;
  rowBatch: number;
  maxBatches: number;
}

const DEFAULT_LIMITS: RetentionLimits = {
  logChunkBatch: LOG_CHUNK_BATCH,
  rowBatch: ROW_BATCH,
  maxBatches: MAX_BATCHES_PER_RUN,
};

/** How many rows of each kind one run deleted. */
export interface RetentionReport {
  logChunks: number;
  githubDeliveries: number;
  joinTokens: number;
  sessions: number;
  invites: number;
  verifications: number;
  nonces: number;
  metricsSamples: number;
  /** Backups deleted by their policy. */
  backups: number;
  /** Backups and restores failed for running far past their timeout. */
  stuckBackups: number;
  loginAttempts: number;
  githubClaims: number;
  acmeChallenges: number;
  /** Shell sessions whose recording was deleted. */
  shellRecordings: number;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Deletes expired log chunks from R2 and D1. */
async function pruneLogChunks(
  db: Db,
  bucket: R2Bucket,
  cutoff: Date,
  limits: RetentionLimits,
): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < limits.maxBatches; batch++) {
    const rows = await db
      .select({ id: logChunks.id, r2Key: logChunks.r2Key })
      .from(logChunks)
      .where(lt(logChunks.lastTs, cutoff))
      .orderBy(logChunks.lastTs)
      .limit(limits.logChunkBatch);
    if (!rows.length) break;
    await bucket.delete(rows.map((r) => r.r2Key));
    for (const ids of chunks(
      rows.map((r) => r.id),
      MAX_BOUND_IDS,
    )) {
      await db.delete(logChunks).where(inArray(logChunks.id, ids));
    }
    deleted += rows.length;
    if (rows.length < limits.logChunkBatch) break;
  }
  return deleted;
}

/**
 * Deletes rows matching `where` in bounded batches. SQLite (and so D1) has
 * no `DELETE … LIMIT`, so each batch selects its keys first.
 */
async function pruneRows(
  db: Db,
  limits: RetentionLimits,
  table: SQLiteTable,
  key: SQLiteColumn,
  where: SQL,
): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < limits.maxBatches; batch++) {
    const rows = (await db.select({ key }).from(table).where(where).limit(limits.rowBatch)) as {
      key: string;
    }[];
    if (!rows.length) break;
    for (const keys of chunks(
      rows.map((r) => r.key),
      MAX_BOUND_IDS,
    )) {
      await db.delete(table).where(inArray(key, keys));
    }
    deleted += rows.length;
    if (rows.length < limits.rowBatch) break;
  }
  return deleted;
}

/** Deletes D1 metrics samples older than `cutoff` (unix ms). */
async function pruneMetricsSamples(
  d1: D1Database,
  cutoff: number,
  limits: RetentionLimits,
): Promise<number> {
  const batch = Math.max(limits.rowBatch, METRICS_ROW_BATCH);
  let deleted = 0;
  for (let i = 0; i < limits.maxBatches; i++) {
    const { meta } = await d1
      .prepare(
        "DELETE FROM metrics_samples WHERE rowid IN (SELECT rowid FROM metrics_samples WHERE timestamp < ? LIMIT ?)",
      )
      .bind(cutoff, batch)
      .run();
    deleted += meta.changes;
    if (meta.changes < batch) break;
  }
  return deleted;
}

/**
 * Runs every retention rule once.
 *
 * @param env - Worker bindings (`DB`, `LOGS`) and the keyring (backup storage credentials).
 * @param now - The run's notion of now, unix ms; the Cron Trigger's scheduled time.
 * @param limits - Batch sizes and the per-run cap.
 * @returns How many rows of each kind were deleted.
 */
export async function runRetention(
  env: Pick<Env, "DB" | "LOGS"> & KeyEnv,
  now = Date.now(),
  limits: RetentionLimits = DEFAULT_LIMITS,
): Promise<RetentionReport> {
  const db = createDb(env.DB);
  const logDays = await getLogRetentionDays(db);
  const shellRecording = await getShellRecordingSettings(db);
  const at = (ms: number) => new Date(now - ms);
  const prune = (table: SQLiteTable, key: SQLiteColumn, where: SQL) =>
    pruneRows(db, limits, table, key, where);
  // NOTE: backup maintenance talks to S3; its failure must not stop the rest.
  const backups = await runBackupMaintenance(env, now).catch((err) => {
    console.error("backup maintenance failed", err instanceof Error ? err.name : "error");
    return { expired: 0, stuck: 0 };
  });
  return {
    backups: backups.expired,
    stuckBackups: backups.stuck,
    logChunks: await pruneLogChunks(db, env.LOGS, at(logDays * DAY_MS), limits),
    githubDeliveries: await prune(
      githubDeliveries,
      githubDeliveries.id,
      lt(githubDeliveries.createdAt, at(DELIVERY_RETENTION_MS)),
    ),
    joinTokens: await prune(
      nodeJoinTokens,
      nodeJoinTokens.id,
      lt(nodeJoinTokens.expiresAt, at(EXPIRED_GRACE_MS)),
    ),
    sessions: await prune(sessions, sessions.id, lt(sessions.expiresAt, at(0))),
    invites: await prune(invites, invites.id, lt(invites.expiresAt, at(EXPIRED_GRACE_MS))),
    verifications: await prune(verifications, verifications.id, lt(verifications.expiresAt, at(0))),
    nonces: await prune(consumedNonces, consumedNonces.id, lt(consumedNonces.expiresAt, at(0))),
    metricsSamples: await pruneMetricsSamples(env.DB, now - D1_METRICS_RETENTION_MS, limits),
    loginAttempts: await prune(
      loginAttempts,
      loginAttempts.id,
      and(
        lt(loginAttempts.lastFailureAt, at(LOGIN_FAILURE_WINDOW_MS)),
        or(isNull(loginAttempts.lockedUntil), lt(loginAttempts.lockedUntil, at(0))),
      )!,
    ),
    githubClaims: await prune(
      githubClaimStates,
      githubClaimStates.id,
      lt(githubClaimStates.expiresAt, at(0)),
    ),
    acmeChallenges: await prune(
      acmeChallenges,
      acmeChallenges.token,
      lt(acmeChallenges.expiresAt, at(0)),
    ),
    shellRecordings: await pruneShellRecordings(
      db,
      env.LOGS,
      at(shellRecording.retentionDays * DAY_MS),
      limits.maxBatches,
    ),
  };
}
