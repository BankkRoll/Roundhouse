/**
 * Cron services (ADR 0010): each service and environment's schedule state,
 * claimed by the minute tick, and the history of its runs.
 *
 * Nothing here holds a secret: a run uses its deployment's sealed
 * environment, sealed again to the node for one `job_run` frame.
 *
 * @module
 */
import type { CronRunStatus, CronRunTrigger } from "@roundhouse/shared";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { id, timestamp, timestamps } from "./columns";
import { deployments } from "./deployments";
import { nodes } from "./nodes";
import { environments, services } from "./projects";

/**
 * When a cron service runs next in one environment. The minute tick claims a
 * due row with a conditional update on `next_run_at`, so a slot is taken
 * exactly once however many ticks overlap.
 */
export const cronStates = sqliteTable(
  "cron_states",
  {
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),
    /** `null` while paused or without an armed deployment. */
    nextRunAt: timestamp("next_run_at"),
    /** The latest slot a tick claimed; slots after it are the next to list. */
    lastScheduledFor: timestamp("last_scheduled_for"),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.serviceId, t.environmentId] }),
    index("cron_states_next_idx").on(t.nextRunAt).where(sql`next_run_at IS NOT NULL`),
  ],
);

/** One run of a cron service, or a record of slots that were missed. */
export const cronRuns = sqliteTable(
  "cron_runs",
  {
    /** `crn_…`; scheduled and retry runs derive it from their slot (see the API's `cronRunId`). */
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** The armed deployment whose image, config and environment the run uses. */
    deploymentId: text("deployment_id").references((): AnySQLiteColumn => deployments.id, {
      onDelete: "set null",
    }),
    trigger: text("trigger").$type<CronRunTrigger>().notNull(),
    /** The slot (a manual run: when it was requested). */
    scheduledFor: timestamp("scheduled_for").notNull(),
    attempt: integer("attempt").notNull().default(1),
    status: text("status").$type<CronRunStatus>().notNull(),
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "set null" }),
    /** `wl_…` of the job container. */
    workloadId: text("workload_id"),
    exitCode: integer("exit_code"),
    /** For `missed`: how many slots this record covers. */
    missedCount: integer("missed_count"),
    error: text("error"),
    workflowInstanceId: text("workflow_instance_id"),
    /** Who asked for a manual run. */
    triggeredBy: text("triggered_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("cron_runs_slot_uq")
      .on(t.serviceId, t.environmentId, t.scheduledFor, t.attempt)
      .where(sql`"trigger" IN ('schedule', 'retry')`),
    index("cron_runs_svc_env_id_idx").on(t.serviceId, t.environmentId, t.id),
    index("cron_runs_status_idx").on(t.status),
  ],
);
