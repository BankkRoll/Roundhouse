/**
 * Node helpers shared by the operator routes, the agent routes, and the
 * node's Durable Object: status derivation, API serialisation, the install
 * command, and the header that carries a node ID to its Durable Object.
 *
 * @module
 */
import type { nodes } from "@roundhouse/db";
import { type NodeStatus, OFFLINE_AFTER_MS } from "@roundhouse/shared";

type NodeRow = typeof nodes.$inferSelect;

/**
 * Header the Worker sets when forwarding an authenticated agent upgrade to the
 * node's Durable Object. Only the Worker can reach the object, so it is trusted there.
 */
export const NODE_ID_HEADER = "x-roundhouse-node-id";

/**
 * The status to show for a node. The Durable Object alarm normally flips
 * stale nodes to `offline`, but if an alarm is delayed the API still mustn't
 * report a silent node as online.
 *
 * @param node - Stored node row.
 * @param now - Current time, unix ms.
 * @returns Status after accounting for heartbeat staleness.
 */
export function effectiveStatus(node: NodeRow, now = Date.now()): NodeStatus {
  const live = node.status === "online" || node.status === "degraded";
  const last = node.lastHeartbeatAt ? +node.lastHeartbeatAt : 0;
  if (live && now - last > OFFLINE_AFTER_MS) return "offline";
  return node.status;
}

/**
 * Serialises a node row for the public API. Never includes credentials.
 *
 * @param node - Stored node row.
 * @param now - Current time, unix ms.
 * @returns The API representation.
 */
export function toApiNode(node: NodeRow, now = Date.now()) {
  return {
    id: node.id,
    name: node.name,
    hostname: node.hostname,
    status: effectiveStatus(node, now),
    provider: node.provider,
    region: node.region,
    provider_server_id: node.providerServerId,
    provider_server_missing_at: node.providerServerMissingAt ? +node.providerServerMissingAt : null,
    public_ip: node.publicIp,
    os: node.os,
    arch: node.arch,
    kernel: node.kernel,
    docker_version: node.dockerVersion,
    agent_version: node.agentVersion,
    capabilities: node.capabilities,
    cpu_total: node.cpuTotal,
    mem_total: node.memTotal,
    disk_total: node.diskTotal,
    cpu_percent: node.cpuPercent,
    mem_used: node.memUsed,
    disk_used: node.diskUsed,
    load1: node.load1,
    last_heartbeat_at: node.lastHeartbeatAt ? +node.lastHeartbeatAt : null,
    created_at: +node.createdAt,
  };
}

/**
 * Builds the one-line install command shown to operators.
 *
 * @param origin - Control plane origin.
 * @param token - Plaintext join token.
 * @returns A `curl … | sudo bash` command line.
 */
export function installCommand(origin: string, token: string): string {
  return `curl -fsSL ${origin}/install.sh | sudo bash -s -- --token ${token}`;
}

/**
 * Whether an origin is safe to paste into a shell script: scheme, a DNS-style
 * host, and an optional port, with no characters a shell would interpret.
 *
 * @param origin - E.g. `https://cp.example.com`.
 * @returns `true` when the origin can be substituted into the script verbatim.
 */
export function isShellSafeOrigin(origin: string): boolean {
  return /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(origin);
}
