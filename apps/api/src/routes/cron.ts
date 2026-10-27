/**
 * Cron service routes (ADR 0010): schedule preview, schedule state, run
 * history and logs, run now, cancel, pause and resume. Runs themselves are
 * driven by `CronRunWorkflow`; these handlers only create and steer them.
 *
 * Every route that targets an environment checks its action against that
 * environment, so a protected environment's deploy and config rules apply
 * to run now and cancel (`deployments:create`) and to pause and resume
 * (`services:manage`). Audit entries name the run and the environment,
 * never a value from the run's environment.
 *
 * @module
 */
import { cronRuns, cronStates } from "@roundhouse/db";
import {
  isTerminalCronRunStatus,
  newId,
  nextRuns,
  PLACED_CRON_RUN_STATUSES,
  scheduleError,
} from "@roundhouse/shared";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { type AppContext, clientIp, createRouter } from "../context";
import {
  cancelCronRun,
  getCronRun,
  getCronRunLogs,
  getCronState,
  listCronRuns,
  pauseCron,
  policyOf,
  previewCronSchedule,
  resumeCron,
  triggerCronRun,
} from "../contracts";
import type { CronState } from "../contracts/cron";
import { recordAudit } from "../lib/audit";
import {
  armedDeployment,
  type CronRunRow,
  cancelRun,
  finishCronRun,
  publishCronRuns,
  startCronRunWorkflow,
  toApiCronRun,
} from "../lib/cron/runs";
import { setCronPaused } from "../lib/cron/schedule";
import { ApiError, conflict, notFound } from "../lib/errors";
import { readLogPage } from "../lib/logs";
import { environmentOf, projectScope, serviceScope } from "../lib/scope";

const RUN_CURSOR_RE = /^crn_[0-9A-Za-z]{1,64}$/;

/** Slots shown with a schedule state. */
const STATE_PREVIEW_COUNT = 5;

/** Loads a cron service and checks `action` in `environmentId`. 409 for other kinds. */
async function cronServiceScope(
  c: AppContext,
  serviceId: string,
  action: Parameters<typeof serviceScope>[2],
  environmentId: string,
) {
  const scope = await serviceScope(c, serviceId, action, environmentId);
  await environmentOf(c, scope.project.id, environmentId);
  if (scope.service.kind !== "cron") throw conflict("The service is not a cron service");
  return scope;
}

/** Loads a run and authorizes `action` on its service in its environment. */
async function runScope(c: AppContext, runId: string, action: Parameters<typeof serviceScope>[2]) {
  const [run] = await c.get("db").select().from(cronRuns).where(eq(cronRuns.id, runId)).limit(1);
  if (!run) throw notFound("Cron run");
  try {
    const scope = await serviceScope(c, run.serviceId, action, run.environmentId);
    return { run, ...scope };
  } catch (err) {
    // The same 404 whether the run is missing or in a workspace the caller can't see.
    if (err instanceof ApiError && err.status === 404) throw notFound("Cron run");
    throw err;
  }
}

async function cronState(
  c: AppContext,
  serviceId: string,
  environmentId: string,
): Promise<CronState> {
  const db = c.get("db");
  const [state] = await db
    .select()
    .from(cronStates)
    .where(and(eq(cronStates.serviceId, serviceId), eq(cronStates.environmentId, environmentId)))
    .limit(1);
  const armed = await armedDeployment(db, serviceId, environmentId);
  const paused = state?.paused ?? false;
  const next = state?.nextRunAt ? +state.nextRunAt : null;
  let upcoming: number[] = [];
  if (armed && !paused && next !== null) {
    try {
      upcoming = nextRuns(armed.cron.schedule, armed.cron.timezone, next - 1, STATE_PREVIEW_COUNT);
    } catch {
      upcoming = [];
    }
  }
  return {
    service_id: serviceId,
    environment_id: environmentId,
    paused,
    next_run_at: next,
    last_scheduled_for: state?.lastScheduledFor ? +state.lastScheduledFor : null,
    armed_deployment_id: armed?.deployment.id ?? null,
    schedule: armed?.cron.schedule ?? null,
    timezone: armed?.cron.timezone ?? null,
    next_runs: upcoming,
  };
}

