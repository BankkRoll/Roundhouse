/**
 * Cron services (ADR 0010): the `cron` part of a service config, the run
 * vocabulary stored in `cron_runs`, and the retry and history rules the
 * control plane applies. Schedules themselves live in `./cron`.
 *
 * @module
 */
import { DEFAULT_CRON_TIMEZONE } from "./cron";

/**
 * What happens when a slot comes up while the previous run is still going:
 * - `forbid`: the new run is recorded as `skipped`;
 * - `replace`: the running one is cancelled, then the new one starts;
 * - `allow`: both run.
 */
export const CRON_CONCURRENCY_POLICIES = ["forbid", "replace", "allow"] as const;

/** A concurrency policy; see {@link CRON_CONCURRENCY_POLICIES}. */
export type CronConcurrencyPolicy = (typeof CRON_CONCURRENCY_POLICIES)[number];

/** Bounds of each {@link CronConfig} number, inclusive. */
export const CRON_LIMITS = {
  timeout_s: { min: 10, max: 86_400 },
  starting_deadline_s: { min: 0, max: 3600 },
  retries: { min: 0, max: 5 },
  retry_backoff_s: { min: 10, max: 3600 },
  history_limit: { min: 10, max: 1000 },
} as const;

/** The `cron` part of a cron service's config. */
export interface CronConfig {
  /** Five-field expression or macro, read in {@link CronConfig.timezone}. */
  schedule: string;
  /** IANA zone the schedule is read in. */
  timezone: string;
  concurrency: CronConcurrencyPolicy;
  /** Hard limit per run; the agent stops the container after it. */
  timeout_s: number;
  /** How late a run may still start after its slot; later slots are recorded as missed. */
  starting_deadline_s: number;
  /** Extra attempts after a failed, timed-out or lost run. */
  retries: number;
  /** Wait before the first retry, doubled for each further one. */
  retry_backoff_s: number;
  /** Runs kept in history per service and environment. */
  history_limit: number;
}

/** Every {@link CronConfig} field but the schedule, as a new cron service starts. */
export const DEFAULT_CRON_CONFIG: Omit<CronConfig, "schedule"> = {
  timezone: DEFAULT_CRON_TIMEZONE,
  concurrency: "forbid",
  timeout_s: 3600,
  starting_deadline_s: 300,
  retries: 0,
  retry_backoff_s: 60,
  history_limit: 100,
};

/** What started a run. `pre_deploy` is reserved for `DeployConfig.pre_deploy_command`. */
export const CRON_RUN_TRIGGERS = ["schedule", "manual", "retry", "pre_deploy"] as const;

/** What started a run; see {@link CRON_RUN_TRIGGERS}. */
export type CronRunTrigger = (typeof CRON_RUN_TRIGGERS)[number];

/**
 * A run's lifecycle: `queued → starting → running`, ending `succeeded`,
 * `failed`, `timed_out` or `cancelled`. `skipped` (concurrency `forbid`),
 * `missed` (slots that could not run in time; one record covers many) and
 * `lost` (no terminal report before the deadline) never ran to an end.
 */
export const CRON_RUN_STATUSES = [
  "queued",
  "starting",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "skipped",
  "missed",
  "lost",
] as const;

/** A run's status; see {@link CRON_RUN_STATUSES}. */
export type CronRunStatus = (typeof CRON_RUN_STATUSES)[number];

/** Statuses of a run that holds (or is about to hold) a container. */
export const ACTIVE_CRON_RUN_STATUSES = [
  "queued",
  "starting",
  "running",
] as const satisfies readonly CronRunStatus[];

/** Statuses of a run whose container is placed on a node. */
export const PLACED_CRON_RUN_STATUSES = [
  "starting",
  "running",
] as const satisfies readonly CronRunStatus[];

/** Outcomes a retry follows. `cancelled` and `skipped` are never retried. */
export const RETRYABLE_CRON_RUN_STATUSES = [
  "failed",
  "timed_out",
  "lost",
] as const satisfies readonly CronRunStatus[];

/**
 * Whether a run has ended.
 *
 * @param status - A run status.
 * @returns `false` for `queued`, `starting` and `running`.
 */
export function isTerminalCronRunStatus(status: CronRunStatus): boolean {
  return !(ACTIVE_CRON_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * Seconds to wait before an attempt: none for the first, then
 * `retry_backoff_s` doubled per earlier retry, capped at a day.
 *
 * @param config - The run's cron config.
 * @param attempt - 1 for the first attempt.
 * @returns Seconds.
 * @example
 * retryDelayS({ retry_backoff_s: 60 }, 3); // 120
 */
export function retryDelayS(config: Pick<CronConfig, "retry_backoff_s">, attempt: number): number {
  if (attempt <= 1) return 0;
  return Math.min(config.retry_backoff_s * 2 ** (attempt - 2), 86_400);
}
