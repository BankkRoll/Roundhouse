/**
 * Runs the metrics queries the routes need and shapes their rows into
 * series: one point per step across the whole range (`null` where no
 * sample landed), replicas summed into a service series or kept apart.
 *
 * @module
 */
import {
  MAX_METRIC_POINTS,
  MAX_REPLICA_SERIES,
  metricsStep,
  NODE_METRIC_COLUMNS,
  type NodeMetric,
  SERVICE_METRIC_COLUMNS,
  type ServiceMetric,
} from "@roundhouse/shared";
import type { MetricsResultRow, MetricsStore } from "./store";

/** `[t_ms, value]`. */
export type Point = [number, number | null];

/** One series. */
export interface Series {
  metric: string;
  workload_id?: string;
  points: Point[];
}

/** A range aligned to its step, unix seconds. */
export interface AlignedRange {
  from: number;
  to: number;
  stepS: number;
}

/**
 * Picks the step for `[fromMs, toMs)` and aligns both ends to it, so the
 * same range asked twice within a step is the same query (and cache key).
 *
 * @param fromMs - Range start, unix ms.
 * @param toMs - Range end, unix ms; after `fromMs`.
 * @returns The aligned range in seconds, at most `MAX_METRIC_POINTS` steps long.
 */
export function alignRange(fromMs: number, toMs: number): AlignedRange {
  const stepS = metricsStep(toMs - fromMs);
  const to = Math.ceil(toMs / 1000 / stepS) * stepS;
  let from = Math.floor(fromMs / 1000 / stepS) * stepS;
  if ((to - from) / stepS > MAX_METRIC_POINTS) from = to - MAX_METRIC_POINTS * stepS;
  return { from, to, stepS };
}

function emptyPoints(range: AlignedRange): Point[] {
  const out: Point[] = [];
  for (let t = range.from; t < range.to; t += range.stepS) out.push([t * 1000, null]);
  return out;
}

function slot(range: AlignedRange, t: number): number {
  const i = Math.floor((t - range.from) / range.stepS);
  return i >= 0 && i < (range.to - range.from) / range.stepS ? i : -1;
}

/**
 * Adds a row's value into a points array: replicas add up, and a step
 * with any value is no longer a gap.
 */
function accumulate(points: Point[], i: number, v: number | null) {
  if (i < 0 || v === null) return;
  const p = points[i]!;
  p[1] = (p[1] ?? 0) + v;
}

/** What {@link serviceSeries} returns besides the series. */
export interface ServiceSeriesResult {
  series: Series[];
  approximate: boolean;
}

/**
 * A service's series in one environment.
 *
 * @param store - The metrics store.
 * @param scope - Workspace, service and environment, already authorized.
 * @param range - Aligned range.
 * @param metrics - Metrics to return, in order.
 * @param group - `service` sums replicas; `replica` keeps the
 *   {@link MAX_REPLICA_SERIES} most recently seen apart.
 * @returns The series and whether any sample was approximate.
 */
export async function serviceSeries(
  store: MetricsStore,
  scope: { workspaceId: string; serviceId: string; environmentId: string },
  range: AlignedRange,
  metrics: readonly ServiceMetric[],
  group: "service" | "replica",
): Promise<ServiceSeriesResult> {
  const rows = await store.run({
    kind: "container",
    filters: {
      index: scope.serviceId,
      workspace_id: scope.workspaceId,
      environment_id: scope.environmentId,
    },
    from: range.from,
    to: range.to,
    stepS: range.stepS,
    columns: metrics.map((m) => SERVICE_METRIC_COLUMNS[m]),
    byWorkload: true,
    withSource: true,
  });
  const approximate = rows.some((r) => r.approx);
  if (group === "service") {
    const series = metrics.map((metric) => ({ metric, points: emptyPoints(range) }));
    for (const r of rows) {
      const i = slot(range, r.t);
      for (const [m, v] of r.values.entries()) accumulate(series[m]!.points, i, v);
    }
    return { series, approximate };
  }

  const lastSeen = new Map<string, number>();
  for (const r of rows) {
    if (r.workload) lastSeen.set(r.workload, Math.max(lastSeen.get(r.workload) ?? 0, r.t));
  }
  const workloads = [...lastSeen.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_REPLICA_SERIES)
    .map(([w]) => w)
    .sort();
  const byWorkload = new Map(
    workloads.map((w) => [w, metrics.map(() => emptyPoints(range))] as const),
  );
  for (const r of rows) {
    const points = r.workload ? byWorkload.get(r.workload) : undefined;
    if (!points) continue;
    const i = slot(range, r.t);
    for (const [m, v] of r.values.entries()) accumulate(points[m]!, i, v);
  }
  const series: Series[] = [];
  for (const [m, metric] of metrics.entries()) {
    for (const w of workloads) {
      series.push({ metric, workload_id: w, points: byWorkload.get(w)![m]! });
    }
  }
  return { series, approximate };
}

