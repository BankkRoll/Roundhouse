/**
 * Scheduled backups (ADR 0004, "Scheduled dispatch") and the hourly backup
 * maintenance.
 *
 * - {@link claimDueBackups}, a minute-tick claimer: takes each enabled
 *   policy whose `next_run_at` has passed with
 *   `UPDATE … SET next_run_at = :next WHERE id = :id AND next_run_at = :seen`,
 *   inserts the slot's backup (unique per policy and slot) and starts its
 *   workflow under the backup's ID. Two overlapping ticks can't both claim a
 *   slot, and starting an existing instance is a no-op. Missed slots run
 *   once: the next slot is computed from now, not from the missed one.
 * - {@link runBackupMaintenance}, hourly: retention for every policy, then
 *   for archived WAL (`./pitr`), and cleanup of backups and restores whose
 *   workflow is long past its timeout.
 *
 * NOTE: the ADR's `JOBS` queue is skipped: the claimer starts each
 * workflow directly. The conditional update already makes a slot run at
 * most once, the workflow instance ID (the slot's backup ID) makes a
 * repeated start a no-op, and a slot whose start failed is retried by the
 * next tick's sweep of `queued` backups, so a queue would add a binding and
 * a consumer without adding a guarantee.
 *
 * @module
 */
import { backupPolicies, backups, createDb, type Db, restores, services } from "@roundhouse/db";
import { nextCronRun } from "@roundhouse/shared";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import type { Env } from "../../env";
import {
  applyBackupRetention,
  BACKUP_TIMEOUT_S,
  BACKUP_WAIT_GRACE_S,
  backupMethodFor,
  createBackupRow,
  failBackup,
  startBackupWorkflow,
} from "./backups";
import { applyWalRetention } from "./pitr";
import { failRestore } from "./restores";
import { loadBackupStorage } from "./storage";

/** Policies one tick claims. */
export const CLAIM_BATCH = 100;

/**
 * A `queued` backup older than this without progress gets its workflow
 * started again by the minute tick (a start that failed after the insert).
 */
export const REQUEUE_AFTER_MS = 2 * 60 * 1000;

/** `queued` backups re-started per tick. */
const REQUEUE_BATCH = 20;

/** A backup or restore still `running` this long after it started is failed by maintenance. */
export const STUCK_AFTER_MS = (BACKUP_TIMEOUT_S + BACKUP_WAIT_GRACE_S) * 1000 + 60 * 60 * 1000;

/** A backup still `queued` this long after it was created is failed by maintenance. */
export const NEVER_STARTED_AFTER_MS = 24 * 60 * 60 * 1000;

/** Policies whose retention one maintenance run applies. */
const RETENTION_POLICY_BATCH = 200;

/**
 * The next slot of a policy strictly after `now`.
 *
 * @param schedule - Five-field cron, UTC.
 * @param now - Unix ms.
 * @returns Unix ms, or `null` when the schedule never fires.
 */
export function nextBackupSlot(schedule: string, now: number): number | null {
  try {
    return nextCronRun(schedule, now);
  } catch {
    return null;
  }
}

/**
 * Minute-tick claimer for due backup policies.
 *
 * @param env - Worker bindings.
 * @param now - The tick's scheduled time, unix ms.
 * @returns How many slots this tick claimed (plus re-started `queued` backups).
 */
export async function claimDueBackups(env: Env, now: number): Promise<number> {
  const db = createDb(env.DB);
  const due = await db
    .select({ policy: backupPolicies, service: services })
    .from(backupPolicies)
    .innerJoin(services, eq(services.id, backupPolicies.serviceId))
    .where(
      and(
        eq(backupPolicies.enabled, true),
        isNotNull(backupPolicies.nextRunAt),
        lte(backupPolicies.nextRunAt, new Date(now)),
      ),
    )
    .orderBy(asc(backupPolicies.nextRunAt))
    .limit(CLAIM_BATCH);
  let handled = 0;
  for (const { policy, service } of due) {
    const seen = policy.nextRunAt!;
    const next = nextBackupSlot(policy.schedule, now);
    const claimed = await db
      .update(backupPolicies)
      .set({ nextRunAt: next === null ? null : new Date(next), updatedAt: new Date(now) })
      .where(and(eq(backupPolicies.id, policy.id), eq(backupPolicies.nextRunAt, seen)))
      .returning({ id: backupPolicies.id });
    if (!claimed.length || service.deletedAt) continue;
    try {
      const row = await createBackupRow(db, {
        projectId: service.projectId,
        serviceId: service.id,
        environmentId: policy.environmentId,
        trigger: "schedule",
        method: policy.method ?? backupMethodFor(service.databaseEngine),
        engine: service.databaseEngine,
        engineVersion: service.databaseVersion,
        volumeId: null,
        pinned: false,
        requestedBy: null,
        policyId: policy.id,
        scheduledFor: +seen,
      });
      await startBackupWorkflow(env, row.id);
      handled++;
    } catch (err) {
      // The sweep below starts it next tick if the row landed.
      console.error("scheduled backup failed to start", err instanceof Error ? err.name : "error");
    }
  }
  return handled + (await requeueStalled(env, db, now));
}

