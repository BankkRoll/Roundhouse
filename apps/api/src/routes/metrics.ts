/**
 * Metrics routes (ADR 0008): a service's container metrics, a project's
 * per-service summary for the canvas, and a node's usage history.
 *
 * Each route authorizes first (`services:read`, `projects:read`,
 * `nodes:read`), then asks the active store with filters that also pin the
 * caller's workspace, so a row can only ever be read through the workspace
 * that wrote it.
 *
 * @module
 */
import { environments, nodes } from "@roundhouse/db";
import {
  DEFAULT_METRICS_RANGE_MS,
  MAX_METRICS_RANGE_MS,
  NODE_METRICS,
  SERVICE_METRICS,
} from "@roundhouse/shared";
import { and, eq, isNull } from "drizzle-orm";
import { createRouter, requireWorkspace } from "../context";
import {
  getNodeMetrics,
  getProjectMetricsSummary,
  getServiceMetrics,
  policyOf,
} from "../contracts";
import { ApiError, notFound } from "../lib/errors";
import { InvalidMetricsQuery } from "../lib/metrics/query";
import { alignRange, nodeSeries, projectSummary, serviceSeries } from "../lib/metrics/series";
import { metricsStore } from "../lib/metrics/store";
import { latestConfig, liveServices } from "../lib/projects";
import { environmentOf, projectScope, serviceScope } from "../lib/scope";

/**
 * Resolves a query's range: `to` defaults to now, `from` to an hour
 * before it.
 *
 * @throws {ApiError} 400 for an empty, inverted or over-long range.
 */
function range(query: { from?: number; to?: number }, now: number) {
  const to = query.to ?? now;
  const from = query.from ?? to - DEFAULT_METRICS_RANGE_MS;
  if (from >= to) throw new ApiError(400, "invalid_request", "`from` must be before `to`");
  if (to - from > MAX_METRICS_RANGE_MS) {
    throw new ApiError(400, "invalid_request", "The range may span at most 90 days");
  }
  return alignRange(from, to);
}

function meta(backend: "analytics_engine" | "d1", r: ReturnType<typeof alignRange>) {
  return {
    step_s: r.stepS,
    from: r.from * 1000,
    to: r.to * 1000,
    backend,
    short_retention: backend === "d1",
  };
}

/** Turns a query-builder rejection into a 400 rather than a 500. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof InvalidMetricsQuery) throw new ApiError(400, "invalid_request", err.message);
    throw err;
  }
}

/** Metrics routes. */
export const metricsRoutes = createRouter()
  .openapi(getServiceMetrics, async (c) => {
    const { serviceId } = c.req.valid("param");
    const query = c.req.valid("query");
    const { service, project } = await serviceScope(
      c,
      serviceId,
      policyOf(getServiceMetrics).action!,
      query.environment_id,
    );
    const environment = await environmentOf(c, project.id, query.environment_id);
    const r = range(query, Date.now());
    const store = metricsStore(c.env);
    const metrics = query.metrics?.length ? query.metrics : [...SERVICE_METRICS];
    const { series, approximate } = await guarded(() =>
      serviceSeries(
        store,
        { workspaceId: project.workspaceId, serviceId: service.id, environmentId: environment.id },
        r,
        metrics,
        query.group,
      ),
    );
    const config = await latestConfig(c.get("db"), service.id, environment.id);
    return c.json(
      {
        ...meta(store.backend, r),
        limits: config
          ? {
              cpu_millis: config.resources.cpu_millis,
              memory_bytes: config.resources.memory_mb * 1024 * 1024,
            }
          : null,
        approximate,
        series,
      },
      200,
    );
  })
  .openapi(getProjectMetricsSummary, async (c) => {
    const { projectId } = c.req.valid("param");
    const query = c.req.valid("query");
    const { project } = await projectScope(
      c,
      projectId,
      policyOf(getProjectMetricsSummary).action!,
    );
    const db = c.get("db");
    const [environment] = query.environment_id
      ? [await environmentOf(c, projectId, query.environment_id)]
      : await db
          .select()
          .from(environments)
          .where(and(eq(environments.projectId, projectId), eq(environments.kind, "production")))
          .limit(1);
    if (!environment) throw notFound("Environment");
    const store = metricsStore(c.env);
    const serviceIds = (await liveServices(db, projectId)).map((s) => s.id);
    const services = await guarded(() =>
      projectSummary(
        store,
        { workspaceId: project.workspaceId, projectId, environmentId: environment.id },
        serviceIds,
        Date.now(),
      ),
    );
    return c.json(
      {
        environment_id: environment.id,
        backend: store.backend,
        short_retention: store.backend === "d1",
        services,
      },
      200,
    );
  })
  .openapi(getNodeMetrics, async (c) => {
    const { workspaceId, nodeId } = c.req.valid("param");
    const query = c.req.valid("query");
    await requireWorkspace(c, workspaceId, policyOf(getNodeMetrics).action!);
    const node = await c.get("db").query.nodes.findFirst({
      where: and(eq(nodes.id, nodeId), eq(nodes.workspaceId, workspaceId), isNull(nodes.deletedAt)),
      columns: { id: true },
    });
    if (!node) throw notFound("Server");
    const r = range(query, Date.now());
    const store = metricsStore(c.env);
    const metrics = query.metrics?.length ? query.metrics : [...NODE_METRICS];
    const series = await guarded(() => nodeSeries(store, { workspaceId, nodeId }, r, metrics));
    return c.json({ ...meta(store.backend, r), series }, 200);
  });