/** Cron routes. */
export const cronRoutes = createRouter()
  .openapi(previewCronSchedule, async (c) => {
    const { projectId } = c.req.valid("param");
    const query = c.req.valid("query");
    await projectScope(c, projectId, policyOf(previewCronSchedule).action!);
    const error = scheduleError(query.schedule, query.timezone);
    return c.json(
      {
        valid: error === null,
        next_runs: error ? [] : nextRuns(query.schedule, query.timezone, Date.now(), query.count),
        error,
      },
      200,
    );
  })
  .openapi(getCronState, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    await cronServiceScope(c, serviceId, policyOf(getCronState).action!, environment_id);
    return c.json(await cronState(c, serviceId, environment_id), 200);
  })
  .openapi(listCronRuns, async (c) => {
    const { serviceId } = c.req.valid("param");
    const query = c.req.valid("query");
    const { project } = await serviceScope(c, serviceId, policyOf(listCronRuns).action!);
    await environmentOf(c, project.id, query.environment_id);
    if (query.cursor && !RUN_CURSOR_RE.test(query.cursor)) {
      throw new ApiError(400, "invalid_request", "cursor: malformed");
    }
    const rows = await c
      .get("db")
      .select()
      .from(cronRuns)
      .where(
        and(
          eq(cronRuns.serviceId, serviceId),
          eq(cronRuns.environmentId, query.environment_id),
          ...(query.status ? [eq(cronRuns.status, query.status)] : []),
          ...(query.cursor ? [lt(cronRuns.id, query.cursor)] : []),
        ),
      )
      .orderBy(desc(cronRuns.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    return c.json(
      {
        runs: page.map((r) => toApiCronRun(r, project.id)),
        next_cursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
      },
      200,
    );
  })
  .openapi(triggerCronRun, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { environment_id, force = false } = c.req.valid("json");
    const { project, caller } = await cronServiceScope(
      c,
      serviceId,
      policyOf(triggerCronRun).action!,
      environment_id,
    );
    const db = c.get("db");
    const armed = await armedDeployment(db, serviceId, environment_id);
    if (!armed) throw conflict("The cron service has no active deployment; deploy it first");
    const busy = await db
      .select({ id: cronRuns.id })
      .from(cronRuns)
      .where(
        and(
          eq(cronRuns.serviceId, serviceId),
          eq(cronRuns.environmentId, environment_id),
          inArray(cronRuns.status, [...PLACED_CRON_RUN_STATUSES]),
        ),
      )
      .limit(1);
    if (busy.length && !force) {
      throw new ApiError(
        409,
        "run_in_progress",
        `Run ${busy[0]!.id} is still in progress; pass force to cancel it first`,
      );
    }
    const id = newId("cronRun");
    const now = new Date();
    const [run] = await db
      .insert(cronRuns)
      .values({
        id,
        serviceId,
        environmentId: environment_id,
        deploymentId: armed.deployment.id,
        trigger: "manual",
        scheduledFor: now,
        status: "queued",
        triggeredBy: caller.user.id,
        workflowInstanceId: id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await startCronRunWorkflow(c.env, { runId: id, replace: force });
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "cron.run_triggered",
      targetType: "cron_run",
      targetId: id,
      metadata: {
        service_id: serviceId,
        environment_id,
        deployment_id: armed.deployment.id,
        force,
      },
      ip: clientIp(c),
    });
    await publishCronRuns(c.env, project.id, [run!]);
    return c.json(toApiCronRun(run!, project.id), 201);
  })
  .openapi(getCronRun, async (c) => {
    const { runId } = c.req.valid("param");
    const { run, project } = await runScope(c, runId, policyOf(getCronRun).action!);
    return c.json(toApiCronRun(run, project.id), 200);
  })
  .openapi(getCronRunLogs, async (c) => {
    const { runId } = c.req.valid("param");
    const { cursor, limit } = c.req.valid("query");
    await runScope(c, runId, policyOf(getCronRunLogs).action!);
    return c.json(
      await readLogPage(c.get("db"), c.env.LOGS, { cronRunId: runId }, cursor, limit),
      200,
    );
  })
  .openapi(cancelCronRun, async (c) => {
    const { runId } = c.req.valid("param");
    const { run, project, caller } = await runScope(c, runId, policyOf(cancelCronRun).action!);
    if (isTerminalCronRunStatus(run.status)) {
      throw conflict(`A ${run.status} run can't be cancelled`);
    }
    const db = c.get("db");
    const reason = `cancelled by ${caller.user.name || "a user"}`;
    let row: CronRunRow | undefined;
    if (run.status === "queued") {
      row = await finishCronRun(db, runId, "cancelled", ["queued"], { error: reason });
    }
    if (!row) {
      const [current] = await db.select().from(cronRuns).where(eq(cronRuns.id, runId)).limit(1);
      if (!current || isTerminalCronRunStatus(current.status)) {
        throw conflict(`A ${current?.status ?? "removed"} run can't be cancelled`);
      }
      await cancelRun(c.env, db, current, reason);
      [row] = await db.select().from(cronRuns).where(eq(cronRuns.id, runId)).limit(1);
    }
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "cron.run_cancelled",
      targetType: "cron_run",
      targetId: runId,
      metadata: {
        service_id: run.serviceId,
        environment_id: run.environmentId,
        from: run.status,
      },
      ip: clientIp(c),
    });
    await publishCronRuns(c.env, project.id, [row!]);
    return c.json(toApiCronRun(row!, project.id), 200);
  })
  .openapi(pauseCron, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { environment_id } = c.req.valid("json");
    const { project, caller } = await cronServiceScope(
      c,
      serviceId,
      policyOf(pauseCron).action!,
      environment_id,
    );
    const db = c.get("db");
    await setCronPaused(db, {
      serviceId,
      environmentId: environment_id,
      paused: true,
      now: Date.now(),
    });
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "cron.paused",
      targetType: "service",
      targetId: serviceId,
      metadata: { environment_id },
      ip: clientIp(c),
    });
    return c.json(await cronState(c, serviceId, environment_id), 200);
  })
  .openapi(resumeCron, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { environment_id } = c.req.valid("json");
    const { project, caller } = await cronServiceScope(
      c,
      serviceId,
      policyOf(resumeCron).action!,
      environment_id,
    );
    const db = c.get("db");
    await setCronPaused(db, {
      serviceId,
      environmentId: environment_id,
      paused: false,
      now: Date.now(),
    });
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "cron.resumed",
      targetType: "service",
      targetId: serviceId,
      metadata: { environment_id },
      ip: clientIp(c),
    });
    return c.json(await cronState(c, serviceId, environment_id), 200);
  });
