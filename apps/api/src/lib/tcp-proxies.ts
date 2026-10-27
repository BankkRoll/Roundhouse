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
 *   ({@link presentTcpProxy});
 * - the `ROUNDHOUSE_TCP_PROXY_*` built-ins ({@link tcpProxyEndpoints}) and a
 *   database's `DATABASE_PUBLIC_URL` variable, written while its port is
 *   published ({@link writeDatabasePublicUrl}, {@link deleteDatabasePublicUrl}).
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
  variables,
  volumes,
} from "@roundhouse/db";
import { isCidr, isIPv4, isIPv6 } from "@roundhouse/protocol";
import {
  DATABASE_PUBLIC_URL_VARIABLE,
  databasePublicUrl,
  LIVE_VOLUME_STATUSES,
  MAX_TCP_PROXY_CIDRS,
  type ServiceDatabaseEngine,
  TCP_PROXY_PORT_RANGE,
} from "@roundhouse/shared";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { LIVE_DEPLOYMENT_STATUSES } from "./desired-state";
import { ApiError, conflict } from "./errors";
import { openVariable, putVariables, type VariableTarget } from "./variables";

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

/** An IPv6 address as a 128-bit integer; `addr` must pass `isIPv6`. */
function ipv6ToBigInt(addr: string): bigint {
  let text = addr;
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = ipv4ToInt(dotted[1]!);
    text = `${text.slice(0, -dotted[1]!.length)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const h = groups(head);
  const t = tail === undefined ? [] : groups(tail);
  const all = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return all.reduce((n, g) => (n << 16n) | BigInt(Number.parseInt(g, 16)), 0n);
}

/** The canonical (RFC 5952) text of a 128-bit integer. */
function bigIntToIpv6(n: bigint): string {
  const groups = Array.from({ length: 8 }, (_, i) => Number((n >> BigInt(16 * (7 - i))) & 0xffffn));
  let best = { at: -1, len: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > best.len && j - i > 1) best = { at: i, len: j - i };
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best.at < 0) return hex.join(":");
  return `${hex.slice(0, best.at).join(":")}::${hex.slice(best.at + best.len).join(":")}`;
}

/**
 * One allowlist entry with its host bits cleared, or `null` when it is not
 * an address or CIDR block.
 */
function normalizeEntry(raw: string): string | null {
  const entry = raw.trim();
  const cidr = isIPv4(entry) ? `${entry}/32` : isIPv6(entry) ? `${entry}/128` : entry;
  if (!isCidr(cidr)) return null;
  const slash = cidr.indexOf("/");
  const addr = cidr.slice(0, slash);
  const bits = Number(cidr.slice(slash + 1));
  if (isIPv4(addr)) {
    const size = 2 ** (32 - bits);
    return `${intToIpv4(Math.floor(ipv4ToInt(addr) / size) * size)}/${bits}`;
  }
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
  return `${bigIntToIpv6(ipv6ToBigInt(addr) & mask)}/${bits}`;
}

/**
 * Whether an allowlist entry is an IPv6 block.
 *
 * @param cidr - A normalised entry.
 * @returns `true` for e.g. `2001:db8::/32`.
 */
export function isIPv6Cidr(cidr: string): boolean {
  return cidr.includes(":");
}

/**
 * Validates an allowlist and normalises it: a bare address becomes a /32
 * (or /128), host bits are cleared, IPv6 is written canonically, duplicates
 * are dropped, and the order is kept.
 *
 * IPv4 entries admit IPv4 sources and IPv6 entries IPv6 sources. A list
 * with any IPv6 entry is published dual stack (see {@link publishHostIp}).
 * An IPv4-mapped IPv6 block (`::ffff:0:0/96`) is refused: the node matches
 * IPv4 clients against IPv4 rules, so it would admit nobody.
 *
 * @param input - Entries as the caller sent them.
 * @param acknowledgeOpen - Whether the caller confirmed admitting every address.
 * @returns The normalised list.
 * @throws {ApiError} 422 for an invalid entry, or an unacknowledged `/0`.
 * @example
 * normalizeAllowlist(["203.0.113.7", "10.1.2.3/8", "2001:DB8::1/32"], false);
 * // ["203.0.113.7/32", "10.0.0.0/8", "2001:db8::/32"]
 */
export function normalizeAllowlist(input: readonly string[], acknowledgeOpen: boolean): string[] {
  const out: string[] = [];
  const invalid: string[] = [];
  for (const raw of input) {
    const normalized = normalizeEntry(raw);
    if (!normalized) {
      invalid.push(raw);
      continue;
    }
    if (isIPv6Cidr(normalized) && isIPv4Mapped(normalized)) {
      throw new ApiError(
        422,
        "invalid_request",
        `${raw}: an IPv4-mapped block admits no one; list the IPv4 block instead`,
      );
    }
    if (!out.includes(normalized)) out.push(normalized);
  }
  if (invalid.length) {
    throw new ApiError(
      422,
      "invalid_request",
      `Not an IP address or CIDR block: ${invalid.slice(0, 5).join(", ")}`,
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
      "A /0 block opens the port to the whole internet, unencrypted unless the client and the database negotiate TLS; send acknowledge_open to continue",
    );
  }
  return out;
}

/** Whether a normalised IPv6 block lies inside `::ffff:0:0/96`. */
function isIPv4Mapped(cidr: string): boolean {
  const slash = cidr.indexOf("/");
  const bits = Number(cidr.slice(slash + 1));
  if (bits < 96) return false;
  return ipv6ToBigInt(cidr.slice(0, slash)) >> 32n === 0xffffn;
}

/**
 * The address a proxy's port is published on: `::` (both families) when the
 * allowlist admits any IPv6 source, else `0.0.0.0` (IPv4 only), so a node
 * without working IPv6 rules is only asked for them when they are needed.
 *
 * @param allowedCidrs - The normalised allowlist.
 * @returns `WorkloadPort.publish.host_ip`.
 */
export function publishHostIp(allowedCidrs: readonly string[]): "0.0.0.0" | "::" {
  return allowedCidrs.some(isIPv6Cidr) ? "::" : "0.0.0.0";
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
  const running = await replicaNode(db, p.serviceId, p.environmentId);
  const node = running ?? (await proxyNode(db, p.serviceId, p.environmentId));
  const status = !node
    ? "pending"
    : !enforcesTcpProxy(node)
      ? "unsupported"
      : running
        ? "active"
        : "pending";
  return {
    id: p.id,
    service_id: p.serviceId,
    environment_id: p.environmentId,
    container_port: p.containerPort,
    public_port: p.publicPort,
    allowed_cidrs: p.allowedCidrs,
    host: node ? nodeHost(node) : null,
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

/**
 * Where each published port of an environment is reachable: the public
 * hostname (else public IP) of the node holding the service's volume, or
 * running its replica; `null` while it is placed nowhere. Feeds the
 * `ROUNDHOUSE_TCP_PROXY_*` built-ins.
 *
 * @param db - Database client.
 * @param projectId - The project.
 * @param environmentId - The environment.
 * @returns Host and port per service ID.
 */
export async function tcpProxyEndpoints(
  db: Db,
  projectId: string,
  environmentId: string,
): Promise<Map<string, { host: string | null; port: number }>> {
  const out = new Map<string, { host: string | null; port: number }>();
  const rows = await db
    .select({ serviceId: tcpProxies.serviceId, port: tcpProxies.publicPort })
    .from(tcpProxies)
    .where(and(eq(tcpProxies.projectId, projectId), eq(tcpProxies.environmentId, environmentId)));
  for (const r of rows) {
    const node = await proxyNode(db, r.serviceId, environmentId);
    out.set(r.serviceId, { host: node ? nodeHost(node) : null, port: r.port });
  }
  return out;
}

/** The address clients reach a node at: its public hostname, else its public IP. */
export function nodeHost(node: Pick<typeof nodes.$inferSelect, "publicHostname" | "publicIp">) {
  return node.publicHostname ?? node.publicIp ?? null;
}

/**
 * Stores a database's `DATABASE_PUBLIC_URL` (secret, reference-valued) when
 * its port is first published, unless the service already has one.
 *
 * @param db - Database client.
 * @param key - Project DEK.
 * @param target - The database service in one environment.
 * @param engine - Its engine.
 * @param actorId - Stored as `updated_by`.
 * @returns Whether it was written.
 */
export async function writeDatabasePublicUrl(
  db: Db,
  key: CryptoKey,
  target: VariableTarget,
  engine: ServiceDatabaseEngine,
  actorId: string,
): Promise<boolean> {
  const [present] = await db
    .select({ id: variables.id })
    .from(variables)
    .where(publicUrlWhere(target))
    .limit(1);
  if (present) return false;
  await putVariables(
    db,
    key,
    target,
    {
      set: [
        { key: DATABASE_PUBLIC_URL_VARIABLE, value: databasePublicUrl(engine), tier: "secret" },
      ],
      delete: [],
      confirm_write_only: true,
      acknowledge_public: [],
    },
    actorId,
  );
  return true;
}

/**
 * Deletes a database's `DATABASE_PUBLIC_URL` when its port stops being
 * published, so the next deploy does not fail on the built-ins it
 * references. A value the user changed is left alone.
 *
 * @param db - Database client.
 * @param key - Project DEK.
 * @param target - The database service in one environment.
 * @param engine - Its engine.
 * @returns Whether it was deleted.
 */
export async function deleteDatabasePublicUrl(
  db: Db,
  key: CryptoKey,
  target: VariableTarget,
  engine: ServiceDatabaseEngine,
): Promise<boolean> {
  const [row] = await db.select().from(variables).where(publicUrlWhere(target)).limit(1);
  if (!row || (await openVariable(key, row)) !== databasePublicUrl(engine)) return false;
  await db
    .delete(variables)
    .where(and(eq(variables.id, row.id), eq(variables.version, row.version)));
  return true;
}

function publicUrlWhere(target: VariableTarget) {
  return and(
    eq(variables.projectId, target.projectId),
    eq(variables.environmentId, target.environmentId),
    eq(variables.scope, "service"),
    eq(variables.serviceId, target.serviceId!),
    eq(variables.key, DATABASE_PUBLIC_URL_VARIABLE),
  );
}

/**
 * The node a proxy publishes on: the one running the service's replica, or
 * for a volume service not running now, the one holding its volume.
 *
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @returns The node row, or `undefined` while it is placed nowhere.
 */
export async function proxyNode(db: Db, serviceId: string, environmentId: string) {
  const running = await replicaNode(db, serviceId, environmentId);
  if (running) return running;
  const [row] = await db
    .select({ node: nodes })
    .from(volumes)
    .innerJoin(nodes, eq(nodes.id, volumes.nodeId))
    .where(
      and(
        eq(volumes.serviceId, serviceId),
        eq(volumes.environmentId, environmentId),
        inArray(volumes.status, [...LIVE_VOLUME_STATUSES]),
        isNull(nodes.deletedAt),
      ),
    )
    .limit(1);
  return row?.node;
}
