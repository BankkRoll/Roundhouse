/**
 * MSW handlers for the cron routes (`CRON_ROUTES` in `apps/api/src/contracts/cron.ts`)
 * against the in-memory {@link db}. `contract.test.ts` validates every response against
 * the API's schemas.
 *
 * Requests are validated with the routes' own zod schemas first (400), then the API's
 * order: 401 without a session, 404 for a missing row or a non-member, 403 when the role
 * lacks the route's action, then 409 for a service that isn't a cron job, a run that
 * already ended, or a run in progress. Every created or changed run is sent to the
 * project's sockets as `cron_run.updated`.
 *
 * There is no scheduler or agent: runs only change through these routes (run now,
 * cancel), or when a test edits `db.cron` and pushes the frame itself.
 *
 * @module
 */
import {
  type Action,
  isTerminalCronRunStatus,
  nextRuns,
  PLACED_CRON_RUN_STATUSES,
  scheduleError,
} from "@roundhouse/shared";
import { HttpResponse, http } from "msw";
import { CRON_ROUTES, type CronState, policyOf } from "../../../api/src/contracts";
import type { CronRun } from "../lib/api/cron-client";
import type { Environment, Project, Service } from "../lib/api/deploy-types";
import { protectionRefusal } from "./access-resolve";
import {
  apiError,
  currentUser,
  type Guard,
  invalid,
  notFound,
  recordAudit,
  requireWorkspace,
  unauthorized,
} from "./common";
import type { DbCronState } from "./cron-db";
import { db } from "./db";
import { broadcastRealtime } from "./deploy-handlers";

type RouteName = keyof typeof CRON_ROUTES;

// -----------------------------------------------------------------------------
// Validation with the contract's schemas
// -----------------------------------------------------------------------------

interface ZodIssue {
  path: PropertyKey[];
  message: string;
}

interface Schema {
  safeParse(
    value: unknown,
  ): { success: true; data: unknown } | { success: false; error: { issues: ZodIssue[] } };
}

interface RouteRequest {
  params?: Schema;
  query?: Schema;
  body?: { content: { "application/json": { schema: Schema } } };
}

type Validated<B> =
  | { ok: true; params: Record<string, string>; query: Record<string, unknown>; body: B }
  | { ok: false; response: Response };

function issueResponse(issues: ZodIssue[]): Response {
  const issue = issues[0];
  const where = issue?.path.length ? `${issue.path.map(String).join(".")}: ` : "";
  return invalid(`${where}${issue?.message ?? "invalid"}`);
}

/** Validates params, query, then the JSON body, as `@hono/zod-openapi` does. */
async function validate<B = Record<string, never>>(
  name: RouteName,
  request: Request,
  params: Record<string, string | readonly string[] | undefined>,
): Promise<Validated<B>> {
  const spec = (CRON_ROUTES[name] as { request?: RouteRequest }).request ?? {};
  const parsed: unknown[] = [];
  for (const [schema, value] of [
    [spec.params, params],
    [spec.query, Object.fromEntries(new URL(request.url).searchParams)],
  ] as const) {
    if (!schema) {
      parsed.push(value);
      continue;
    }
    const result = schema.safeParse(value);
    if (!result.success) return { ok: false, response: issueResponse(result.error.issues) };
    parsed.push(result.data);
  }
  let body: unknown = {};
  const bodySchema = spec.body?.content["application/json"].schema;
  if (bodySchema) {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return { ok: false, response: invalid("Malformed JSON in request body") };
    }
    const result = bodySchema.safeParse(raw);
    if (!result.success) return { ok: false, response: issueResponse(result.error.issues) };
    body = result.data;
  }
  return {
    ok: true,
    params: parsed[0] as Record<string, string>,
    query: parsed[1] as Record<string, unknown>,
    body: body as B,
  };
}

const actionOf = (name: RouteName) => policyOf(CRON_ROUTES[name]).action as Action;

function mswPath(name: RouteName): string {
  return `*${CRON_ROUTES[name].path.replace(/\{([^}]+)\}/g, ":$1")}`;
}

const conflict = (message: string) => apiError(409, "conflict", message);

// -----------------------------------------------------------------------------
// Access
// -----------------------------------------------------------------------------

