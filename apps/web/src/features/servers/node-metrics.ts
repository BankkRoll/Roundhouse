/**
 * Derives display values from raw node records: meter rows, sublines and fleet totals.
 *
 * @module
 */
import type { MeterRowProps } from "@roundhouse/ui";
import type { Node } from "../../lib/api/types";
import { EMPTY, formatBytesPair, formatPercent, percentOf } from "../../lib/format";

/**
 * CPU meter text, e.g. `"38% · 3.0/8 vCPU"`.
 *
 * @param node - Node record.
 * @returns Display text, or {@link EMPTY} before the first heartbeat.
 */
export function cpuValue(node: Pick<Node, "cpu_percent" | "cpu_total">): string {
  if (node.cpu_percent === null) return EMPTY;
  const percent = formatPercent(node.cpu_percent);
  if (!node.cpu_total) return percent;
  const used = ((node.cpu_percent / 100) * node.cpu_total).toFixed(1);
  return `${percent} · ${used}/${node.cpu_total} vCPU`;
}

/**
 * Memory or disk meter text, e.g. `"71% · 11.4/16 GB"`.
 *
 * @param used - Bytes used.
 * @param total - Bytes total.
 * @returns Display text, or {@link EMPTY} when usage is unknown.
 */
export function bytesValue(used: number | null, total: number | null): string {
  const percent = percentOf(used, total);
  if (percent === null) return EMPTY;
  return `${formatPercent(percent)} · ${formatBytesPair(used, total)}`;
}

/**
 * CPU, RAM and disk meter rows for a node.
 *
 * @param node - Node record.
 * @returns Rows for {@link MeterRowProps}-based components.
 */
export function nodeMeterRows(node: Node): MeterRowProps[] {
  return [
    {
      label: "CPU",
      percent: node.cpu_percent,
      value: cpuValue(node),
      meterLabel: `${node.name} CPU usage`,
    },
    {
      label: "RAM",
      percent: percentOf(node.mem_used, node.mem_total),
      value: bytesValue(node.mem_used, node.mem_total),
      meterLabel: `${node.name} memory usage`,
    },
    {
      label: "Disk",
      percent: percentOf(node.disk_used, node.disk_total),
      value: bytesValue(node.disk_used, node.disk_total),
      meterLabel: `${node.name} disk usage`,
    },
  ];
}

/**
 * Mono subline for a server card: `"<provider/os> · <region or hostname>"`.
 *
 * @param node - Node record.
 * @returns e.g. `"hetzner/linux · hel-1"`, or `"server"` for a node that never reported.
 */
export function nodeSubtitle(node: Node): string {
  const platform = [node.provider, node.os].filter(Boolean).join("/");
  const place = node.region ?? node.hostname ?? node.public_ip;
  return place ? `${platform} · ${place}` : platform;
}

/** Aggregate health and capacity of a workspace's servers. */
export interface FleetSummary {
  total: number;
  online: number;
  offline: number;
  /** Nodes degraded, draining or in maintenance. */
  attention: number;
  pending: number;
  /** Sum of `mem_used` over nodes that have reported. */
  memUsed: number;
  /** Sum of `mem_total` over the same nodes. */
  memTotal: number;
  /** `memUsed / memTotal` as 0-100, or `null` when nothing has reported yet. */
  memPercent: number | null;
}

/**
 * Summarises a fleet for the home stat card and the servers header.
 *
 * @param nodes - All nodes in the workspace.
 * @returns Counts by status and aggregate RAM.
 */
export function summarizeFleet(nodes: readonly Node[]): FleetSummary {
  let memUsed = 0;
  let memTotal = 0;
  const count = (predicate: (node: Node) => boolean) => nodes.filter(predicate).length;
  for (const node of nodes) {
    if (node.mem_used !== null && node.mem_total) {
      memUsed += node.mem_used;
      memTotal += node.mem_total;
    }
  }
  return {
    total: nodes.length,
    online: count((node) => node.status === "online"),
    offline: count((node) => node.status === "offline"),
    attention: count(
      (node) =>
        node.status === "degraded" || node.status === "draining" || node.status === "maintenance",
    ),
    pending: count((node) => node.status === "pending"),
    memUsed,
    memTotal,
    memPercent: percentOf(memUsed, memTotal),
  };
}

/**
 * Header subline for the servers page, e.g. `"3 servers · all reachable"`.
 *
 * @param summary - Output of {@link summarizeFleet}.
 * @returns The subline text.
 */
export function fleetHeadline(summary: FleetSummary): string {
  const servers = `${summary.total} ${summary.total === 1 ? "server" : "servers"}`;
  if (summary.total === 0) return "0 servers";
  const notes: string[] = [];
  if (summary.offline > 0) notes.push(`${summary.offline} offline`);
  if (summary.attention > 0) notes.push(`${summary.attention} need attention`);
  if (summary.pending > 0) notes.push(`${summary.pending} pending`);
  return `${servers} · ${notes.length > 0 ? notes.join(" · ") : "all reachable"}`;
}