async function requeueStalled(env: Env, db: Db, now: number): Promise<number> {
  const stalled = await db
    .select({ id: backups.id })
    .from(backups)
    .where(
      and(
        eq(backups.status, "queued"),
        lt(backups.createdAt, new Date(now - REQUEUE_AFTER_MS)),
        gt(backups.createdAt, new Date(now - NEVER_STARTED_AFTER_MS)),
        sql`${backups.trigger} <> 'migration'`,
      ),
    )
    .limit(REQUEUE_BATCH);
  let n = 0;
  for (const b of stalled) {
    try {
      await startBackupWorkflow(env, b.id);
      n++;
    } catch {
      // Tried again next tick.
    }
  }
  return n;
}

/** What one maintenance run did. */
export interface BackupMaintenanceReport {
  /** Backups deleted by retention. */
  expired: number;
  /** Archived WAL files deleted by retention (point-in-time recovery). */
  walExpired: number;
  /** Backups and restores failed for running far past their timeout. */
  stuck: number;
}

/**
 * Hourly backup maintenance: retention for every policy (needs storage to
 * delete objects), then failing backups and restores whose workflow should
 * long have ended (aborting the upload when storage is configured).
 *
 * @param env - Bindings with `DB` and the keyring.
 * @param now - Unix ms.
 * @returns Counts.
 */
export async function runBackupMaintenance(
  env: Pick<Env, "DB" | "MASTER_KEY" | "MASTER_KEYS_PREVIOUS">,
  now = Date.now(),
): Promise<BackupMaintenanceReport> {
  const db = createDb(env.DB);
  const storage = await loadBackupStorage(db, env).catch(() => null);
  const s3 = storage ?? null;
  let expired = 0;
  if (s3) {
    const policies = await db
      .select({ serviceId: backupPolicies.serviceId, environmentId: backupPolicies.environmentId })
      .from(backupPolicies)
      .orderBy(asc(backupPolicies.id))
      .limit(RETENTION_POLICY_BATCH);
    for (const p of policies) {
      expired += await applyBackupRetention(db, s3, p.serviceId, p.environmentId, now);
    }
  }
  let walExpired = 0;
  if (s3) {
    try {
      // After backup retention, which decides which base backups remain.
      walExpired = await applyWalRetention(db, s3, now);
    } catch (err) {
      console.warn("WAL retention failed", err instanceof Error ? err.message : "error");
    }
  }
  let stuck = 0;
  const stale = await db
    .select({ id: backups.id, status: backups.status })
    .from(backups)
    .where(
      and(
        sql`${backups.trigger} <> 'migration'`,
        sql`(
          (${backups.status} = 'running' AND ${backups.startedAt} < ${now - STUCK_AFTER_MS})
          OR (${backups.status} = 'queued' AND ${backups.createdAt} < ${now - NEVER_STARTED_AFTER_MS})
        )`,
      ),
    )
    .limit(100);
  for (const b of stale) {
    const reason = b.status === "running" ? "timed_out" : "never_started";
    if (await failBackup(db, s3, b.id, `${reason}: cleaned up by maintenance`)) stuck++;
  }
  const staleRestores = await db
    .select({ id: restores.id })
    .from(restores)
    .where(
      and(
        inArray(restores.status, ["queued", "running"]),
        lt(restores.createdAt, new Date(now - 2 * STUCK_AFTER_MS)),
        isNull(restores.finishedAt),
      ),
    )
    .limit(100);
  for (const r of staleRestores) {
    if (await failRestore(db, r.id, "timed_out: cleaned up by maintenance")) stuck++;
  }
  return { expired, walExpired, stuck };
}