type Granted<T> =
  | ({ ok: true; guard: Extract<Guard, { ok: true }> } & T)
  | { ok: false; response: Response };

function liveProject(projectId: string): Project | undefined {
  return db.deploy.projects.find((row) => row.id === projectId && !row.deleted);
}

/** Resolves the owning workspace and checks the caller, in the API's order. */
function grant(project: Project | undefined, what: string, action: Action): Granted<object> {
  if (!currentUser()) return { ok: false, response: unauthorized() };
  if (!project) return { ok: false, response: notFound(what) };
  const guard = requireWorkspace(project.workspace_id, action);
  // NOTE: Non-members get the same 404 as a missing row, so ids can't be probed.
  if (!guard.ok) {
    return { ok: false, response: guard.response.status === 404 ? notFound(what) : guard.response };
  }
  return { ok: true, guard };
}

function serviceAccess(
  serviceId: string,
  action: Action,
  environmentId: unknown,
  what = "Service",
): Granted<{ service: Service; project: Project; environment: Environment }> {
  const service = db.deploy.services.find((row) => row.id === serviceId && !row.deleted);
  const project = service ? liveProject(service.project_id) : undefined;
  const granted = grant(project, what, action);
  if (!granted.ok) return granted;
  const environment = db.deploy.environments.find(
    (row) => row.id === environmentId && row.project_id === project!.id,
  );
  if (!environment) return { ok: false, response: notFound("Environment") };
  // Run now and cancel follow the environment's deploy rule, pause and resume its config rule.
  const refused = protectionRefusal(
    project!.workspace_id,
    granted.guard.user.id,
    environment.id,
    action,
  );
  if (refused) return { ok: false, response: refused };
  return { ...granted, service: service!, project: project!, environment };
}

/** {@link serviceAccess}, then 409 for a service that isn't a cron job. */
function cronAccess(serviceId: string, action: Action, environmentId: unknown) {
  const found = serviceAccess(serviceId, action, environmentId);
  if (found.ok && found.service.kind !== "cron") {
    return { ok: false as const, response: conflict("The service is not a cron service") };
  }
  return found;
}

function runAccess(runId: string, action: Action) {
  const run = db.cron.runs.find((row) => row.id === runId);
  if (!run) {
    if (!currentUser()) return { ok: false as const, response: unauthorized() };
    return { ok: false as const, response: notFound("Cron run") };
  }
  const found = serviceAccess(run.service_id, action, run.environment_id, "Cron run");
  return found.ok ? { ...found, run } : found;
}

// -----------------------------------------------------------------------------
// State and runs
// -----------------------------------------------------------------------------

const STATE_PREVIEW_COUNT = 5;

/** The latest active deployment whose config carries a schedule, as the API arms it. */
function armed(serviceId: string, environmentId: string) {
  const deployment = db.deploy.deployments
    .filter(
      (row) =>
        row.service_id === serviceId &&
        row.environment_id === environmentId &&
        row.status === "active",
    )
    .sort((a, b) => b.created_at - a.created_at)[0];
  const config = deployment
    ? db.deploy.configs.find(
        (row) =>
          row.service_id === serviceId &&
          row.environment_id === environmentId &&
          row.version === deployment.config_version,
      )
    : undefined;
  return deployment && config?.cron ? { deployment, cron: config.cron } : null;
}

function stateRow(serviceId: string, environmentId: string): DbCronState {
  let row = db.cron.states.find(
    (entry) => entry.service_id === serviceId && entry.environment_id === environmentId,
  );
  if (!row) {
    row = {
      service_id: serviceId,
      environment_id: environmentId,
      paused: false,
      last_scheduled_for: null,
    };
    db.cron.states.push(row);
  }
  return row;
}

function cronState(serviceId: string, environmentId: string): CronState {
  const row = db.cron.states.find(
    (entry) => entry.service_id === serviceId && entry.environment_id === environmentId,
  );
  const arm = armed(serviceId, environmentId);
  const paused = row?.paused ?? false;
  const upcoming =
    arm && !paused
      ? nextRuns(arm.cron.schedule, arm.cron.timezone, Date.now(), STATE_PREVIEW_COUNT)
      : [];
  return {
    service_id: serviceId,
    environment_id: environmentId,
    paused,
    next_run_at: upcoming[0] ?? null,
    last_scheduled_for: row?.last_scheduled_for ?? null,
    armed_deployment_id: arm?.deployment.id ?? null,
    schedule: arm?.cron.schedule ?? null,
    timezone: arm?.cron.timezone ?? null,
    next_runs: upcoming,
  };
}

