/**
 * The metrics data model of ADR 0008, shared by the writer (the node Durable
 * Object), the stores that answer queries, and the dashboard.
 *
 * Responsibilities:
 * - the fixed column layout of one Analytics Engine data point (and of the
 *   D1 fallback table, which mirrors it), for container and node rows;
 * - the metric names the query API serves and how each is aggregated;
 * - the step chosen for a time range, which keeps every chart at
 *   {@link MAX_METRIC_POINTS} points or fewer.
 *
 * IMPORTANT: the layout is append-only. Analytics Engine rows are positional
 * (`blob1`, `double3`, …) and kept for 3 months, so reordering a column would
 * silently reinterpret old data. New fields take the next free slot.
 *
 * @module
 */

/** Dataset every row is written to (`wrangler.jsonc`, binding `METRICS`). */
export const METRICS_DATASET = "roundhouse_metrics";

/** Kinds of rows in the dataset, stored in `blob1`. */
export const METRIC_ROW_KINDS = ["container", "node"] as const;

/** A row kind. */
export type MetricRowKind = (typeof METRIC_ROW_KINDS)[number];

/**
 * Blob columns, in order (`blob1` first). Container rows fill every one;
 * node rows only `kind`, `workspace_id` and `node_id`. `source` (appended
 * after ADR 0008's table) is the agent's `metrics.source`, so a chart can
 * say "approximate (cgroup v1)".
 */
export const METRIC_BLOBS = [
  "kind",
  "workspace_id",
  "project_id",
  "environment_id",
  "service_id",
  "deployment_id",
  "workload_id",
  "node_id",
  "source",
] as const;

/** Double columns of a container row, in order (`double1` first). */
export const CONTAINER_DOUBLES = [
  "cpu_millis",
  "cpu_limit_millis",
  "mem_bytes",
  "mem_limit_bytes",
  "net_rx_bytes",
  "net_tx_bytes",
  "disk_read_bytes",
  "disk_write_bytes",
  "pids",
  "restarts",
  "interval_s",
] as const;

/**
 * Double columns of a node row, in order. The slots the node has nothing
 * for stay 0 so that `interval_s` lines up with container rows.
 */
export const NODE_DOUBLES = [
  "cpu_percent",
  "_unused2",
  "mem_used_bytes",
  "mem_total_bytes",
  "_unused5",
  "_unused6",
  "_unused7",
  "_unused8",
  "disk_used_bytes",
  "load1",
  "interval_s",
] as const;

/** Column name (`blob3`, `double7`) of a blob or double, by its name in the layout. */
export function metricColumn(
  kind: "blob" | "double",
  name:
    | (typeof METRIC_BLOBS)[number]
    | (typeof CONTAINER_DOUBLES)[number]
    | (typeof NODE_DOUBLES)[number],
): string {
  const list: readonly string[] =
    kind === "blob"
      ? METRIC_BLOBS
      : (CONTAINER_DOUBLES as readonly string[]).includes(name)
        ? CONTAINER_DOUBLES
        : NODE_DOUBLES;
  const i = list.indexOf(name);
  if (i < 0) throw new Error(`no ${kind} column named ${name}`);
  return `${kind}${i + 1}`;
}

// -----------------------------------------------------------------------------
// Query model
// -----------------------------------------------------------------------------

/**
 * Container metrics the query API serves:
 * - `cpu`: average millicores;
 * - `memory`: average working set, bytes; `memory_max`: its peak in the step;
 * - `net_rx`, `net_tx`, `disk_read`, `disk_write`: bytes per second;
 * - `restarts`: restarts in the step; `pids`: average process count.
 */
export const SERVICE_METRICS = [
  "cpu",
  "memory",
  "memory_max",
  "net_rx",
  "net_tx",
  "disk_read",
  "disk_write",
  "restarts",
  "pids",
] as const;

/** A container metric. */
export type ServiceMetric = (typeof SERVICE_METRICS)[number];

