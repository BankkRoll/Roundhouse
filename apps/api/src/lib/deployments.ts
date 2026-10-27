/**
 * Deployment lifecycle shared by the routes, the deploy workflow and the
 * node Durable Objects.
 *
 * - {@link transitionDeployment}: the only way a status changes. Every change
 *   is checked with `canTransition`, guarded on the current status in the
 *   `WHERE` clause, recorded as a `status_changed` event and published.
 * - {@link createDeployment}: inserts a queued deployment, supersedes older
 *   in-flight ones, and starts its workflow.
 * - {@link cancelDeployment} / {@link retireDeployments}: stop deployments,
 *   stop their builds on the builder ({@link cancelBuildsOnNodes}) and pull
 *   their replicas off nodes.
 *
 * @module
 */
import {
  builds,
  type Db,
  deploymentEvents,
  deployments,
  serviceConfigs,
  services,
} from "@roundhouse/db";
import {
  CANCELLABLE_DEPLOYMENT_STATUSES,
  canTransition,
  type DeploymentEventType,
  type DeploymentStatus,
  type DeploymentTrigger,
  newId,
} from "@roundhouse/shared";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { Env } from "../env";
import type { DeployParams } from "../workflows/deploy";
import { nodesOfDeployments, refreshNodes } from "./desired-state";
import { ApiError, conflict } from "./errors";
import { publish } from "./realtime";
import { toApiDeployment, toApiDeploymentEvent } from "./serialize";

type DeploymentRow = typeof deployments.$inferSelect;

/** What lifecycle helpers need: the database and the Worker's bindings. */
export interface LifecycleContext {
  db: Db;
  env: Env;
}

/**
 * Releases an RPC result (a Workflow instance handle, a Durable Object
 * reply) now rather than whenever the garbage collector gets to it; workerd
 * warns about results left for the collector.
 *
 * @param value - Anything returned over RPC.
 */
export function disposeRpc(value: unknown): void {
  const dispose = (value as { [Symbol.dispose]?: () => void } | null)?.[Symbol.dispose];
  if (typeof dispose === "function") dispose.call(value);
}

