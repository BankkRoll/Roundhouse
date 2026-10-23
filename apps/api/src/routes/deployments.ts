/**
 * Deployments (list, create, inspect, roll back, cancel) and the log routes
 * for deployments and builds. The pipeline itself runs in `DeployWorkflow`;
 * these handlers only create and steer it.
 *
 * @module
 */
import { builds, deploymentEvents, deployments, nodes, placements } from "@roundhouse/db";
import { CANCELLABLE_DEPLOYMENT_STATUSES, ROLLBACK_SOURCE_STATUSES } from "@roundhouse/shared";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import { clientIp, createRouter, originOf } from "../context";
import {
  cancelDeployment,
  createDeployment as createDeploymentRoute,
  getBuildLogs,
  getDeployment,
  getDeploymentLogs,
  listDeployments,
  policyOf,
  rollbackDeployment,
} from "../contracts";
import { recordAudit } from "../lib/audit";
import {
  createDeployment,
  IllegalTransitionError,
  cancelDeployment as stopDeployment,
} from "../lib/deployments";
import { ApiError, conflict } from "../lib/errors";
import { readLogPage } from "../lib/logs";
import { buildScope, deploymentScope, environmentOf, serviceScope } from "../lib/scope";
import { toApiDeployment, toApiDeploymentEvent, toApiPlacement } from "../lib/serialize";

const ID_CURSOR_RE = /^dep_[0-9A-Za-z]{1,64}$/;

async function withBuild(db: import("@roundhouse/db").Db, row: typeof deployments.$inferSelect) {
  const build = row.buildId
    ? ((await db.query.builds.findFirst({ where: eq(builds.id, row.buildId) })) ?? null)
    : null;
  return toApiDeployment(row, build);
}