/** Node metrics: CPU percent, memory and disk bytes used, and load average. */
export const NODE_METRICS = ["cpu_percent", "memory", "disk", "load1"] as const;

/** A node metric. */
export type NodeMetric = (typeof NODE_METRICS)[number];

/** How a metric's samples combine into one point per step. */
export type MetricAggregate =
  /** Mean weighted by Analytics Engine's `_sample_interval`. */
  | "avg"
  /** Largest sample in the step. */
  | "max"
  /** Byte counters: sum over the step divided by the step, so bytes per second. */
  | "rate"
  /** Event counters: sum over the step. */
  | "sum";

/** Source column and aggregate of each container metric. */
export const SERVICE_METRIC_COLUMNS: Record<
  ServiceMetric,
  { column: (typeof CONTAINER_DOUBLES)[number]; aggregate: MetricAggregate }
> = {
  cpu: { column: "cpu_millis", aggregate: "avg" },
  memory: { column: "mem_bytes", aggregate: "avg" },
  memory_max: { column: "mem_bytes", aggregate: "max" },
  net_rx: { column: "net_rx_bytes", aggregate: "rate" },
  net_tx: { column: "net_tx_bytes", aggregate: "rate" },
  disk_read: { column: "disk_read_bytes", aggregate: "rate" },
  disk_write: { column: "disk_write_bytes", aggregate: "rate" },
  restarts: { column: "restarts", aggregate: "sum" },
  pids: { column: "pids", aggregate: "avg" },
};

/** Source column and aggregate of each node metric. */
export const NODE_METRIC_COLUMNS: Record<
  NodeMetric,
  { column: (typeof NODE_DOUBLES)[number]; aggregate: MetricAggregate }
> = {
  cpu_percent: { column: "cpu_percent", aggregate: "avg" },
  memory: { column: "mem_used_bytes", aggregate: "avg" },
  disk: { column: "disk_used_bytes", aggregate: "avg" },
  load1: { column: "load1", aggregate: "avg" },
};

/** Most points one series returns; {@link metricsStep} keeps ranges under it. */
export const MAX_METRIC_POINTS = 360;

/** Longest range a metrics query may cover: Analytics Engine keeps 3 months. */
export const MAX_METRICS_RANGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Range of a query when the caller names none. */
export const DEFAULT_METRICS_RANGE_MS = 60 * 60 * 1000;

/**
 * Most replicas a `group=replica` query returns series for. Bounds the
 * response (and the SQL `GROUP BY`) whatever a service's replica history.
 */
export const MAX_REPLICA_SERIES = 32;

/** How long the D1 fallback keeps samples (ADR 0008, "short retention"). */
export const D1_METRICS_RETENTION_MS = 48 * 60 * 60 * 1000;

/** Steps by range, longest range last: ≤ 1 h → 15 s … ≤ 90 d → 6 h. */
const STEPS: readonly (readonly [maxRangeMs: number, stepS: number])[] = [
  [60 * 60 * 1000, 15],
  [6 * 60 * 60 * 1000, 60],
  [24 * 60 * 60 * 1000, 300],
  [7 * 24 * 60 * 60 * 1000, 1800],
  [30 * 24 * 60 * 60 * 1000, 7200],
  [MAX_METRICS_RANGE_MS, 21600],
];

/**
 * The step of a chart over a range (ADR 0008, "Resolution").
 *
 * @param rangeMs - `to - from`, positive.
 * @returns Step in seconds; never yields more than {@link MAX_METRIC_POINTS} points.
 * @example
 * metricsStep(60 * 60 * 1000); // 15
 * metricsStep(24 * 60 * 60 * 1000); // 300
 */
export function metricsStep(rangeMs: number): number {
  for (const [max, step] of STEPS) if (rangeMs <= max) return step;
  return STEPS[STEPS.length - 1]![1];
}

/** Range presets the dashboard and the CLI offer, by label. */
export const METRICS_RANGES = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
} as const;

/** A range preset label. */
export type MetricsRange = keyof typeof METRICS_RANGES;
