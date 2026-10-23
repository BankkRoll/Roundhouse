/**
 * Metrics routes (ADR 0008): a service's container metrics over a time
 * range, the latest per-service averages of a project for the canvas, and a
 * node's usage history.
 *
 * Every response is downsampled to a step chosen from the range
 * (`metricsStep`), so a chart never gets more than `MAX_METRIC_POINTS`
 * points. Metrics carry numbers and IDs only: no environment, command line,
 * request path or log text ever reaches the dataset.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { MAX_METRICS_RANGE_MS, NODE_METRICS, SERVICE_METRICS } from "@roundhouse/shared";
import { errors, json, sessionAuth, WorkspaceParams } from "../schemas";
import { ProjectParams, ServiceParams } from "./params";
import { defineRoute, session } from "./policy";

/** Where answers come from: Analytics Engine, or the short-retention D1 fallback. */
export const METRICS_BACKENDS = ["analytics_engine", "d1"] as const;

const Millis = z.coerce.number().int().nonnegative();

/** Time range shared by every metrics query; both ends unix ms, `to` defaulting to now. */
const RangeQuery = z.object({
  from: Millis.optional().openapi({ description: "Unix ms; defaults to one hour before `to`." }),
  to: Millis.optional().openapi({ description: "Unix ms; defaults to now." }),
});

/** Comma-separated metric names, deduplicated; every one when absent. */
function metricList<const T extends readonly [string, ...string[]]>(names: T) {
  return z
    .string()
    .max(200)
    .transform((s, ctx) => {
      const picked = [
        ...new Set(
          s
            .split(",")
            .map((m) => m.trim())
            .filter(Boolean),
        ),
      ];
      for (const m of picked) {
        if (!(names as readonly string[]).includes(m)) {
          ctx.addIssue({ code: "custom", message: `unknown metric ${m}` });
          return z.NEVER;
        }
      }
      return picked as T[number][];
    })
    .optional()
    .openapi({ description: `Comma-separated subset of: ${names.join(", ")}.` });
}

/** Query of `GET /v1/services/{serviceId}/metrics`. */
export const ServiceMetricsQuery = RangeQuery.extend({
  environment_id: z.string(),
  metrics: metricList(SERVICE_METRICS),
  /** `service` sums (or averages) replicas into one series; `replica` keeps one per workload. */
  group: z.enum(["service", "replica"]).default("service"),
});

/** Query of `GET /v1/workspaces/{workspaceId}/nodes/{nodeId}/metrics`. */
export const NodeMetricsQuery = RangeQuery.extend({ metrics: metricList(NODE_METRICS) });

/** Query of `GET /v1/projects/{projectId}/metrics/summary`. */
export const MetricsSummaryQuery = z.object({
  /** Defaults to the production environment. */
  environment_id: z.string().optional(),
});

/** `[t_ms, value]`; `value` is `null` for a step with no samples. */
const PointSchema = z.tuple([z.number(), z.number().nullable()]);

/** One series of a metrics response. */
export const MetricSeriesSchema = z
  .object({
    metric: z.string(),
    /** Set for `group=replica`; absent for a whole-service series. */
    workload_id: z.string().optional(),
    points: z.array(PointSchema),
  })
  .openapi("MetricSeries");

/** Facts about a response that change how it should be read. */
const MetricsMetaShape = {
  /** Step between points, seconds. */
  step_s: z.number().int().positive(),
  from: z.number().int(),
  to: z.number().int(),
  backend: z.enum(METRICS_BACKENDS),
  /** D1 fallback: samples older than 48 h are gone. */
  short_retention: z.boolean(),
};

/** A service's metrics over a range. */
export const ServiceMetricsSchema = z
  .object({
    ...MetricsMetaShape,
    /**
     * The latest config's limits in this environment, for limit lines;
     * `null` when the service has no config there. `memory_bytes` is the
     * configured limit, not the node's total.
     */
    limits: z.object({ cpu_millis: z.number(), memory_bytes: z.number() }).nullable(),
    /** Some samples in the range came from Docker stats (cgroup v1 hosts) and are approximate. */
    approximate: z.boolean(),
    series: z.array(MetricSeriesSchema),
  })
  .openapi("ServiceMetrics");

