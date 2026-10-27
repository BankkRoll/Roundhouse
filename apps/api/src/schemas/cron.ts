/**
 * Cron service shapes (ADR 0010): the `cron` part of a service config and a
 * run as the API returns it. The schedule and zone are only checked for
 * shape here; `mergeConfig` and the preview route parse them, so a bad
 * schedule is a 422 `invalid_schedule` with the offending span.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import {
  CRON_CONCURRENCY_POLICIES,
  CRON_LIMITS,
  CRON_RUN_STATUSES,
  CRON_RUN_TRIGGERS,
  type CronConfig,
  MAX_SCHEDULE_LENGTH,
} from "@roundhouse/shared";

const Millis = z.number().int().openapi({ description: "Unix milliseconds" });

const bounded = (k: keyof typeof CRON_LIMITS) =>
  z.number().int().min(CRON_LIMITS[k].min).max(CRON_LIMITS[k].max);

/** The fields of {@link CronConfigSchema}, for partial patches. */
export const CronConfigFields = z.object({
  schedule: z.string().trim().min(1).max(MAX_SCHEDULE_LENGTH).openapi({
    description: "Five-field cron expression or macro (`@daily`), read in `timezone`.",
    example: "0 3 * * *",
  }),
  timezone: z
    .string()
    .min(1)
    .max(64)
    .openapi({ description: "IANA time zone", example: "Europe/Berlin" }),
  concurrency: z.enum(CRON_CONCURRENCY_POLICIES).openapi({
    description:
      "When a slot comes while the previous run still runs: `forbid` skips it, `replace` " +
      "cancels the running one, `allow` runs both.",
  }),
  timeout_s: bounded("timeout_s"),
  starting_deadline_s: bounded("starting_deadline_s").openapi({
    description: "How late a run may still start; later slots are recorded as missed.",
  }),
  retries: bounded("retries"),
  retry_backoff_s: bounded("retry_backoff_s").openapi({
    description: "Wait before the first retry, doubled per further retry.",
  }),
  history_limit: bounded("history_limit"),
});

/** Schedule and run rules of a cron service. */
export const CronConfigSchema = CronConfigFields.openapi(
  "CronConfig",
) satisfies z.ZodType<CronConfig>;

/** A run of a cron service, or a record of missed slots. */
export const CronRunSchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
    service_id: z.string(),
    environment_id: z.string(),
    deployment_id: z.string().nullable(),
    trigger: z.enum(CRON_RUN_TRIGGERS),
    /** The slot; for a manual run, when it was requested. */
    scheduled_for: Millis,
    attempt: z.number().int(),
    status: z.enum(CRON_RUN_STATUSES),
    node_id: z.string().nullable(),
    exit_code: z.number().int().nullable(),
    /** For `missed`: how many slots this record covers. */
    missed_count: z.number().int().nullable(),
    error: z.string().nullable(),
    triggered_by: z.string().nullable(),
    started_at: Millis.nullable(),
    finished_at: Millis.nullable(),
    created_at: Millis,
    updated_at: Millis,
  })
  .openapi("CronRun");

/** A run as the API returns it. */
export type ApiCronRun = z.infer<typeof CronRunSchema>;

/** `cron_run.updated`: a run was created or changed. Sent to every socket of the project. */
export const CronRunUpdatedMessageSchema = z.object({
  type: z.literal("cron_run.updated"),
  run: CronRunSchema,
});