/**
 * A node's series.
 *
 * @param store - The metrics store.
 * @param scope - Workspace and node, already authorized.
 * @param range - Aligned range.
 * @param metrics - Metrics to return, in order.
 * @returns One series per metric.
 */
export async function nodeSeries(
  store: MetricsStore,
  scope: { workspaceId: string; nodeId: string },
  range: AlignedRange,
  metrics: readonly NodeMetric[],
): Promise<Series[]> {
  const rows = await store.run({
    kind: "node",
    filters: { index: scope.nodeId, workspace_id: scope.workspaceId },
    from: range.from,
    to: range.to,
    stepS: range.stepS,
    columns: metrics.map((m) => NODE_METRIC_COLUMNS[m]),
  });
  const series = metrics.map((metric) => ({ metric, points: emptyPoints(range) }));
  for (const r of rows) {
    const i = slot(range, r.t);
    r.values.forEach((v, m) => {
      if (i >= 0 && v !== null) series[m]!.points[i]![1] = v;
    });
  }
  return series;
}

/** One service's summary. */
export interface ServiceSummary {
  service_id: string;
  cpu_millis: number | null;
  mem_bytes: number | null;
  cpu_limit_millis: number | null;
  mem_limit_bytes: number | null;
  cpu: Point[];
  memory: Point[];
}

/** Range of a summary's sparklines: the last hour. */
export const SUMMARY_RANGE_MS = 60 * 60 * 1000;

/** Step of a summary's sparklines and of its "latest" average. */
export const SUMMARY_STEP_S = 300;

/**
 * The latest 5-minute averages and an hour of sparkline for each service.
 *
 * @param store - The metrics store.
 * @param scope - Workspace, project and environment, already authorized.
 * @param serviceIds - The project's live services; others are ignored.
 * @param now - Unix ms.
 * @returns One summary per service, in `serviceIds` order.
 */
export async function projectSummary(
  store: MetricsStore,
  scope: { workspaceId: string; projectId: string; environmentId: string },
  serviceIds: readonly string[],
  now: number,
): Promise<ServiceSummary[]> {
  const to = Math.ceil(now / 1000 / SUMMARY_STEP_S) * SUMMARY_STEP_S;
  const range: AlignedRange = { from: to - SUMMARY_RANGE_MS / 1000, to, stepS: SUMMARY_STEP_S };
  const rows: MetricsResultRow[] = serviceIds.length
    ? await store.run({
        kind: "container",
        filters: {
          workspace_id: scope.workspaceId,
          project_id: scope.projectId,
          environment_id: scope.environmentId,
        },
        from: range.from,
        to: range.to,
        stepS: range.stepS,
        columns: [
          { column: "cpu_millis", aggregate: "avg" },
          { column: "mem_bytes", aggregate: "avg" },
          { column: "cpu_limit_millis", aggregate: "avg" },
          { column: "mem_limit_bytes", aggregate: "avg" },
        ],
        byService: true,
        byWorkload: true,
      })
    : [];
  const wanted = new Set(serviceIds);
  const acc = new Map(
    serviceIds.map((id) => [id, [0, 1, 2, 3].map(() => emptyPoints(range))] as const),
  );
  for (const r of rows) {
    if (!r.service || !wanted.has(r.service)) continue;
    const i = slot(range, r.t);
    for (const [m, v] of r.values.entries()) accumulate(acc.get(r.service!)![m]!, i, v);
  }
  return serviceIds.map((id) => {
    const [cpu, mem, cpuLimit, memLimit] = acc.get(id)!;
    const last = [...cpu!.keys()]
      .reverse()
      .find((i) => cpu![i]![1] !== null || mem![i]![1] !== null);
    const at = (p: Point[]) => (last === undefined ? null : p[last]![1]);
    return {
      service_id: id,
      cpu_millis: at(cpu!),
      mem_bytes: at(mem!),
      cpu_limit_millis: at(cpuLimit!),
      mem_limit_bytes: at(memLimit!),
      cpu: cpu!,
      memory: mem!,
    };
  });
}
