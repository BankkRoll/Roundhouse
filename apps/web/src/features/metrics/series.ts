/**
 * Turns a service metrics response into chart panels: which series each chart draws,
 * their labels and colours, units and limit lines.
 *
 * Whole-service view: CPU, memory, network (received and sent), disk (read and written)
 * and restarts. Per-replica view: one line per replica on CPU, memory, and each network
 * and disk direction as its own chart (small multiples rather than 2 × N lines on one);
 * restarts stay one series, summed over replicas, because a count adds up.
 *
 * @module
 */
import type { ServiceMetric } from "@roundhouse/shared";
import type { MetricPoint, ServiceMetrics } from "../../lib/api/metrics-client";
import { formatBytes, formatBytesPerSecond, formatCount, formatMillicores } from "../../lib/format";

/** Categorical series colours, in their fixed order (`--chart-N` in `index.css`). */
export const CHART_COLORS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `var(--chart-${n})`);

/** Colour of a chart's only series: the brand accent, as on meters and the canvas. */
export const PRIMARY_COLOR = "var(--accent-text)";

/** Colour of replicas past the eighth: they stay visible but recede, uncoloured. */
export const OTHER_COLOR = "var(--subtle-foreground)";

/** Metrics the Metrics tab asks for. `memory_max` and `pids` aren't charted. */
export const CHARTED_METRICS: readonly ServiceMetric[] = [
  "cpu",
  "memory",
  "net_rx",
  "net_tx",
  "disk_read",
  "disk_write",
  "restarts",
];

/** One line (or bar set) in a chart. */
export interface ChartSeries {
  /** Stable key: metric name, or metric and workload id. */
  id: string;
  label: string;
  /** CSS colour, usually a `var(--chart-N)`. */
  color: string;
  points: readonly MetricPoint[];
  /** Full workload id of a replica series, for tooltips. */
  workloadId?: string;
}

/** A horizontal reference line, such as a CPU or memory limit. */
export interface ChartLimit {
  value: number;
  label: string;
}

/** Everything one chart needs. */
export interface MetricPanel {
  id: string;
  title: string;
  kind: "line" | "bars";
  series: ChartSeries[];
  /** Formats a value for ticks, tooltips and the summary. */
  format: (value: number) => string;
  /** Round value ticks in powers of 1024. */
  binary: boolean;
  limit: ChartLimit | null;
}

/**
 * Short label of a replica: workload ids are long and only their tail tells them apart.
 *
 * @param workloadId - e.g. `"wl_01JB3K5V2Q7XTA9C3F"`.
 * @returns e.g. `"wl_…9C3F"`; short ids unchanged.
 */
export function replicaLabel(workloadId: string): string {
  if (workloadId.length <= 12) return workloadId;
  const prefix = workloadId.includes("_") ? `${workloadId.split("_")[0]}_` : "";
  return `${prefix}…${workloadId.slice(-6)}`;
}

/**
 * Sums aligned series point by point; a step is a gap only when every series has one.
 *
 * @param series - Series on the same step grid.
 * @returns One series.
 */
export function sumSeries(series: readonly (readonly MetricPoint[])[]): MetricPoint[] {
  const totals = new Map<number, number | null>();
  for (const points of series) {
    for (const [t, value] of points) {
      const current = totals.get(t) ?? null;
      totals.set(t, value === null ? current : (current ?? 0) + value);
    }
  }
  return [...totals.entries()].sort((a, b) => a[0] - b[0]);
}

const BYTES = (v: number) => formatBytes(v);
const RATE = (v: number) => formatBytesPerSecond(v);

interface PanelSpec {
  id: string;
  title: string;
  metrics: readonly { metric: ServiceMetric; label: string }[];
  format: (value: number) => string;
  binary: boolean;
  limit?: (limits: NonNullable<ServiceMetrics["limits"]>) => ChartLimit;
}

const CPU: PanelSpec = {
  id: "cpu",
  title: "CPU",
  metrics: [{ metric: "cpu", label: "CPU" }],
  format: formatMillicores,
  binary: false,
  limit: (l) => ({ value: l.cpu_millis, label: `Limit ${formatMillicores(l.cpu_millis)}` }),
};

