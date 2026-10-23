/**
 * Turns agent samples into rows of the `roundhouse_metrics` layout
 * (`@roundhouse/shared` `metrics-layout.ts`) and writes them: always to
 * Analytics Engine when the binding exists, and to the D1 fallback table
 * when that is the store answering queries.
 *
 * SECURITY: rows hold IDs and numbers only. Nothing an agent sends as free
 * text (log lines, messages, command lines) has a column here.
 *
 * @module
 */
import type { ContainerSample, Heartbeat, Metrics } from "@roundhouse/protocol";
import { CONTAINER_DOUBLES, METRIC_BLOBS, NODE_DOUBLES } from "@roundhouse/shared";
import type { Env } from "../../env";
import { metricsBackend } from "./backend";

/** Who a container sample belongs to, resolved from this node's placements. */
export interface SampleOwner {
  workspaceId: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  deploymentId: string;
  /** The deployment's configured CPU limit, millicores. */
  cpuLimitMillis: number;
}

/** One data point in the dataset's layout. */
export interface MetricRow {
  index: string;
  /** Unix ms; Analytics Engine stamps its own write time, D1 stores this. */
  timestamp: number;
  blobs: string[];
  doubles: number[];
}

/** Analytics Engine's per-invocation cap on `writeDataPoint` calls. */
export const MAX_POINTS_PER_INVOCATION = 250;

/**
 * The row of one container sample.
 *
 * @param owner - The sample's owners.
 * @param sample - From the agent's `metrics` frame.
 * @param frame - The frame, for its time, interval and source.
 * @param nodeId - The reporting node.
 * @returns The row; blobs and doubles in layout order.
 */
export function containerRow(
  owner: SampleOwner,
  sample: ContainerSample,
  frame: Pick<Metrics, "ts" | "interval_ms" | "source">,
  nodeId: string,
): MetricRow {
  const blobs: Record<(typeof METRIC_BLOBS)[number], string> = {
    kind: "container",
    workspace_id: owner.workspaceId,
    project_id: owner.projectId,
    environment_id: owner.environmentId,
    service_id: owner.serviceId,
    deployment_id: owner.deploymentId,
    workload_id: sample.workload_id,
    node_id: nodeId,
    source: frame.source,
  };
  const doubles: Record<(typeof CONTAINER_DOUBLES)[number], number> = {
    cpu_millis: sample.cpu_millis,
    cpu_limit_millis: owner.cpuLimitMillis,
    mem_bytes: sample.mem_bytes,
    mem_limit_bytes: sample.mem_limit_bytes,
    net_rx_bytes: sample.net_rx_bytes,
    net_tx_bytes: sample.net_tx_bytes,
    disk_read_bytes: sample.disk_read_bytes,
    disk_write_bytes: sample.disk_write_bytes,
    pids: sample.pids,
    restarts: sample.restarts,
    interval_s: frame.interval_ms / 1000,
  };
  return {
    index: owner.serviceId,
    timestamp: frame.ts,
    blobs: METRIC_BLOBS.map((b) => blobs[b]),
    doubles: CONTAINER_DOUBLES.map((d) => doubles[d]),
  };
}

/**
 * The row of one node heartbeat.
 *
 * @param nodeId - The node.
 * @param workspaceId - Its workspace.
 * @param hb - The heartbeat.
 * @param intervalS - Heartbeat interval, seconds.
 * @returns The row.
 */
export function nodeRow(
  nodeId: string,
  workspaceId: string,
  hb: Heartbeat,
  intervalS: number,
): MetricRow {
  const doubles: Partial<Record<(typeof NODE_DOUBLES)[number], number>> = {
    cpu_percent: hb.usage.cpu_percent,
    mem_used_bytes: hb.usage.mem_used_bytes,
    mem_total_bytes: hb.usage.mem_total_bytes,
    disk_used_bytes: hb.usage.disk_used_bytes,
    load1: hb.usage.load1,
    interval_s: intervalS,
  };
  return {
    index: nodeId,
    timestamp: hb.ts,
    blobs: METRIC_BLOBS.map((b) =>
      b === "kind" ? "node" : b === "workspace_id" ? workspaceId : b === "node_id" ? nodeId : "",
    ),
    doubles: NODE_DOUBLES.map((d) => doubles[d] ?? 0),
  };
}

const D1_INSERT = `INSERT INTO metrics_samples (index1, timestamp, ${METRIC_BLOBS.map((_, i) => `blob${i + 1}`).join(", ")}, ${CONTAINER_DOUBLES.map((_, i) => `double${i + 1}`).join(", ")})
SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), ${METRIC_BLOBS.map((_, i) => `json_extract(value, '$[2][${i}]')`).join(", ")}, ${CONTAINER_DOUBLES.map((_, i) => `json_extract(value, '$[3][${i}]')`).join(", ")}
FROM json_each(?)`;

/**
 * Writes rows to Analytics Engine (when bound) and, when D1 is the active
 * store, to `metrics_samples`.
 *
 * PERF: the D1 insert is one statement per call: the rows travel as one
 * JSON parameter and `json_each` expands them, so a 160-sample frame costs
 * one write instead of 40 (D1 binds at most 100 parameters per statement).
 *
 * @param env - Worker bindings.
 * @param rows - At most {@link MAX_POINTS_PER_INVOCATION}.
 */
export async function writeMetricRows(env: Env, rows: readonly MetricRow[]): Promise<void> {
  if (!rows.length) return;
  if (rows.length > MAX_POINTS_PER_INVOCATION) {
    throw new Error(`${rows.length} metric rows exceed the per-invocation cap`);
  }
  if (env.METRICS) {
    for (const r of rows) {
      env.METRICS.writeDataPoint({ indexes: [r.index], blobs: r.blobs, doubles: r.doubles });
    }
  }
  if (metricsBackend(env) === "d1") {
    const payload = JSON.stringify(rows.map((r) => [r.index, r.timestamp, r.blobs, r.doubles]));
    await env.DB.prepare(D1_INSERT).bind(payload).run();
  }
}