/** A node's usage over a range. */
export const NodeMetricsSchema = z
  .object({ ...MetricsMetaShape, series: z.array(MetricSeriesSchema) })
  .openapi("NodeMetrics");

/** One service's recent usage, for the canvas. */
export const ServiceMetricsSummarySchema = z
  .object({
    service_id: z.string(),
    /** Averages over the last five minutes; `null` without samples. */
    cpu_millis: z.number().nullable(),
    mem_bytes: z.number().nullable(),
    cpu_limit_millis: z.number().nullable(),
    mem_limit_bytes: z.number().nullable(),
    /** The last hour in 5-minute steps, oldest first, for sparklines. */
    cpu: z.array(PointSchema),
    memory: z.array(PointSchema),
  })
  .openapi("ServiceMetricsSummary");

/** Recent usage of every service in a project environment. */
export const MetricsSummarySchema = z
  .object({
    environment_id: z.string(),
    backend: z.enum(METRICS_BACKENDS),
    short_retention: z.boolean(),
    services: z.array(ServiceMetricsSummarySchema),
  })
  .openapi("MetricsSummary");

/** `{workspaceId}` and `{nodeId}` path params. */
export const NodeMetricsParams = WorkspaceParams.extend({ nodeId: z.string() });

const RANGE_ERRORS = `400 when \`from\` is not before \`to\` or the range exceeds ${MAX_METRICS_RANGE_MS / 86_400_000} days.`;

/**
 * A service's container metrics in one environment. Rates (network, disk)
 * are bytes per second; CPU is millicores. With `group=replica`, one series
 * per replica (at most `MAX_REPLICA_SERIES`).
 */
export const getServiceMetrics = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/services/{serviceId}/metrics",
  tags: ["metrics"],
  summary: "Get a service's metrics",
  description: RANGE_ERRORS,
  security: sessionAuth,
  request: { params: ServiceParams, query: ServiceMetricsQuery },
  responses: { 200: json(ServiceMetricsSchema), ...errors(400, 401, 403, 404, 503) },
});

/** The last five minutes (and an hour of sparkline) of every service in an environment. */
export const getProjectMetricsSummary = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/projects/{projectId}/metrics/summary",
  tags: ["metrics"],
  summary: "Get a project's metrics summary",
  security: sessionAuth,
  request: { params: ProjectParams, query: MetricsSummaryQuery },
  responses: { 200: json(MetricsSummarySchema), ...errors(401, 403, 404, 503) },
});

/** A node's CPU, memory, disk and load history. */
export const getNodeMetrics = defineRoute(session("nodes:read"), {
  method: "get",
  path: "/v1/workspaces/{workspaceId}/nodes/{nodeId}/metrics",
  tags: ["metrics"],
  summary: "Get a server's metrics",
  description: RANGE_ERRORS,
  security: sessionAuth,
  request: { params: NodeMetricsParams, query: NodeMetricsQuery },
  responses: { 200: json(NodeMetricsSchema), ...errors(400, 401, 403, 404, 503) },
});

/** Every metrics route, by name. */
export const METRICS_ROUTES = {
  getServiceMetrics,
  getProjectMetricsSummary,
  getNodeMetrics,
} as const;

/** A service's metrics over a range. */
export type ServiceMetrics = z.infer<typeof ServiceMetricsSchema>;
/** A node's metrics over a range. */
export type NodeMetrics = z.infer<typeof NodeMetricsSchema>;
/** A project environment's metrics summary. */
export type MetricsSummary = z.infer<typeof MetricsSummarySchema>;
/** One series. */
export type MetricSeries = z.infer<typeof MetricSeriesSchema>;