function nextRunId(): string {
  db.cron.sequence += 1;
  // NOTE: "z" sorts after the seeded ids, so new runs list first as ULIDs would.
  return `crn_z${String(db.cron.sequence).padStart(6, "0")}`;
}

/** Saves a changed run and sends it to the project's sockets. */
function publish(run: CronRun): CronRun {
  const index = db.cron.runs.findIndex((row) => row.id === run.id);
  if (index === -1) db.cron.runs.push(run);
  else db.cron.runs[index] = run;
  broadcastRealtime(run.project_id, { type: "cron_run.updated", run });
  return run;
}

function cancelled(run: CronRun, by: string): CronRun {
  const now = Date.now();
  return {
    ...run,
    status: "cancelled",
    error: `cancelled by ${by}`,
    finished_at: now,
    updated_at: Math.max(now, run.updated_at + 1),
  };
}

const RUN_CURSOR = /^crn_[0-9A-Za-z]{1,64}$/;

function logPage(runId: string, query: Record<string, unknown>) {
  const lines = db.cron.logs[runId] ?? [];
  const limit = Number(query.limit ?? 200);
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;
  const end = cursor ? Math.min(lines.length, Number(cursor.replace(/^o/, "")) || 0) : lines.length;
  const start = Math.max(0, end - limit);
  return { lines: lines.slice(start, end), next_cursor: start > 0 ? `o${start}` : null };
}

