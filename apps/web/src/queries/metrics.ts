/**
 * Metrics queries (ADR 0008). A service's charts refetch on a step-appropriate interval
 * (never faster than the API's 30 s cache); the canvas summary refetches every minute.
 *
 * Keys sit under the service's and project's prefixes, so invalidating a service or
 * project also drops its metrics.
 *
 * @module
 */
import { METRICS_RANGES, type MetricsRange, metricsStep } from "@roundhouse/shared";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CHARTED_METRICS } from "../features/metrics/series";
import { metricsApi } from "../lib/api/metrics-client";

/** The API caches answers for 30 s; refetching faster only re-reads the cache. */
export const MIN_METRICS_REFRESH_MS = 30_000;

/** How often the canvas sparklines refresh (ADR 0008). */
export const SUMMARY_REFRESH_MS = 60_000;

/**
 * How often a chart over `range` refreshes: once per step, at least every 30 s.
 *
 * @param range - Range preset.
 * @returns Milliseconds.
 * @example
 * metricsRefreshMs("1h"); // 30000 (step 15 s, floored to 30 s)
 * metricsRefreshMs("24h"); // 300000
 */
export function metricsRefreshMs(range: MetricsRange): number {
  return Math.max(MIN_METRICS_REFRESH_MS, metricsStep(METRICS_RANGES[range]) * 1000);
}

/** Query keys of metrics; prefixes of the service and project keys. */
export const metricsKeys = {
  service: (serviceId: string, environmentId: string, range: MetricsRange, group: string) =>
    ["services", serviceId, "metrics", environmentId, range, group] as const,
  summary: (projectId: string, environmentId: string) =>
    ["projects", projectId, "metrics", "summary", environmentId] as const,
};

/**
 * A service's charted metrics over the last `range`, refetched as the range moves on.
 * The previous answer stays on screen while a new range or grouping loads.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @param range - Range preset, ending now.
 * @param group - One series for the service, or one per replica.
 * @returns The metrics query.
 */
export function useServiceMetrics(
  serviceId: string,
  environmentId: string | undefined,
  range: MetricsRange,
  group: "service" | "replica",
) {
  return useQuery({
    queryKey: metricsKeys.service(serviceId, environmentId ?? "", range, group),
    queryFn: ({ signal }) => {
      const to = Date.now();
      return metricsApi.service(
        serviceId,
        {
          environment_id: environmentId!,
          from: to - METRICS_RANGES[range],
          to,
          group,
          metrics: CHARTED_METRICS,
        },
        signal,
      );
    },
    enabled: Boolean(environmentId),
    refetchInterval: metricsRefreshMs(range),
    placeholderData: keepPreviousData,
  });
}

/**
 * The latest usage of every service in a project environment, for canvas sparklines.
 *
 * @param projectId - Project id.
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @returns The summary query.
 */
export function useMetricsSummary(projectId: string, environmentId: string | undefined) {
  return useQuery({
    queryKey: metricsKeys.summary(projectId, environmentId ?? ""),
    queryFn: ({ signal }) => metricsApi.summary(projectId, environmentId, signal),
    enabled: Boolean(environmentId),
    refetchInterval: SUMMARY_REFRESH_MS,
  });
}