/** Deployment and log routes. */
export const deploymentRoutes = createRouter()
  .openapi(listDeployments, async (c) => {
    const { serviceId } = c.req.valid("param");
    const query = c.req.valid("query");
    const { project } = await serviceScope(c, serviceId, policyOf(listDeployments).action!);
    await environmentOf(c, project.id, query.environment_id);
    if (query.cursor && !ID_CURSOR_RE.test(query.cursor)) {
      throw new ApiError(400, "invalid_request", "cursor: malformed");
    }
    const rows = await c
      .get("db")
      .select({ deployment: deployments, build: builds })
      .from(deployments)
      .leftJoin(builds, eq(builds.id, deployments.buildId))
      .where(
        and(
          eq(deployments.serviceId, serviceId),
          eq(deployments.environmentId, query.environment_id),
          ...(query.cursor ? [lt(deployments.id, query.cursor)] : []),
        ),
      )
      .orderBy(desc(deployments.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    return c.json(
      {
        deployments: page.map((r) => toApiDeployment(r.deployment, r.build)),
        next_cursor: rows.length > query.limit ? page[page.length - 1]!.deployment.id : null,
      },
      200,
    );
  })
  .openapi(createDeploymentRoute, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    const body = c.req.valid("json");
    const { project, caller } = await serviceScope(
      c,
      serviceId,
      policyOf(createDeploymentRoute).action!,
    );
    await environmentOf(c, project.id, environment_id);
    const db = c.get("db");
    const row = await createDeployment(
      { db, env: c.env },
      {
        projectId: project.id,
        serviceId,
        environmentId: environment_id,
        trigger: "manual",
        triggeredBy: caller.user.id,
        origin: originOf(c),
        ...(body.commit_sha ? { commit: { sha: body.commit_sha } } : {}),
      },
    );
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      actorType: "user",
      actorId: caller.user.id,
      action: "deployment.created",
      targetType: "deployment",
      targetId: row.id,
      metadata: {
        service_id: serviceId,
        environment_id,
        config_version: row.configVersion,
        ...(body.commit_sha ? { commit_sha: body.commit_sha } : {}),
      },
      ip: clientIp(c),
    });
    return c.json(await withBuild(db, row), 201);
  })
  .openapi(getDeployment, async (c) => {
    const { deploymentId } = c.req.valid("param");
    const { deployment } = await deploymentScope(c, deploymentId, policyOf(getDeployment).action!);
    const db = c.get("db");
    const [events, replicas] = await Promise.all([
      db
        .select()
        .from(deploymentEvents)
        .where(eq(deploymentEvents.deploymentId, deploymentId))
        .orderBy(asc(deploymentEvents.id)),
      db
        .select({ placement: placements, nodeName: nodes.name })
        .from(placements)
        .leftJoin(nodes, eq(nodes.id, placements.nodeId))
        .where(eq(placements.deploymentId, deploymentId))
        .orderBy(asc(placements.replica)),
    ]);
    return c.json(
      {
        ...(await withBuild(db, deployment)),
        events: events.map(toApiDeploymentEvent),
        placements: replicas.map((r) => toApiPlacement(r.placement, r.nodeName)),
      },
      200,
    );
  })
  .openapi(rollbackDeployment, async (c) => {
    const { deploymentId } = c.req.valid("param");
    const { deployment, project, caller } = await deploymentScope(
      c,
      deploymentId,
      policyOf(rollbackDeployment).action!,
    );
    if (!ROLLBACK_SOURCE_STATUSES.includes(deployment.status) || !deployment.image) {
      throw conflict(`Cannot roll back to a ${deployment.status} deployment`);
    }
    const db = c.get("db");
    const row = await createDeployment(
      { db, env: c.env },
      {
        projectId: project.id,
        serviceId: deployment.serviceId,
        environmentId: deployment.environmentId,
        trigger: "rollback",
        triggeredBy: caller.user.id,
        origin: originOf(c),
        rollbackOf: deployment,
      },
    );
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      actorType: "user",
      actorId: caller.user.id,
      action: "deployment.rolled_back",
      targetType: "deployment",
      targetId: row.id,
      metadata: { rollback_of: deployment.id, config_version: row.configVersion },
      ip: clientIp(c),
    });
    return c.json(await withBuild(db, row), 201);
  })
  .openapi(cancelDeployment, async (c) => {
    const { deploymentId } = c.req.valid("param");
    const { deployment, project, caller } = await deploymentScope(
      c,
      deploymentId,
      policyOf(cancelDeployment).action!,
    );
    if (!CANCELLABLE_DEPLOYMENT_STATUSES.includes(deployment.status)) {
      throw conflict(`A ${deployment.status} deployment can't be cancelled`);
    }
    const db = c.get("db");
    let row: typeof deployments.$inferSelect;
    try {
      row = await stopDeployment(
        { db, env: c.env },
        project.id,
        deploymentId,
        "Cancelled by a user",
      );
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        throw conflict(`A ${err.from} deployment can't be cancelled`);
      }
      throw err;
    }
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      actorType: "user",
      actorId: caller.user.id,
      action: "deployment.cancelled",
      targetType: "deployment",
      targetId: deploymentId,
      metadata: { service_id: deployment.serviceId, from: deployment.status },
      ip: clientIp(c),
    });
    return c.json(await withBuild(db, row), 200);
  })
  .openapi(getDeploymentLogs, async (c) => {
    const { deploymentId } = c.req.valid("param");
    const { cursor, limit } = c.req.valid("query");
    await deploymentScope(c, deploymentId, policyOf(getDeploymentLogs).action!);
    return c.json(await readLogPage(c.get("db"), c.env.LOGS, { deploymentId }, cursor, limit), 200);
  })
  .openapi(getBuildLogs, async (c) => {
    const { buildId } = c.req.valid("param");
    const { cursor, limit } = c.req.valid("query");
    await buildScope(c, buildId, policyOf(getBuildLogs).action!);
    const page = await readLogPage(c.get("db"), c.env.LOGS, { buildId }, cursor, limit);
    return c.json(
      { lines: page.lines.map(({ workload_id: _, ...l }) => l), next_cursor: page.next_cursor },
      200,
    );
  });
