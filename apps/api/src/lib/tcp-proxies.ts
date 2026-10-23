/**
 * TCP proxies (ADR 0004, "TCP proxy"): a single-replica service's port
 * published on its node, reachable only from an explicit source allowlist
 * that the node enforces in its firewall before the port is published.
 *
 * Responsibilities:
 * - validating and normalising an allowlist ({@link normalizeAllowlist});
 * - allocating a public port, unique across the instance, so a service keeps
 *   it wherever it is placed ({@link allocatePublicPort});
 * - what a node's desired state publishes ({@link tcpProxiesFor}), and the
 *   replica rule ({@link hasTcpProxy});
 * - the API shape with the node's host and whether the node enforces it
 *   ({@link presentTcpProxy}).
 *
 * SECURITY: the control plane sends `ports[].publish` only to nodes whose
 * agent advertises `capabilities.tcp_proxy`. An agent without it would
 * refuse the workload; one that ignored the allowlist must never get a
 * published port.
 *
 * @module
 */
import {
  type Db,
  deployments,
  nodes,
  placements,
  type services,
  tcpProxies,
} from "@roundhouse/db";
import { isCidr, isIPv4 } from "@roundhouse/protocol";
import { MAX_TCP_PROXY_CIDRS, TCP_PROXY_PORT_RANGE } from "@roundhouse/shared";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { LIVE_DEPLOYMENT_STATUSES } from "./desired-state";
import { ApiError, conflict } from "./errors";

/** A `tcp_proxies` row. */
export type TcpProxyRow = typeof tcpProxies.$inferSelect;

/** How many random ports {@link allocatePublicPort} tries before scanning. */
const RANDOM_PORT_TRIES = 8;

/** Whether an allowlist entry admits every address. */
export function isOpenCidr(cidr: string): boolean {
  return cidr.endsWith("/0");
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
}

function intToIpv4(n: number): string {
  return [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
}

/**
 * Validates an allowlist and normalises it: a bare address becomes a /32,
 * host bits are cleared, duplicates are dropped, and the order is kept.
 *
 * IPv6 sources are refused for now: the node publishes on IPv4 only, so an
 * IPv6 entry would silently admit nothing.
 *
 * @param input - Entries as the caller sent them.
 * @param acknowledgeOpen - Whether the caller confirmed admitting every address.
 * @returns The normalised list.
 * @throws {ApiError} 422 for an invalid or IPv6 entry, or an unacknowledged `/0`.
 * @example
 * normalizeAllowlist(["203.0.113.7", "10.1.2.3/8"], false); // ["203.0.113.7/32", "10.0.0.0/8"]
 */
export function normalizeAllowlist(input: readonly string[], acknowledgeOpen: boolean): string[] {
  const out: string[] = [];
  const invalid: string[] = [];
  for (const raw of input) {
    const entry = raw.trim();
    const cidr = isIPv4(entry) ? `${entry}/32` : entry;
    if (!isCidr(cidr)) {
      invalid.push(raw);
      continue;
    }
    const [addr, bits] = cidr.split("/") as [string, string];
    if (!isIPv4(addr)) {
      throw new ApiError(
        422,
        "invalid_request",
        `${raw}: IPv6 sources aren't supported yet; the port is published on IPv4 only`,
      );
    }
    const size = 2 ** (32 - Number(bits));
    const base = intToIpv4(Math.floor(ipv4ToInt(addr) / size) * size);
    const normalized = `${base}/${bits}`;
    if (!out.includes(normalized)) out.push(normalized);
  }
  if (invalid.length) {
    throw new ApiError(
      422,
      "invalid_request",
      `Not an IPv4 address or CIDR block: ${invalid.slice(0, 5).join(", ")}`,
      invalid.map((v) => ({ field: "allowed_cidrs", code: "invalid_cidr", message: v })),
    );
  }
  if (out.length > MAX_TCP_PROXY_CIDRS) {
    throw new ApiError(422, "invalid_request", `At most ${MAX_TCP_PROXY_CIDRS} sources`);
  }
  if (out.some(isOpenCidr) && !acknowledgeOpen) {
    throw new ApiError(
      422,
      "confirmation_required",
      "0.0.0.0/0 opens the port to the whole internet, unencrypted unless the client and the database negotiate TLS; send acknowledge_open to continue",
    );
  }
  return out;
}

/**
 * Picks a free public port in {@link TCP_PROXY_PORT_RANGE}: a few random
 * tries, then a scan. The unique index on `public_port` settles races; the
 * caller retries an insert that loses one.
 *
 * @param db - Database client.
 * @param random - Randomness in [0, 1), for tests.
 * @returns A port no proxy uses.
 * @throws {ApiError} 409 `tcp_proxy_ports_exhausted` when the range is full.
 */
export async function allocatePublicPort(db: Db, random = Math.random): Promise<number> {
  const used = new Set(
    (await db.select({ port: tcpProxies.publicPort }).from(tcpProxies)).map((r) => r.port),
  );
  const { min, max } = TCP_PROXY_PORT_RANGE;
  for (let i = 0; i < RANDOM_PORT_TRIES; i++) {
    const port = min + Math.floor(random() * (max - min + 1));
    if (!used.has(port)) return port;
  }
  for (let port = min; port <= max; port++) {
    if (!used.has(port)) return port;
  }
  throw new ApiError(
    409,
    "tcp_proxy_ports_exhausted",
    `Every port from ${min} to ${max} is published already`,
  );
}

/**
 * The service's proxy in an environment.
 *
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @returns The row, or `undefined`.
 */
export async function tcpProxyOf(
  db: Db,
  serviceId: string,
  environmentId: string,
): Promise<TcpProxyRow | undefined> {
  const [row] = await db
    .select()
    .from(tcpProxies)
    .where(and(eq(tcpProxies.serviceId, serviceId), eq(tcpProxies.environmentId, environmentId)))
    .limit(1);
  return row;
}

/**
 * Whether the service publishes a port in any environment; such a service
 * runs one replica, since one host port can't be published twice.
 *
 * @param db - Database client.
 * @param serviceId - The service.
 * @returns `true` when it has a proxy.
 */
export async function hasTcpProxy(db: Db, serviceId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: tcpProxies.id })
    .from(tcpProxies)
    .where(eq(tcpProxies.serviceId, serviceId))
    .limit(1);
  return row !== undefined;
}

