/**
 * Cron service routes (ADR 0010, "Routes, RBAC, audit"): schedule preview,
 * a service's schedule state, its runs (list, inspect, logs), run now,
 * cancel, pause and resume.
 *
 * Deviations from the ADR's table:
 * - The preview lives under a project (`/v1/projects/{projectId}/cron/preview`)
 *   so `projects:read` has a project to be checked against.
 * - `GET /v1/services/{serviceId}/cron` (not in the ADR) returns the
 *   schedule state the dashboard and CLI show: paused, next slot, armed
 *   deployment.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { CRON_RUN_STATUSES, MAX_SCHEDULE_LENGTH } from "@roundhouse/shared";
import {
  body,
  CursorField,
  errors,
  json,
  LimitField,
  LogPageSchema,
  Millis,
  sessionAuth,
} from "../schemas";
import { CronRunSchema } from "../schemas/cron";
import { EnvironmentQuery, LogQuery, ProjectParams, ServiceParams } from "./params";
import { defineRoute, session } from "./policy";

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

/** `{runId}` path param. */
export const CronRunParams = z.object({ runId: z.string() });

/** Query of the schedule preview. */
export const CronPreviewQuery = z.object({
  schedule: z.string().min(1).max(MAX_SCHEDULE_LENGTH),
  timezone: z.string().min(1).max(64).default("UTC"),
  count: z.coerce.number().int().min(1).max(10).default(5),
});

/** Where a schedule or zone stopped parsing. */
export const ScheduleErrorSchema = z
  .object({
    code: z.enum(["invalid_schedule", "invalid_timezone"]),
    message: z.string(),
    /** Offset of the first offending character of `schedule` (or `timezone`). */
    start: z.number().int(),
    end: z.number().int(),
  })
  .openapi("ScheduleError");

/** The next slots of a schedule, or why it doesn't parse. */
export const CronPreviewSchema = z
  .object({
    valid: z.boolean(),
    next_runs: z.array(Millis),
    error: ScheduleErrorSchema.nullable(),
  })
  .openapi("CronPreview");

/** A cron service's schedule state in one environment. */
export const CronStateSchema = z
  .object({
    service_id: z.string(),
    environment_id: z.string(),
    paused: z.boolean(),
    /** `null` while paused, before the first deploy, or when the schedule never fires. */
    next_run_at: Millis.nullable(),
    last_scheduled_for: Millis.nullable(),
    /** The deployment runs use, `null` until the service is deployed. */
    armed_deployment_id: z.string().nullable(),
    /** The armed deployment's schedule and zone. */
    schedule: z.string().nullable(),
    timezone: z.string().nullable(),
    /** The next few slots, for display; empty while paused or unarmed. */
    next_runs: z.array(Millis),
  })
  .openapi("CronState");

/** A page of runs, newest slot first. */
export const CronRunPageSchema = z
  .object({ runs: z.array(CronRunSchema), next_cursor: z.string().nullable() })
  .openapi("CronRunPage");

/** Query of the runs list. */
export const CronRunListQuery = EnvironmentQuery.extend({
  cursor: CursorField,
  limit: LimitField,
  status: z.enum(CRON_RUN_STATUSES).optional(),
});

/** Body of `POST /v1/services/{serviceId}/cron-runs`. */
export const TriggerCronRunBody = z
  .object({
    environment_id: z.string(),
    /** Cancel runs in progress first (`replace`); without it a run in progress is a 409. */
    force: z.boolean().optional(),
  })
  .openapi("TriggerCronRun");

/** Body of the pause and resume routes. */
export const CronEnvironmentBody = z
  .object({ environment_id: z.string() })
  .openapi("CronEnvironment");

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

/** The next `count` slots of a schedule in a zone, or the parse error with its position. */
export const previewCronSchedule = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/projects/{projectId}/cron/preview",
  tags: ["cron"],
  summary: "Preview a cron schedule",
  security: sessionAuth,
  request: { params: ProjectParams, query: CronPreviewQuery },
  responses: { 200: json(CronPreviewSchema), ...errors(400, 401, 403, 404) },
});