/** Thrown when a status change is not allowed by `canTransition`. */
export class IllegalTransitionError extends Error {
  /**
   * @param from - Current status.
   * @param to - Rejected target status.
   */
  constructor(
    readonly from: DeploymentStatus,
    readonly to: DeploymentStatus,
  ) {
    super(`Illegal deployment transition ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

/**
 * Appends a timeline entry and publishes it to the project's sockets.
 *
 * @param ctx - Database and bindings.
 * @param projectId - Project to publish to.
 * @param deploymentId - The deployment.
 * @param type - Event type.
 * @param message - Human-readable text.
 * @param data - Structured details; never secrets.
 */
export async function addDeploymentEvent(
  ctx: LifecycleContext,
  projectId: string,
  deploymentId: string,
  type: DeploymentEventType,
  message: string,
  data?: Record<string, unknown>,
): Promise<void> {
  const [row] = await ctx.db
    .insert(deploymentEvents)
    .values({ id: newId("deploymentEvent"), deploymentId, type, message, data: data ?? null })
    .returning();
  if (row)
    await publish(ctx.env, projectId, {
      type: "deployment.event",
      event: toApiDeploymentEvent(row),
    });
}

/**
 * Publishes a deployment's current row as `deployment.updated`.
 *
 * @param ctx - Database and bindings.
 * @param projectId - Project to publish to.
 * @param deployment - The deployment row, or its ID to load it.
 */
export async function publishDeployment(
  ctx: LifecycleContext,
  projectId: string,
  deployment: DeploymentRow | string,
): Promise<void> {
  const row =
    typeof deployment === "string"
      ? await ctx.db.query.deployments.findFirst({ where: eq(deployments.id, deployment) })
      : deployment;
  if (!row) return;
  const build = row.buildId
    ? ((await ctx.db.query.builds.findFirst({ where: eq(builds.id, row.buildId) })) ?? null)
    : null;
  await publish(ctx.env, projectId, {
    type: "deployment.updated",
    deployment: toApiDeployment(row, build, projectId),
  });
}

/** Options for {@link transitionDeployment}. */
export interface TransitionOptions {
  /** Stored as `failure_reason`; for `failed`, `cancelled` and `crashed`. */
  reason?: string;
  /** Extra timeline data. */
  data?: Record<string, unknown>;
}

/**
 * Moves a deployment to `to`.
 *
 * @param ctx - Database and bindings.
 * @param projectId - Project to publish to.
 * @param deploymentId - The deployment.
 * @param to - Target status.
 * @param options - Failure reason and event data.
 * @returns The updated row, or `null` when it was already in `to` (a retried
 *   step), so callers can stay idempotent.
 * @throws {IllegalTransitionError} When `canTransition` forbids the change.
 */
export async function transitionDeployment(
  ctx: LifecycleContext,
  projectId: string,
  deploymentId: string,
  to: DeploymentStatus,
  options: TransitionOptions = {},
): Promise<DeploymentRow | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await ctx.db.query.deployments.findFirst({
      where: eq(deployments.id, deploymentId),
    });
    if (!current) throw new Error(`deployment ${deploymentId} not found`);
    if (current.status === to) return null;
    if (!canTransition(current.status, to)) throw new IllegalTransitionError(current.status, to);

    const now = new Date();
    const finished = !["queued", "building", "deploying", "crashed"].includes(to);
    const [row] = await ctx.db
      .update(deployments)
      .set({
        status: to,
        updatedAt: now,
        ...((to === "building" || to === "deploying") && !current.startedAt
          ? { startedAt: now }
          : {}),
        ...(finished && !current.finishedAt ? { finishedAt: now } : {}),
        ...(options.reason !== undefined ? { failureReason: options.reason } : {}),
      })
      .where(and(eq(deployments.id, deploymentId), eq(deployments.status, current.status)))
      .returning();
    // Lost a race with another writer; re-read and re-check against the new status.
    if (!row) continue;
    await addDeploymentEvent(
      ctx,
      projectId,
      deploymentId,
      "status_changed",
      options.reason ? `${current.status} → ${to}: ${options.reason}` : `${current.status} → ${to}`,
      { from: current.status, to, ...(options.data ?? {}) },
    );
    await publishDeployment(ctx, projectId, row);
    return row;
  }
  throw new Error(`deployment ${deploymentId} kept changing; gave up moving it to ${to}`);
}

/**
 * Pushes fresh desired state to every node holding replicas of the given
 * deployments. Their status already excludes them (or they were just
 * removed), so the agents drop the containers.
 *
 * @param ctx - Database and bindings.
 * @param deploymentIds - Deployments whose replicas should go.
 */
export async function retireDeployments(
  ctx: LifecycleContext,
  deploymentIds: readonly string[],
): Promise<void> {
  await refreshNodes(ctx.env, ctx.db, await nodesOfDeployments(ctx.db, deploymentIds));
}

/**
 * Wakes a deployment's workflow so it re-reads the database (after a cancel,
 * a build result, or a replica change). Lost wake-ups are harmless: the
 * workflow re-checks the database before every wait.
 *
 * @param env - Bindings.
 * @param deployment - The deployment; ignored when it has no workflow.
 * @param type - `build`, `health` or `pre_deploy` (its pre-deploy run ended).
 * @param payload - Small diagnostic payload.
 */
export async function wakeWorkflow(
  env: Pick<Env, "DEPLOY_WORKFLOW">,
  deployment: Pick<DeploymentRow, "workflowInstanceId">,
  type: "build" | "health" | "pre_deploy",
  payload: Record<string, unknown> = {},
): Promise<void> {
  if (!deployment.workflowInstanceId) return;
  try {
    const instance = await env.DEPLOY_WORKFLOW.get(deployment.workflowInstanceId);
    try {
      await instance.sendEvent({ type, payload });
    } finally {
      disposeRpc(instance);
    }
  } catch (err) {
    console.warn("workflow wake-up failed", deployment.workflowInstanceId, err);
  }
}

/**
 * Tells each build's node to stop it with a signed `build_cancel`, so the
 * builder is free for the next build at once instead of finishing work
 * nobody wants. Best effort: a node that is offline or too old to know the
 * frame is skipped, and its build ends at its own timeout.
 *
 * @param env - Bindings with the node namespace.
 * @param stopped - Builds just marked cancelled or failed, with their node.
 */
export async function cancelBuildsOnNodes(
  env: Pick<Env, "NODE_CONNECTION">,
  stopped: readonly { id: string; nodeId: string | null }[],
): Promise<void> {
  await Promise.all(
    stopped.map(async ({ id, nodeId }) => {
      if (!nodeId) return;
      try {
        const stub = env.NODE_CONNECTION.get(env.NODE_CONNECTION.idFromName(nodeId));
        disposeRpc(await stub.sendBuildCancel(id));
      } catch (err) {
        console.warn("build cancel not delivered", id, err);
      }
    }),
  );
}

/**
 * Cancels a deployment: marks it (and its build) cancelled, stops the build
 * on its builder, drops its replicas from nodes, and wakes its workflow so it
 * exits (cancelling its pre-deploy run, if one is in progress).
 *
 * @param ctx - Database and bindings.
 * @param projectId - Owning project.
 * @param deploymentId - The deployment.
 * @param reason - Shown as `failure_reason`.
 * @returns The cancelled row.
 * @throws {IllegalTransitionError} When it is no longer cancellable.
 */
export async function cancelDeployment(
  ctx: LifecycleContext,
  projectId: string,
  deploymentId: string,
  reason: string,
): Promise<DeploymentRow> {
  const row = await transitionDeployment(ctx, projectId, deploymentId, "cancelled", { reason });
  const current =
    row ?? (await ctx.db.query.deployments.findFirst({ where: eq(deployments.id, deploymentId) }))!;
  const stopped = await ctx.db
    .update(builds)
    .set({ status: "cancelled", finishedAt: new Date(), error: reason })
    .where(
      and(eq(builds.deploymentId, deploymentId), inArray(builds.status, ["queued", "running"])),
    )
    .returning({ id: builds.id, nodeId: builds.nodeId });
  await cancelBuildsOnNodes(ctx.env, stopped);
  await retireDeployments(ctx, [deploymentId]);
  await Promise.all([
    wakeWorkflow(ctx.env, current, "build", { cancelled: true }),
    wakeWorkflow(ctx.env, current, "health", { cancelled: true }),
    wakeWorkflow(ctx.env, current, "pre_deploy", { cancelled: true }),
  ]);
  return current;
}

/** What to deploy. */
export interface CreateDeploymentInput {
  projectId: string;
  serviceId: string;
  environmentId: string;
  trigger: DeploymentTrigger;
  triggeredBy: string | null;
  /** Control plane origin, for links in GitHub commit statuses. */
  origin: string;
  /** Git sources: the commit to build, with metadata from a push. */
  commit?: DeployParams["commit"];
  /** Rollbacks: the deployment whose image and config version to reuse. */
  rollbackOf?: DeploymentRow;
  /**
   * Promotions (ADR 0007): another environment's deployment whose image, by
   * digest, runs here with this environment's latest config. Its build is
   * linked for traceability, never rerun.
   */
  promoteOf?: DeploymentRow;
}

/**
 * Creates a queued deployment and starts its workflow. Older deployments of
 * the same service and environment still in flight are cancelled, so two
 * rollouts never race to become active.
 *
 * @param ctx - Database and bindings.
 * @param input - Service, environment and trigger.
 * @returns The new deployment row.
 * @throws {ApiError} 409 when there is no config or it has 0 replicas; 422
 *   `cron_schedule_required` for a cron service without a schedule.
 */
export async function createDeployment(
  ctx: LifecycleContext,
  input: CreateDeploymentInput,
): Promise<DeploymentRow> {
  const { db } = ctx;
  const source = input.rollbackOf;
  const [config] = await db
    .select()
    .from(serviceConfigs)
    .where(
      and(
        eq(serviceConfigs.serviceId, input.serviceId),
        eq(serviceConfigs.environmentId, input.environmentId),
        ...(source ? [eq(serviceConfigs.version, source.configVersion)] : []),
      ),
    )
    .orderBy(desc(serviceConfigs.version))
    .limit(1);
  if (!config) throw conflict("The service has no config in this environment");
  const [service] = await db
    .select({ kind: services.kind })
    .from(services)
    .where(eq(services.id, input.serviceId))
    .limit(1);
  // A cron service runs no replicas; its deployment only arms the schedule (ADR 0010).
  if (service?.kind === "cron") {
    if (!config.cron) {
      throw new ApiError(
        422,
        "cron_schedule_required",
        "A cron service needs a schedule: set cron.schedule in its config before deploying",
      );
    }
  } else if (config.deploy.replicas === 0) {
    throw conflict("The service has 0 replicas; scale it up before deploying");
  }

  const id = newId("deployment");
  const [row] = await db
    .insert(deployments)
    .values({
      id,
      serviceId: input.serviceId,
      environmentId: input.environmentId,
      configVersion: config.version,
      image:
        input.promoteOf?.image ??
        source?.image ??
        (config.source.type === "image" ? config.source.image : null),
      buildId: input.promoteOf?.buildId ?? null,
      status: "queued",
      trigger: input.trigger,
      triggeredBy: input.triggeredBy,
      rollbackOf: source?.id ?? null,
      workflowInstanceId: id,
    })
    .returning();

  const inFlight = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.serviceId, input.serviceId),
        eq(deployments.environmentId, input.environmentId),
        inArray(deployments.status, [...CANCELLABLE_DEPLOYMENT_STATUSES]),
        lt(deployments.id, id),
      ),
    );
  for (const older of inFlight) {
    try {
      await cancelDeployment(ctx, input.projectId, older.id, `Superseded by ${id}`);
    } catch (err) {
      if (!(err instanceof IllegalTransitionError)) throw err;
    }
  }

  const params: DeployParams = {
    deployment_id: id,
    origin: input.origin,
    ...(input.commit ? { commit: input.commit } : {}),
  };
  try {
    disposeRpc(await ctx.env.DEPLOY_WORKFLOW.create({ id, params }));
  } catch (err) {
    await transitionDeployment(ctx, input.projectId, id, "failed", {
      reason: "Could not start the deploy pipeline",
    });
    throw err;
  }
  await publishDeployment(ctx, input.projectId, row!);
  return row!;
}