/**
 * Proxies of the given service/environment pairs, keyed `service:environment`.
 *
 * @param db - Database client.
 * @param pairs - The pairs a desired state places.
 * @returns The proxies found.
 */
export async function tcpProxiesFor(
  db: Db,
  pairs: readonly { serviceId: string; environmentId: string }[],
): Promise<Map<string, TcpProxyRow>> {
  const out = new Map<string, TcpProxyRow>();
  if (!pairs.length) return out;
  const rows = await db
    .select()
    .from(tcpProxies)
    .where(
      or(
        ...pairs.map((p) =>
          and(eq(tcpProxies.serviceId, p.serviceId), eq(tcpProxies.environmentId, p.environmentId)),
        ),
      ),
    );
  for (const r of rows) out.set(`${r.serviceId}:${r.environmentId}`, r);
  return out;
}

/**
 * The node running the service's live replica in an environment, if any.
 *
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @returns The node row, or `undefined` while nothing runs.
 */
export async function replicaNode(db: Db, serviceId: string, environmentId: string) {
  const [row] = await db
    .select({ node: nodes })
    .from(placements)
    .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
    .innerJoin(nodes, eq(nodes.id, placements.nodeId))
    .where(
      and(
        eq(deployments.serviceId, serviceId),
        eq(deployments.environmentId, environmentId),
        inArray(deployments.status, [...LIVE_DEPLOYMENT_STATUSES]),
        isNull(nodes.deletedAt),
      ),
    )
    .limit(1);
  return row?.node;
}

/**
 * Whether a node enforces published-port allowlists.
 *
 * @param node - The node's capabilities.
 * @returns `true` when its agent advertised `tcp_proxy`.
 */
export function enforcesTcpProxy(node: Pick<typeof nodes.$inferSelect, "capabilities">): boolean {
  return node.capabilities?.tcp_proxy === true;
}

/**
 * The `TcpProxy` wire shape, with where it is reachable and whether the
 * node enforces it.
 *
 * @param db - Database client.
 * @param p - The proxy.
 * @returns See `TcpProxySchema`.
 */
export async function presentTcpProxy(db: Db, p: TcpProxyRow) {
  const node = await replicaNode(db, p.serviceId, p.environmentId);
  const status = !node ? "pending" : enforcesTcpProxy(node) ? "active" : "unsupported";
  return {
    id: p.id,
    service_id: p.serviceId,
    environment_id: p.environmentId,
    container_port: p.containerPort,
    public_port: p.publicPort,
    allowed_cidrs: p.allowedCidrs,
    host: node ? (node.publicHostname ?? node.publicIp ?? null) : null,
    node_id: node?.id ?? null,
    status: status as "active" | "pending" | "unsupported",
    open_to_all: p.allowedCidrs.some(isOpenCidr),
    created_at: +p.createdAt,
    updated_at: +p.updatedAt,
  };
}

/**
 * The container port a proxy publishes when the caller doesn't name one.
 *
 * @param service - The service.
 * @param networkingPort - The service config's `networking.port`.
 * @returns The port.
 * @throws {ApiError} 409 when the service listens on no port.
 */
export function defaultContainerPort(
  service: Pick<typeof services.$inferSelect, "name">,
  networkingPort: number | null,
): number {
  if (!networkingPort) {
    throw conflict(`${service.name} has no port configured; name container_port`);
  }
  return networkingPort;
}
