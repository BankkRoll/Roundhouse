/**
 * Run-to-completion jobs (ADR 0010): cron runs and `pre_deploy` commands,
 * from `JOBS_PROTOCOL_VERSION`. The control plane owns schedules,
 * concurrency (`forbid`/`replace`/`allow`), retries and history; the agent
 * only starts, times out, cancels and reports one container per run.
 * Mirrored by `go/jobs.go`.
 *
 * @module
 */
import { z } from "zod";
import { ControlHeader, isShortLived, SHORT_LIVED_ISSUE } from "./control";
import {
  boundedString,
  IdString,
  MAX_JOB_TIMEOUT_S,
  MAX_MESSAGE_BYTES,
  MIN_JOB_TIMEOUT_S,
  UnixMillis,
} from "./limits";
import { WorkloadSpecSchema } from "./workload";

/**
 * Starts one run. `workload` is a `job` workload (no ports, routes, probe or
 * mounts; restart `never`), with its environment sealed under `jobEnvAad`.
 * Always credential-bearing, since the environment is a sealed box.
 */
export const JobRunSchema = z
  .object({
    type: z.literal("job_run"),
    ...ControlHeader,
    run_id: IdString,
    workload: WorkloadSpecSchema.refine((w) => w.kind === "job", {
      message: "job_run carries a job workload",
      path: ["kind"],
    }),
    /** SIGTERM at this many seconds after start, then SIGKILL after `kill_grace_s`. */
    timeout_s: z.number().int().min(MIN_JOB_TIMEOUT_S).max(MAX_JOB_TIMEOUT_S),
    kill_grace_s: z.number().int().min(1).max(120),
  })
  .refine(isShortLived, SHORT_LIVED_ISSUE);

/** Starts one run. */
export type JobRun = z.infer<typeof JobRunSchema>;

/**
 * Stops a run (SIGTERM, `kill_grace_s`, SIGKILL); answered by a `cancelled`
 * `job_status`. A cancel for a finished or unknown run is ignored.
 */
export const JobCancelSchema = z.object({
  type: z.literal("job_cancel"),
  ...ControlHeader,
  run_id: IdString,
  /** Shown in the run's system log, e.g. `replaced by crn_…`. */
  reason: boundedString(256),
});

/** Stops a run. */
export type JobCancel = z.infer<typeof JobCancelSchema>;

/**
 * A run's lifecycle. `succeeded` (exit 0), `failed` (non-zero exit, start
 * failure, or `node_busy`), `timed_out` and `cancelled` are terminal.
 */
export const JOB_STATES = [
  "pulling",
  "running",
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
] as const;

/** A run's state; see {@link JOB_STATES}. */
export type JobState = (typeof JOB_STATES)[number];

/** Terminal {@link JOB_STATES}. */
export const TERMINAL_JOB_STATES = ["succeeded", "failed", "timed_out", "cancelled"] as const;

/**
 * A run's state change. Re-sent after an agent restart for runs the agent
 * re-attached to or found finished.
 */
export const JobStatusSchema = z
  .object({
    type: z.literal("job_status"),
    run_id: IdString,
    workload_id: IdString,
    state: z.enum(JOB_STATES),
    /** The container's exit code, once it exited. */
    exit_code: z.number().int().min(-1).max(255).optional(),
    started_at: UnixMillis.optional(),
    /** Present exactly in terminal states. */
    finished_at: UnixMillis.optional(),
    /** E.g. a pull error, or `node_busy`. */
    message: boundedString(MAX_MESSAGE_BYTES).optional(),
  })
  .refine(
    (s) =>
      (TERMINAL_JOB_STATES as readonly string[]).includes(s.state) ===
      (s.finished_at !== undefined),
    { message: "finished_at is required exactly in terminal states", path: ["finished_at"] },
  )
  .refine((s) => s.state !== "succeeded" || s.exit_code === 0, {
    message: "a succeeded run exited 0",
    path: ["exit_code"],
  });

/** A run's state change. */
export type JobStatus = z.infer<typeof JobStatusSchema>;
