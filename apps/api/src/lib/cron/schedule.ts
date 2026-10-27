/**
 * The cron dispatcher (ADR 0010, "Dispatch and missed runs") and the state
 * it reads: `cron_states`, one row per cron service and environment.
 *
 * - {@link armCronState}: called when a cron deployment becomes `active`;
 *   sets `next_run_at` to the next slot after now (arming never runs one).
 * - {@link claimDueCronRuns}, a minute-tick claimer: for each due state it
 *   lists the slots since `next_run_at`, keeps the latest if it is within
 *   `starting_deadline_s` and records the rest as one `missed` run, claims
 *   the state with `UPDATE … WHERE next_run_at = :seen`, inserts the runs
 *   under deterministic IDs and starts the queued run's workflow. A lost
 *   claim race does nothing; a run whose workflow failed to start is
 *   started by a later tick's sweep of `queued` runs.
 * - {@link setCronPaused}: pause clears `next_run_at` (no runs, no missed
 *   records); resume starts from the next future slot.
 *
 * NOTE: like scheduled backups, this skips the ADR's `JOBS` queue: the
 * workflow instance ID (the run ID) already makes a repeated start a no-op.
 *
 * @module
 */
import { createDb, cronRuns, cronStates, type Db, services } from "@roundhouse/db";
import { type CronConfig, nextRuns } from "@roundhouse/shared";
import { and, asc, eq, gt, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import type { Env } from "../../env";
import {
  armedDeployment,
  type CronRunRow,
  cronRunId,
  publishCronRuns,
  startCronRunWorkflow,
} from "./runs";

/** States one tick claims. */
export const CRON_CLAIM_BATCH = 100;

/** Most slots one claim lists; older ones are folded into the missed count's message. */
export const MAX_LISTED_SLOTS = 1000;

/** A `queued` run this old without a start gets its workflow started again. */
export const CRON_REQUEUE_AFTER_MS = 2 * 60 * 1000;

/** `queued` runs older than this are left to the history (their slot is long gone). */
const REQUEUE_HORIZON_MS = 24 * 60 * 60 * 1000;

/** `queued` runs re-started per tick. */
const REQUEUE_BATCH = 20;

/**
 * The next slot of a cron config strictly after `now`.
 *
 * @param cron - The config.
 * @param now - Unix ms.
 * @returns Unix ms, or `null` when the schedule never fires (or no longer parses).
 */
export function nextCronSlot(cron: Pick<CronConfig, "schedule" | "timezone">, now: number) {
  try {
    return nextRuns(cron.schedule, cron.timezone, now, 1)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Arms a cron service in an environment: (re)computes `next_run_at` from
 * the armed deployment's schedule. A paused state stays paused.
 *
 * @param db - Database client.
 * @param input - Service, environment, the deployed cron config and now.
 * @returns The next slot, or `null` while paused or when the schedule never fires.
 */
export async function armCronState(
  db: Db,
  input: { serviceId: string; environmentId: string; cron: CronConfig; now: number },
): Promise<number | null> {
  const next = nextCronSlot(input.cron, input.now);
  const at = new Date(input.now);
  const [row] = await db
    .insert(cronStates)
    .values({
      serviceId: input.serviceId,
      environmentId: input.environmentId,
      nextRunAt: next === null ? null : new Date(next),
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [cronStates.serviceId, cronStates.environmentId],
      set: {
        nextRunAt: sql`CASE WHEN ${cronStates.paused} THEN NULL ELSE ${next} END`,
        updatedAt: at,
      },
    })
    .returning({ nextRunAt: cronStates.nextRunAt });
  return row?.nextRunAt ? +row.nextRunAt : null;
}

/**
 * Pauses or resumes a cron service in an environment.
 *
 * @param db - Database client.
 * @param input - Service, environment, the wanted state and now.
 * @returns The state's `next_run_at` afterwards.
 */
export async function setCronPaused(
  db: Db,
  input: { serviceId: string; environmentId: string; paused: boolean; now: number },
): Promise<number | null> {
  let next: number | null = null;
  if (!input.paused) {
    const armed = await armedDeployment(db, input.serviceId, input.environmentId);
    next = armed ? nextCronSlot(armed.cron, input.now) : null;
  }
  const at = new Date(input.now);
  await db
    .insert(cronStates)
    .values({
      serviceId: input.serviceId,
      environmentId: input.environmentId,
      paused: input.paused,
      nextRunAt: next === null ? null : new Date(next),
      createdAt: at,
      updatedAt: at,
    })
    .onConflictDoUpdate({
      target: [cronStates.serviceId, cronStates.environmentId],
      set: {
        paused: input.paused,
        nextRunAt: next === null ? null : new Date(next),
        updatedAt: at,
      },
    });
  return next;
}

/** How one due state splits into runs. */
export interface SlotPlan {
  /** The slot to run, when the latest is within the starting deadline. */
  run: number | null;
  /** Slots recorded as missed, oldest first. */
  missed: number[];
  /** The latest slot listed (claimed as `last_scheduled_for`). */
  latest: number | null;
  /** The first slot after now. */
  next: number | null;
}

/**
 * Splits the slots from `seen` (inclusive) up to `now` per the ADR: the
 * latest runs if it is at most `starting_deadline_s` old, every other one
 * is missed.
 *
 * @param cron - The armed config.
 * @param seen - The state's `next_run_at`, unix ms.
 * @param now - The tick's time, unix ms.
 * @returns The plan.
 */
export function planSlots(cron: CronConfig, seen: number, now: number): SlotPlan {
  let slots: number[];
  try {
    slots = nextRuns(cron.schedule, cron.timezone, seen - 1, MAX_LISTED_SLOTS).filter(
      (t) => t <= now,
    );
  } catch {
    return { run: null, missed: [], latest: null, next: null };
  }
  const latest = slots.length ? slots[slots.length - 1]! : null;
  const runs = latest !== null && now - latest <= cron.starting_deadline_s * 1000;
  return {
    run: runs ? latest : null,
    missed: runs ? slots.slice(0, -1) : slots,
    latest,
    next: nextCronSlot(cron, now),
  };
}

function describeMissed(missed: readonly number[]): string {
  const first = new Date(missed[0]!).toISOString();
  const last = new Date(missed[missed.length - 1]!).toISOString();
  return missed.length === 1
    ? `1 run missed at ${first}`
    : `${missed.length} runs missed between ${first} and ${last}`;
}

/**
 * Minute-tick claimer for due cron states.
 *
 * @param env - Worker bindings.
 * @param now - The tick's scheduled time, unix ms.
 * @returns Runs queued this tick plus `queued` runs whose workflow was started again.
 */
export async function claimDueCronRuns(env: Env, now: number): Promise<number> {
  const db = createDb(env.DB);
  const due = await db
    .select({ state: cronStates, projectId: services.projectId })
    .from(cronStates)
    .innerJoin(services, eq(services.id, cronStates.serviceId))
    .where(
      and(
        eq(cronStates.paused, false),
        isNotNull(cronStates.nextRunAt),
        lte(cronStates.nextRunAt, new Date(now)),
        isNull(services.deletedAt),
      ),
    )
    .orderBy(asc(cronStates.nextRunAt))
    .limit(CRON_CLAIM_BATCH);
  let queued = 0;
  for (const { state, projectId } of due) {
    try {
      if (await claimState(env, db, state, projectId, now)) queued++;
    } catch (err) {
      console.error("cron claim failed", err instanceof Error ? err.message : "error");
    }
  }
  return queued + (await requeueStalled(env, db, now));
}

async function claimState(
  env: Env,
  db: Db,
  state: typeof cronStates.$inferSelect,
  projectId: string,
  now: number,
): Promise<boolean> {
  const seen = state.nextRunAt!;
  const owner = and(
    eq(cronStates.serviceId, state.serviceId),
    eq(cronStates.environmentId, state.environmentId),
    eq(cronStates.nextRunAt, seen),
    eq(cronStates.paused, false),
  );
  const armed = await armedDeployment(db, state.serviceId, state.environmentId);
  if (!armed) {
    await db
      .update(cronStates)
      .set({ nextRunAt: null, updatedAt: new Date(now) })
      .where(owner);
    return false;
  }
  const plan = planSlots(armed.cron, +seen, now);
  const claimed = await db
    .update(cronStates)
    .set({
      nextRunAt: plan.next === null ? null : new Date(plan.next),
      ...(plan.latest !== null ? { lastScheduledFor: new Date(plan.latest) } : {}),
      updatedAt: new Date(now),
    })
    .where(owner)
    .returning({ serviceId: cronStates.serviceId });
  if (!claimed.length) return false;

  const base = {
    serviceId: state.serviceId,
    environmentId: state.environmentId,
    deploymentId: armed.deployment.id,
    trigger: "schedule" as const,
    attempt: 1,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
  const rows: (typeof cronRuns.$inferInsert)[] = [];
  if (plan.missed.length) {
    const first = plan.missed[0]!;
    rows.push({
      ...base,
      id: await cronRunId({ ...base, scheduledFor: first, kind: "missed" }),
      scheduledFor: new Date(first),
      status: "missed",
      missedCount: plan.missed.length,
      error: describeMissed(plan.missed),
      finishedAt: new Date(now),
    });
  }
  let runId: string | null = null;
  if (plan.run !== null) {
    runId = await cronRunId({ ...base, scheduledFor: plan.run, kind: "run" });
    rows.push({
      ...base,
      id: runId,
      scheduledFor: new Date(plan.run),
      status: "queued",
      workflowInstanceId: runId,
    });
  }
  if (!rows.length) return false;
  const inserted = await db.insert(cronRuns).values(rows).onConflictDoNothing().returning();
  await publishCronRuns(env, projectId, inserted as CronRunRow[]);
  if (runId === null) return false;
  try {
    await startCronRunWorkflow(env, { runId });
  } catch (err) {
    // The sweep below starts it on a later tick.
    console.error("cron run failed to start", err instanceof Error ? err.name : "error");
  }
  return true;
}

async function requeueStalled(env: Env, db: Db, now: number): Promise<number> {
  const stalled = await db
    .select({ id: cronRuns.id })
    .from(cronRuns)
    .where(
      and(
        eq(cronRuns.status, "queued"),
        lt(cronRuns.createdAt, new Date(now - CRON_REQUEUE_AFTER_MS)),
        gt(cronRuns.createdAt, new Date(now - REQUEUE_HORIZON_MS)),
      ),
    )
    .limit(REQUEUE_BATCH);
  let n = 0;
  for (const r of stalled) {
    try {
      await startCronRunWorkflow(env, { runId: r.id });
      n++;
    } catch {
      // Tried again next tick.
    }
  }
  return n;
}