function audit(
  workspaceId: string,
  userId: string,
  action: Parameters<typeof recordAudit>[0]["action"],
  targetType: string,
  targetId: string,
  metadata: Record<string, unknown>,
) {
  recordAudit({
    workspaceId,
    actorType: "user",
    actorId: userId,
    action,
    targetType,
    targetId,
    metadata,
  });
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

/** Handlers for every cron route. */
export const cronHandlers = [
  http.get(mswPath("previewCronSchedule"), async ({ request, params }) => {
    const input = await validate("previewCronSchedule", request, params);
    if (!input.ok) return input.response;
    const granted = grant(
      liveProject(input.params.projectId ?? ""),
      "Project",
      actionOf("previewCronSchedule"),
    );
    if (!granted.ok) return granted.response;
    const schedule = String(input.query.schedule);
    const timezone = String(input.query.timezone);
    const error = scheduleError(schedule, timezone);
    return HttpResponse.json({
      valid: error === null,
      next_runs: error ? [] : nextRuns(schedule, timezone, Date.now(), Number(input.query.count)),
      error,
    });
  }),

  http.get(mswPath("getCronState"), async ({ request, params }) => {
    const input = await validate("getCronState", request, params);
    if (!input.ok) return input.response;
    const found = cronAccess(
      input.params.serviceId ?? "",
      actionOf("getCronState"),
      input.query.environment_id,
    );
    if (!found.ok) return found.response;
    return HttpResponse.json(cronState(found.service.id, found.environment.id));
  }),

  http.get(mswPath("listCronRuns"), async ({ request, params }) => {
    const input = await validate("listCronRuns", request, params);
    if (!input.ok) return input.response;
    const found = serviceAccess(
      input.params.serviceId ?? "",
      actionOf("listCronRuns"),
      input.query.environment_id,
    );
    if (!found.ok) return found.response;
    const cursor = input.query.cursor as string | undefined;
    if (cursor && !RUN_CURSOR.test(cursor)) return invalid("cursor: malformed");
    const status = input.query.status as CronRun["status"] | undefined;
    const limit = Number(input.query.limit);
    const rows = db.cron.runs
      .filter(
        (run) =>
          run.service_id === found.service.id &&
          run.environment_id === found.environment.id &&
          (!status || run.status === status) &&
          (!cursor || run.id < cursor),
      )
      .sort((a, b) => (a.id < b.id ? 1 : -1));
    const page = rows.slice(0, limit);
    return HttpResponse.json({
      runs: page,
      next_cursor: rows.length > limit ? page.at(-1)!.id : null,
    });
  }),

  http.post(mswPath("triggerCronRun"), async ({ request, params }) => {
    const input = await validate<{ environment_id: string; force?: boolean }>(
      "triggerCronRun",
      request,
      params,
    );
    if (!input.ok) return input.response;
    const found = cronAccess(
      input.params.serviceId ?? "",
      actionOf("triggerCronRun"),
      input.body.environment_id,
    );
    if (!found.ok) return found.response;
    const arm = armed(found.service.id, found.environment.id);
    if (!arm) return conflict("The cron service has no active deployment; deploy it first");
    const busy = db.cron.runs.filter(
      (run) =>
        run.service_id === found.service.id &&
        run.environment_id === found.environment.id &&
        (PLACED_CRON_RUN_STATUSES as readonly string[]).includes(run.status),
    );
    const force = input.body.force ?? false;
    if (busy.length > 0 && !force) {
      return apiError(
        409,
        "run_in_progress",
        `Run ${busy[0]!.id} is still in progress; pass force to cancel it first`,
      );
    }
    const user = found.guard.user;
    for (const run of busy) publish(cancelled(run, user.name || "a user"));
    const now = Date.now();
    const id = nextRunId();
    const run = publish({
      id,
      project_id: found.project.id,
      service_id: found.service.id,
      environment_id: found.environment.id,
      deployment_id: arm.deployment.id,
      trigger: "manual",
      scheduled_for: now,
      attempt: 1,
      status: "queued",
      node_id: null,
      exit_code: null,
      missed_count: null,
      error: null,
      triggered_by: user.id,
      started_at: null,
      finished_at: null,
      created_at: now,
      updated_at: now,
    });
    audit(found.project.workspace_id, user.id, "cron.run_triggered", "cron_run", id, {
      service_id: found.service.id,
      environment_id: found.environment.id,
      deployment_id: arm.deployment.id,
      force,
    });
    return HttpResponse.json(run, { status: 201 });
  }),

  http.get(mswPath("getCronRun"), async ({ request, params }) => {
    const input = await validate("getCronRun", request, params);
    if (!input.ok) return input.response;
    const found = runAccess(input.params.runId ?? "", actionOf("getCronRun"));
    if (!found.ok) return found.response;
    return HttpResponse.json(found.run);
  }),

  http.get(mswPath("getCronRunLogs"), async ({ request, params }) => {
    const input = await validate("getCronRunLogs", request, params);
    if (!input.ok) return input.response;
    const found = runAccess(input.params.runId ?? "", actionOf("getCronRunLogs"));
    if (!found.ok) return found.response;
    return HttpResponse.json(logPage(found.run.id, input.query));
  }),

  http.post(mswPath("cancelCronRun"), async ({ request, params }) => {
    const input = await validate("cancelCronRun", request, params);
    if (!input.ok) return input.response;
    const found = runAccess(input.params.runId ?? "", actionOf("cancelCronRun"));
    if (!found.ok) return found.response;
    if (isTerminalCronRunStatus(found.run.status)) {
      return conflict(`A ${found.run.status} run can't be cancelled`);
    }
    const user = found.guard.user;
    const run = publish(cancelled(found.run, user.name || "a user"));
    audit(found.project.workspace_id, user.id, "cron.run_cancelled", "cron_run", run.id, {
      service_id: run.service_id,
      environment_id: run.environment_id,
      from: found.run.status,
    });
    return HttpResponse.json(run);
  }),

  ...(["pauseCron", "resumeCron"] as const).map((name) =>
    http.post(mswPath(name), async ({ request, params }) => {
      const input = await validate<{ environment_id: string }>(name, request, params);
      if (!input.ok) return input.response;
      const found = cronAccess(
        input.params.serviceId ?? "",
        actionOf(name),
        input.body.environment_id,
      );
      if (!found.ok) return found.response;
      const paused = name === "pauseCron";
      stateRow(found.service.id, found.environment.id).paused = paused;
      audit(
        found.project.workspace_id,
        found.guard.user.id,
        paused ? "cron.paused" : "cron.resumed",
        "service",
        found.service.id,
        { environment_id: found.environment.id },
      );
      return HttpResponse.json(cronState(found.service.id, found.environment.id));
    }),
  ),
];