/** A cron service's schedule state in an environment. */
export const getCronState = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/services/{serviceId}/cron",
  tags: ["cron"],
  summary: "Get a cron service's schedule state",
  security: sessionAuth,
  request: { params: ServiceParams, query: EnvironmentQuery },
  responses: { 200: json(CronStateSchema), ...errors(400, 401, 403, 404, 409) },
});

/** A cron service's runs in an environment, newest slot first. */
export const listCronRuns = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/services/{serviceId}/cron-runs",
  tags: ["cron"],
  summary: "List cron runs",
  security: sessionAuth,
  request: { params: ServiceParams, query: CronRunListQuery },
  responses: { 200: json(CronRunPageSchema), ...errors(400, 401, 403, 404) },
});

/**
 * Runs the armed deployment now. A run in progress is a 409
 * `run_in_progress` unless `force`, which cancels it first; the concurrency
 * policy's `forbid` doesn't apply to a manual run.
 */
export const triggerCronRun = defineRoute(session("deployments:create", ["cron.run_triggered"]), {
  method: "post",
  path: "/v1/services/{serviceId}/cron-runs",
  tags: ["cron"],
  summary: "Run a cron service now",
  security: sessionAuth,
  request: { params: ServiceParams, ...body(TriggerCronRunBody) },
  responses: { 201: json(CronRunSchema), ...errors(400, 401, 403, 404, 409) },
});

/** One run. */
export const getCronRun = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/cron-runs/{runId}",
  tags: ["cron"],
  summary: "Get a cron run",
  security: sessionAuth,
  request: { params: CronRunParams },
  responses: { 200: json(CronRunSchema), ...errors(401, 403, 404) },
});

/** A run's output, paged backwards from the newest line. */
export const getCronRunLogs = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/cron-runs/{runId}/logs",
  tags: ["cron", "logs"],
  summary: "Get cron run logs",
  security: sessionAuth,
  request: { params: CronRunParams, query: LogQuery },
  responses: { 200: json(LogPageSchema), ...errors(400, 401, 403, 404) },
});

/**
 * Stops a run: a queued one at once; a running one through its node, whose
 * `cancelled` report follows. 409 for a run that already ended.
 */
export const cancelCronRun = defineRoute(session("deployments:create", ["cron.run_cancelled"]), {
  method: "post",
  path: "/v1/cron-runs/{runId}/cancel",
  tags: ["cron"],
  summary: "Cancel a cron run",
  security: sessionAuth,
  request: { params: CronRunParams },
  responses: { 200: json(CronRunSchema), ...errors(401, 403, 404, 409) },
});

/** Stops scheduling runs (no runs, no missed records) until resumed. */
export const pauseCron = defineRoute(session("services:manage", ["cron.paused"]), {
  method: "post",
  path: "/v1/services/{serviceId}/cron/pause",
  tags: ["cron"],
  summary: "Pause a cron service",
  security: sessionAuth,
  request: { params: ServiceParams, ...body(CronEnvironmentBody) },
  responses: { 200: json(CronStateSchema), ...errors(400, 401, 403, 404, 409) },
});

/** Resumes scheduling from the next future slot. */
export const resumeCron = defineRoute(session("services:manage", ["cron.resumed"]), {
  method: "post",
  path: "/v1/services/{serviceId}/cron/resume",
  tags: ["cron"],
  summary: "Resume a cron service",
  security: sessionAuth,
  request: { params: ServiceParams, ...body(CronEnvironmentBody) },
  responses: { 200: json(CronStateSchema), ...errors(400, 401, 403, 404, 409) },
});

/** Every cron route, for the contract tests. */
export const CRON_ROUTES = {
  previewCronSchedule,
  getCronState,
  listCronRuns,
  triggerCronRun,
  getCronRun,
  getCronRunLogs,
  cancelCronRun,
  pauseCron,
  resumeCron,
} as const;

/** A cron service's schedule state. */
export type CronState = z.infer<typeof CronStateSchema>;
