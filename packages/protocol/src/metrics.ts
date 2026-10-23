/**
 * Per-container metrics (ADR 0008), from `METRICS_PROTOCOL_VERSION`. The
 * agent samples each managed container's cgroup every
 * `welcome.metrics_interval_ms` (15 s nominal) and sends one `metrics` frame
 * per sample, at most one per second, and only when the control plane asked
 * for them in `welcome`. Mirrored by `go/metrics.go`.
 *
 * @module
 */
import { z } from "zod";
import { Count, IdString, MAX_METRIC_SAMPLES, UnixMillis } from "./limits";

/** Shortest `welcome.metrics_interval_ms` (and frame interval) the agent honours. */
export const MIN_METRICS_INTERVAL_MS = 1000;

/** Longest `welcome.metrics_interval_ms`. */
export const MAX_METRICS_INTERVAL_MS = 300_000;

/**
 * Where the numbers come from: cgroup v2 files, or Docker's one-shot stats
 * on cgroup v1 hosts, which the dashboard marks "approximate".
 */
export const METRICS_SOURCES = ["cgroup_v2", "docker_stats"] as const;

/**
 * One container's sample. Rates and counters are deltas over the interval;
 * the first sample after a container starts carries 0 for each of them.
 */
export const ContainerSampleSchema = z.object({
  workload_id: IdString,
  /** Average millicores over the interval (Δ `cpu.stat usage_usec` / Δt). */
  cpu_millis: Count,
  /** Working set at sample time: `memory.current` − `inactive_file`. */
  mem_bytes: Count,
  /** `memory.max`, or the node's total when unlimited. */
  mem_limit_bytes: Count,
  /** Bytes in the interval, every interface except `lo`. */
  net_rx_bytes: Count,
  net_tx_bytes: Count,
  /** Bytes in the interval, `io.stat rbytes`/`wbytes` summed. */
  disk_read_bytes: Count,
  disk_write_bytes: Count,
  /** `pids.current`. */
  pids: Count,
  /** Restarts in the interval. */
  restarts: Count,
});

/** One container's sample. */
export type ContainerSample = z.infer<typeof ContainerSampleSchema>;

/** One sampling pass over every managed container. */
export const MetricsSchema = z.object({
  type: z.literal("metrics"),
  /** Sample time, unix ms. */
  ts: UnixMillis,
  /** Actual interval the deltas cover. */
  interval_ms: z.number().int().min(MIN_METRICS_INTERVAL_MS).max(MAX_METRICS_INTERVAL_MS),
  source: z.enum(METRICS_SOURCES),
  samples: z
    .array(ContainerSampleSchema)
    .min(1)
    .max(MAX_METRIC_SAMPLES)
    .refine((ss) => new Set(ss.map((s) => s.workload_id)).size === ss.length, {
      message: "duplicate workload",
    }),
});

/** One sampling pass over every managed container. */
export type Metrics = z.infer<typeof MetricsSchema>;
