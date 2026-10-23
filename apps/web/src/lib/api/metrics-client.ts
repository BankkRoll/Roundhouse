/**
 * Typed endpoint functions and wire types for metrics (ADR 0008): a service's container
 * metrics over a range, a project environment's latest per-service summary for the
 * canvas, and a server's usage history.
 *
 * Types come from the API's route contracts (`apps/api/src/contracts/metrics.ts`), so a
 * contract change that breaks the dashboard fails typecheck.
 *
 * @module
 */
import type { NodeMetric, ServiceMetric } from "@roundhouse/shared";
import type {
  getServiceMetrics,
  MetricSeries,
  MetricsSummary,
  NodeMetrics,
  QueryOf,
  ServiceMetrics,
} from "../../../../api/src/contracts";
import { request } from "./client";

export type { MetricSeries, MetricsSummary, NodeMetrics, ServiceMetrics };

/** `[t_ms, value]`; `value` is `null` for a step without samples. */
export type MetricPoint = MetricSeries["points"][number];
/** One service's entry in a {@link MetricsSummary}. */
export type ServiceMetricsSummary = MetricsSummary["services"][number];
/** Time range of a metrics query; both ends unix ms. The API defaults to the last hour. */
export interface MetricsRangeQuery {
  from?: number;
  to?: number;
}
/** Query of `GET /v1/services/{serviceId}/metrics`, with `metrics` as a list. */
export interface ServiceMetricsQuery extends MetricsRangeQuery {
  environment_id: QueryOf<typeof getServiceMetrics>["environment_id"];
  group?: QueryOf<typeof getServiceMetrics>["group"];
  /** Subset of `SERVICE_METRICS`; every one when absent. */
  metrics?: readonly ServiceMetric[];
}
/** Query of `GET /v1/workspaces/{workspaceId}/nodes/{nodeId}/metrics`, with `metrics` as a list. */
export interface NodeMetricsQuery extends MetricsRangeQuery {
  /** Subset of `NODE_METRICS`; every one when absent. */
  metrics?: readonly NodeMetric[];
}

const seg = encodeURIComponent;

function list(names: readonly string[] | undefined): string | undefined {
  return names && names.length > 0 ? names.join(",") : undefined;
}

/** Metrics endpoints. */
export const metricsApi = {
  /**
   * Reads a service's metrics in one environment over a range.
   *
   * @param serviceId - Service id.
   * @param query - Environment, range (unix ms), metric names and grouping.
   * @param signal - Abort signal.
   * @returns Series downsampled to the range's step, with limits and caveats.
   * @example
   * await metricsApi.service("svc_web", { environment_id: "env_prod", group: "replica" });
   */
  service: (serviceId: string, query: ServiceMetricsQuery, signal?: AbortSignal) =>
    request<ServiceMetrics>("GET", `/v1/services/${seg(serviceId)}/metrics`, {
      query: {
        environment_id: query.environment_id,
        from: query.from,
        to: query.to,
        group: query.group,
        metrics: list(query.metrics),
      },
      signal,
    }),
  /**
   * Reads the last five minutes (and an hour of sparkline) of every service in a project
   * environment.
   *
   * @param projectId - Project id.
   * @param environmentId - Environment id; the production environment when absent.
   * @param signal - Abort signal.
   * @returns One summary per service.
   */
  summary: (projectId: string, environmentId?: string, signal?: AbortSignal) =>
    request<MetricsSummary>("GET", `/v1/projects/${seg(projectId)}/metrics/summary`, {
      query: { environment_id: environmentId },
      signal,
    }),
  /**
   * Reads a server's CPU, memory, disk and load history.
   *
   * @param workspaceId - Workspace id.
   * @param nodeId - Node id.
   * @param query - Range (unix ms) and metric names.
   * @param signal - Abort signal.
   * @returns Series downsampled to the range's step.
   */
  node: (workspaceId: string, nodeId: string, query: NodeMetricsQuery = {}, signal?: AbortSignal) =>
    request<NodeMetrics>("GET", `/v1/workspaces/${seg(workspaceId)}/nodes/${seg(nodeId)}/metrics`, {
      query: { from: query.from, to: query.to, metrics: list(query.metrics) },
      signal,
    }),
};