const MEMORY: PanelSpec = {
  id: "memory",
  title: "Memory",
  metrics: [{ metric: "memory", label: "Working set" }],
  format: BYTES,
  binary: true,
  limit: (l) => ({ value: l.memory_bytes, label: `Limit ${formatBytes(l.memory_bytes)}` }),
};

const SERVICE_PANELS: readonly PanelSpec[] = [
  CPU,
  MEMORY,
  {
    id: "network",
    title: "Network",
    metrics: [
      { metric: "net_rx", label: "Received" },
      { metric: "net_tx", label: "Sent" },
    ],
    format: RATE,
    binary: true,
  },
  {
    id: "disk",
    title: "Disk",
    metrics: [
      { metric: "disk_read", label: "Read" },
      { metric: "disk_write", label: "Written" },
    ],
    format: RATE,
    binary: true,
  },
];

const REPLICA_PANELS: readonly PanelSpec[] = [
  CPU,
  MEMORY,
  {
    id: "net_rx",
    title: "Network in",
    metrics: [{ metric: "net_rx", label: "Received" }],
    format: RATE,
    binary: true,
  },
  {
    id: "net_tx",
    title: "Network out",
    metrics: [{ metric: "net_tx", label: "Sent" }],
    format: RATE,
    binary: true,
  },
  {
    id: "disk_read",
    title: "Disk read",
    metrics: [{ metric: "disk_read", label: "Read" }],
    format: RATE,
    binary: true,
  },
  {
    id: "disk_write",
    title: "Disk write",
    metrics: [{ metric: "disk_write", label: "Written" }],
    format: RATE,
    binary: true,
  },
];

function restartsPanel(data: ServiceMetrics): MetricPanel {
  const restarts = data.series.filter((s) => s.metric === "restarts");
  const points =
    restarts.length === 1 ? restarts[0]!.points : sumSeries(restarts.map((s) => s.points));
  return {
    id: "restarts",
    title: "Restarts",
    kind: "bars",
    series: [{ id: "restarts", label: "Restarts", color: PRIMARY_COLOR, points }],
    format: formatCount,
    binary: false,
    limit: null,
  };
}

/**
 * The charts of the Metrics tab for one response.
 *
 * @param data - A `GET /v1/services/{id}/metrics` response.
 * @param group - Whether `data` was asked for per replica.
 * @returns Panels in display order; restarts last.
 */
export function buildPanels(data: ServiceMetrics, group: "service" | "replica"): MetricPanel[] {
  const specs = group === "replica" ? REPLICA_PANELS : SERVICE_PANELS;
  // NOTE: Colour follows the replica, not its rank in a chart: every chart orders
  // replicas by id, so one replica wears the same colour on CPU, memory and network.
  const workloads = [
    ...new Set(data.series.map((s) => s.workload_id).filter((id): id is string => Boolean(id))),
  ].sort();
  const colorOf = (workloadId: string) =>
    CHART_COLORS[workloads.indexOf(workloadId)] ?? OTHER_COLOR;

  const panels = specs.map((spec): MetricPanel => {
    const series: ChartSeries[] = [];
    for (const { metric, label } of spec.metrics) {
      for (const s of data.series.filter((row) => row.metric === metric)) {
        series.push(
          s.workload_id
            ? {
                id: `${metric}:${s.workload_id}`,
                label: replicaLabel(s.workload_id),
                color: colorOf(s.workload_id),
                points: s.points,
                workloadId: s.workload_id,
              }
            : { id: metric, label, color: "", points: s.points },
        );
      }
    }
    const whole = series.filter((s) => !s.workloadId);
    whole.forEach((s, i) => {
      s.color = whole.length === 1 ? PRIMARY_COLOR : CHART_COLORS[i]!;
    });
    return {
      id: spec.id,
      title: spec.title,
      kind: "line",
      series,
      format: spec.format,
      binary: spec.binary,
      limit: spec.limit && data.limits ? spec.limit(data.limits) : null,
    };
  });
  return [...panels, restartsPanel(data)];
}
