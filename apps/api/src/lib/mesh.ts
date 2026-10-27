/**
 * The WireGuard mesh between a workspace's nodes (ADR 0005), on the control
 * plane's side. Agents generate their keys and report them; this module
 * decides everything else:
 *
 * - the address plan: each node's /24 ({@link joinMesh}), each live
 *   replica's and running cron job's mesh IP ({@link assignMeshIps},
 *   {@link assignRunMeshIp}) and each environment's nftables tag
 *   ({@link assignNetTags});
 * - reachability: a node's endpoint ({@link meshEndpoint}) and each pair's
 *   path, direct or through a relay ({@link choosePaths}, a pure function,
 *   plus the fallback state in `mesh_paths`);
 * - per-pair preshared keys, sealed under the KEK at rest and to the node in
 *   the frame ({@link ensurePairPsks}, {@link buildMeshConfig});
 * - health and key rotation from the agent's reports ({@link onMeshStatus},
 *   {@link onMeshKey}, {@link progressRotations});
 * - the dashboard's view ({@link readMesh}).
 *
 * Peers are the other meshed nodes of the same workspace: workspaces are
 * tenants, and nothing of one ever runs on another's nodes.
 *
 * @module
 */
import {
  cronRuns,
  type Db,
  deployments,
  environments,
  type MeshPairSide,
  type MeshPath,
  meshPaths,
  meshPsks,
  nodes,
  PLACEMENT_ONLY_STATES,
  placements,
  projects,
  serviceConfigs,
  services,
} from "@roundhouse/db";
import {
  MESH_PROTOCOL_VERSION,
  type MeshConfig,
  type MeshKey,
  type MeshPeer,
  type MeshStatus,
  meshPsksAad,
  sealBox,
  toBase64,
} from "@roundhouse/protocol";
import { PLACED_CRON_RUN_STATUSES } from "@roundhouse/shared";
import { and, asc, eq, inArray, isNotNull, isNull, like, notInArray, or, sql } from "drizzle-orm";
import type { Mesh, MeshNode, MeshPair } from "../contracts/mesh";
import type { Sealed } from "./crypto";
import { LIVE_DEPLOYMENT_STATUSES } from "./desired-state";
import { isUniqueViolation } from "./errors";
import { type KeyEnv, sealInstanceSecret, unsealInstanceSecret } from "./instance-secrets";
import { effectiveStatus } from "./nodes";
import { getMeshSettings, type MeshSettings } from "./settings";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** UDP port `wg0` listens on unless the agent reports another. */
export const MESH_LISTEN_PORT = 51820;

/** `wg0` MTU: a 1500-byte path minus WireGuard's 80 bytes of IPv6 overhead. */
export const MESH_MTU = 1420;

/** The fwmark Docker accepts (`DOCKER-USER` rule or `--bridge-accept-fwmark`). */
export const MESH_ACCEPT_FWMARK = 0x2000000;

/** Persistent keepalive the NAT side of a pair sends, so its mapping stays open. */
export const MESH_KEEPALIVE_S = 25;

/** A direct pair that hasn't handshaken this long after being configured falls back to a relay. */
export const MESH_DIRECT_GRACE_MS = 120_000;

/** A relayed fallback tries the direct path again after this long. */
export const MESH_DIRECT_RETRY_MS = 30 * 60_000;

/**
 * A tunnel whose last handshake is older than this is down: WireGuard
 * rekeys every 120 s and gives up on a session after 180 s.
 */
export const MESH_HANDSHAKE_STALE_MS = 180_000;

/** Static keys rotate this often (ADR 0005, "Key rotation"). */
export const MESH_KEY_MAX_AGE_MS = 90 * 24 * 60 * 60_000;

/** A rotating node activates its new key at most this long after its peers were sent it. */
export const MESH_ACTIVATE_AFTER_MS = 60_000;

/** A rotation the node never answered with `mesh_key` is dropped after this long. */
export const MESH_ROTATION_ABANDON_MS = 10 * 60_000;

/** Node label that makes a public node the preferred relay. */
export const MESH_RELAY_LABEL = "roundhouse.io/mesh-relay";

/** First and last host of a node's /24 handed to replicas (`.1`–`.9` are reserved). */
export const MESH_FIRST_REPLICA_HOST = 10;
/** See {@link MESH_FIRST_REPLICA_HOST}. */
export const MESH_LAST_REPLICA_HOST = 254;

/** `instance_settings` key the per-pair preshared keys are sealed under (AAD). */
const PSK_SETTING = "mesh_psk";

// -----------------------------------------------------------------------------
// Address plan
// -----------------------------------------------------------------------------

/**
 * The first two octets of a `/16` supernet.
 *
 * @param supernet - E.g. `10.200.0.0/16`.
 * @returns E.g. `10.200`.
 */
function prefix16(supernet: string): string {
  return supernet.split(".").slice(0, 2).join(".");
}

/**
 * A node's /24.
 *
 * @param supernet - The mesh supernet.
 * @param index - The node's mesh index, 1–254.
 * @returns E.g. `10.200.3.0/24`.
 */
export function nodeSubnet(supernet: string, index: number): string {
  return `${prefix16(supernet)}.${index}.0/24`;
}

/**
 * One address of a node's /24.
 *
 * @param supernet - The mesh supernet.
 * @param index - The node's mesh index.
 * @param host - Last octet: 1 is `wg0`, 2 the private DNS, 10–254 replicas.
 * @returns E.g. `10.200.3.1`.
 */
export function meshAddress(supernet: string, index: number, host: number): string {
  return `${prefix16(supernet)}.${index}.${host}`;
}

/**
 * Key of a pair of nodes in `mesh_psks` and `mesh_paths`.
 *
 * @param a - One node ID.
 * @param b - The other.
 * @returns `<lower id>|<higher id>`.
 */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** A node row. */
type NodeRow = typeof nodes.$inferSelect;

/**
 * Whether a node takes part in the mesh: the install has it on, the agent
 * speaks it, reported a key and can run `wg0`, and was given a /24.
 *
 * @param node - The node's row.
 * @param settings - The mesh settings.
 * @returns `true` for a meshed node.
 */
export function isMeshed(
  node: Pick<
    NodeRow,
    "meshIndex" | "wgPubkey" | "protocolVersion" | "meshMode" | "deletedAt" | "encryptionPublicKey"
  >,
  settings: Pick<MeshSettings, "enabled">,
): boolean {
  return (
    settings.enabled &&
    node.deletedAt === null &&
    node.protocolVersion >= MESH_PROTOCOL_VERSION &&
    node.meshIndex !== null &&
    node.wgPubkey !== null &&
    node.encryptionPublicKey !== null &&
    node.meshMode !== null &&
    node.meshMode !== "unavailable"
  );
}

/**
 * The live, meshed nodes of a workspace.
 *
 * @param db - Database client.
 * @param workspaceId - The workspace.
 * @param settings - The mesh settings.
 * @returns Their rows, by ID.
 */
export async function meshedNodes(
  db: Db,
  workspaceId: string,
  settings: MeshSettings,
): Promise<NodeRow[]> {
  if (!settings.enabled) return [];
  const rows = await db
    .select()
    .from(nodes)
    .where(
      and(eq(nodes.workspaceId, workspaceId), isNull(nodes.deletedAt), isNotNull(nodes.meshIndex)),
    )
    .orderBy(asc(nodes.id));
  return rows.filter((n) => isMeshed(n, settings));
}

/**
 * Gives a node its /24 when it can join: the mesh is on, its agent reported
 * a usable `wg0` and a key, and it has none yet. The lowest free index wins;
 * indexes are unique among live nodes of the whole install, since the
 * supernet is install-wide.
 *
 * @param db - Database client.
 * @param nodeId - The node.
 * @param settings - The mesh settings.
 * @returns The index it got, or `null` when it didn't join now (already in,
 *   not eligible, or the supernet is full).
 */
export async function joinMesh(
  db: Db,
  nodeId: string,
  settings: MeshSettings,
): Promise<number | null> {
  if (!settings.enabled) return null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (
      !node ||
      node.deletedAt ||
      node.meshIndex !== null ||
      node.wgPubkey === null ||
      node.meshMode === null ||
      node.meshMode === "unavailable" ||
      node.protocolVersion < MESH_PROTOCOL_VERSION
    ) {
      return null;
    }
    const used = new Set(
      (
        await db
          .select({ index: nodes.meshIndex })
          .from(nodes)
          .where(and(isNull(nodes.deletedAt), isNotNull(nodes.meshIndex)))
      ).map((r) => r.index),
    );
    let index = 1;
    while (index <= 254 && used.has(index)) index++;
    if (index > 254) return null;
    try {
      const [joined] = await db
        .update(nodes)
        .set({ meshIndex: index, wgIp: meshAddress(settings.supernet, index, 1) })
        .where(and(eq(nodes.id, nodeId), isNull(nodes.meshIndex), isNull(nodes.deletedAt)))
        .returning({ id: nodes.id });
      return joined ? index : null;
    } catch (err) {
      // Another node took the same index between the read and the write.
      if (!isUniqueViolation(err, "nodes.mesh_index")) throw err;
    }
  }
  return null;
}

/**
 * Hands every live replica on a meshed node a mesh IP in the node's /24,
 * lowest free first, and frees the IPs of replicas whose deployment is no
 * longer live (so the next replica can take them). Addresses of running
 * cron jobs ({@link assignRunMeshIp}, taken from the top of the range) are
 * never handed out.
 *
 * @param db - Database client.
 * @param node - The node's ID and mesh index.
 * @param supernet - The mesh supernet.
 * @returns How many replicas got an address.
 */
export async function assignMeshIps(
  db: Db,
  node: { id: string; meshIndex: number },
  supernet: string,
): Promise<number> {
  const subnetPrefix = `${prefix16(supernet)}.${node.meshIndex}.`;
  const live = db
    .select({ id: deployments.id })
    .from(deployments)
    .where(inArray(deployments.status, [...LIVE_DEPLOYMENT_STATUSES]));
  await db
    .update(placements)
    .set({ meshIp: null })
    .where(
      and(
        eq(placements.nodeId, node.id),
        isNotNull(placements.meshIp),
        or(
          notInArray(placements.deploymentId, live),
          // A node that left and rejoined under another index.
          sql`${placements.meshIp} NOT LIKE ${`${subnetPrefix}%`}`,
        ),
      ),
    );
  let assigned = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const rows = await db
      .select({ id: placements.id, meshIp: placements.meshIp })
      .from(placements)
      .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
      .where(
        and(
          eq(placements.nodeId, node.id),
          inArray(deployments.status, [...LIVE_DEPLOYMENT_STATUSES]),
        ),
      )
      .orderBy(asc(placements.workloadId));
    const used = new Set([
      ...rows.flatMap((r) => (r.meshIp ? [r.meshIp] : [])),
      ...(await liveRunIps(db, node.id)),
    ]);
    const missing = rows.filter((r) => r.meshIp === null);
    if (!missing.length) return assigned;
    let host = MESH_FIRST_REPLICA_HOST;
    let conflict = false;
    for (const r of missing) {
      while (host <= MESH_LAST_REPLICA_HOST && used.has(`${subnetPrefix}${host}`)) host++;
      // More live replicas than addresses can't happen below MAX_WORKLOADS_PER_NODE.
      if (host > MESH_LAST_REPLICA_HOST) return assigned;
      const ip = `${subnetPrefix}${host}`;
      try {
        const [row] = await db
          .update(placements)
          .set({ meshIp: ip })
          .where(and(eq(placements.id, r.id), isNull(placements.meshIp)))
          .returning({ id: placements.id });
        if (row) assigned++;
        used.add(ip);
      } catch (err) {
        // A concurrent assignment took the address; read again.
        if (!isUniqueViolation(err, "placements.")) throw err;
        conflict = true;
        break;
      }
    }
    if (!conflict) return assigned;
  }
  return assigned;
}

/**
 * Mesh IPs held by a node's cron runs that are starting or running.
 *
 * @param db - Database client.
 * @param nodeId - The node.
 * @returns The addresses.
 */
async function liveRunIps(db: Db, nodeId: string): Promise<string[]> {
  const rows = await db
    .select({ ip: cronRuns.meshIp })
    .from(cronRuns)
    .where(
      and(
        eq(cronRuns.nodeId, nodeId),
        isNotNull(cronRuns.meshIp),
        inArray(cronRuns.status, [...PLACED_CRON_RUN_STATUSES]),
      ),
    );
  return rows.flatMap((r) => (r.ip ? [r.ip] : []));
}

/**
 * Gives a cron run placed on a meshed node a mesh IP from the node's /24.
 * Runs take addresses from the top of the replica range down while
 * replicas take them from the bottom up, so the two allocators only meet
 * on a nearly full node; a collision found after the write gives the
 * address back and tries the next one.
 *
 * @param db - Database client.
 * @param node - The node's ID and mesh index.
 * @param supernet - The mesh supernet.
 * @param runId - The run, already `starting` on the node.
 * @returns The address, or `null` when the node has none free.
 */
export async function assignRunMeshIp(
  db: Db,
  node: { id: string; meshIndex: number },
  supernet: string,
  runId: string,
): Promise<string | null> {
  const subnetPrefix = `${prefix16(supernet)}.${node.meshIndex}.`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const [run] = await db
      .select({ ip: cronRuns.meshIp })
      .from(cronRuns)
      .where(eq(cronRuns.id, runId))
      .limit(1);
    if (!run) return null;
    if (run.ip?.startsWith(subnetPrefix)) return run.ip;
    const placed = await db
      .select({ ip: placements.meshIp })
      .from(placements)
      .where(and(eq(placements.nodeId, node.id), isNotNull(placements.meshIp)));
    const used = new Set([
      ...placed.flatMap((p) => (p.ip ? [p.ip] : [])),
      ...(await liveRunIps(db, node.id)),
    ]);
    let host = MESH_LAST_REPLICA_HOST;
    while (host >= MESH_FIRST_REPLICA_HOST && used.has(`${subnetPrefix}${host}`)) host--;
    if (host < MESH_FIRST_REPLICA_HOST) return null;
    const ip = `${subnetPrefix}${host}`;
    try {
      await db
        .update(cronRuns)
        .set({ meshIp: ip })
        .where(
          and(eq(cronRuns.id, runId), inArray(cronRuns.status, [...PLACED_CRON_RUN_STATUSES])),
        );
    } catch (err) {
      if (!isUniqueViolation(err, "cron_runs.")) throw err;
      continue;
    }
    const [clash] = await db
      .select({ id: placements.id })
      .from(placements)
      .where(and(eq(placements.nodeId, node.id), eq(placements.meshIp, ip)))
      .limit(1);
    if (!clash) return ip;
    // A replica took the address between the read and the write; replicas win.
    await db.update(cronRuns).set({ meshIp: null }).where(eq(cronRuns.id, runId));
  }
  return null;
}

/**
 * Gives environments without one an nftables tag: the next integer after
 * the highest in use, in one statement so concurrent calls never collide
 * silently (the unique index rejects a duplicate, and the caller retries).
 *
 * @param db - Database client.
 * @param environmentIds - Environments that need a tag now.
 * @returns Each environment's tag.
 */
export async function assignNetTags(
  db: Db,
  environmentIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const id of new Set(environmentIds)) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const [row] = await db
        .select({ netTag: environments.netTag })
        .from(environments)
        .where(eq(environments.id, id))
        .limit(1);
      if (!row) break;
      if (row.netTag !== null) {
        out.set(id, row.netTag);
        break;
      }
      try {
        await db
          .update(environments)
          .set({
            netTag: sql`(SELECT COALESCE(MAX(${environments.netTag}), 0) + 1 FROM ${environments})`,
          })
          .where(and(eq(environments.id, id), isNull(environments.netTag)));
      } catch (err) {
        if (!isUniqueViolation(err, "environments.net_tag")) throw err;
      }
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Reachability and paths
// -----------------------------------------------------------------------------

/**
 * Where peers reach a node: the agent's `mesh.endpoint` override, else the
 * address the control plane saw the agent connect from, when the agent
 * found a public address on its interfaces.
 *
 * @param report - The node's `hello.mesh` fields.
 * @param observedIp - `CF-Connecting-IP` of the agent's connection.
 * @returns `host:port`, or `null` for a node behind NAT.
 */
export function meshEndpoint(
  report: { nat: "public" | "nat"; endpoint_override: string | null; listen_port: number },
  observedIp: string | null,
): string | null {
  if (report.endpoint_override) return report.endpoint_override;
  if (report.nat !== "public" || !observedIp) return null;
  return observedIp.includes(":")
    ? `[${observedIp}]:${report.listen_port}`
    : `${observedIp}:${report.listen_port}`;
}

/** A node as the path chooser sees it. */
export interface PathNode {
  id: string;
  endpoint: string | null;
  labels: Readonly<Record<string, string>>;
}

/** The path stored for a pair: only a relayed fallback of a direct pair matters here. */
export interface StoredPath {
  path: MeshPath;
  relayNodeId: string | null;
}

/** A pair's chosen path. */
export interface ChosenPath {
  path: MeshPath;
  /** The relay of a `relayed` pair. */
  relay: string | null;
}

/**
 * Relay candidates for a pair: public nodes other than the two, those
 * labelled {@link MESH_RELAY_LABEL}`=true` first, then by ID.
 */
function relayCandidates(all: readonly PathNode[], a: string, b: string): PathNode[] {
  return all
    .filter((n) => n.endpoint !== null && n.id !== a && n.id !== b)
    .sort((x, y) => {
      const lx = x.labels[MESH_RELAY_LABEL] === "true" ? 0 : 1;
      const ly = y.labels[MESH_RELAY_LABEL] === "true" ? 0 : 1;
      return lx - ly || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
    });
}

/**
 * Chooses every pair's path (ADR 0005, "Pair paths"). Pure and
 * deterministic, so every node's frame agrees:
 * - at least one side public: `direct`, unless `mesh_paths` holds a relayed
 *   fallback for it (no handshake in time) and a relay is still available;
 * - both behind NAT: `relayed` through the preferred public node, else
 *   `down`.
 *
 * @param all - The workspace's meshed nodes.
 * @param stored - `mesh_paths` rows by {@link pairKey}.
 * @returns Paths by {@link pairKey}.
 */
export function choosePaths(
  all: readonly PathNode[],
  stored: ReadonlyMap<string, StoredPath>,
): Map<string, ChosenPath> {
  const out = new Map<string, ChosenPath>();
  const sorted = [...all].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      const key = pairKey(a.id, b.id);
      const candidates = relayCandidates(all, a.id, b.id);
      if (a.endpoint !== null || b.endpoint !== null) {
        const prior = stored.get(key);
        if (prior?.path === "relayed" && candidates.length) {
          const kept = candidates.find((c) => c.id === prior.relayNodeId) ?? candidates[0]!;
          out.set(key, { path: "relayed", relay: kept.id });
        } else {
          out.set(key, { path: "direct", relay: null });
        }
      } else {
        out.set(
          key,
          candidates.length
            ? { path: "relayed", relay: candidates[0]!.id }
            : { path: "down", relay: null },
        );
      }
    }
  }
  return out;
}

/** A meshed node as {@link peerEntries} needs it. */
export interface PeerNode extends PathNode {
  meshIndex: number;
  /** The key peers use: the rotation's next key while one is pending. */
  publicKey: string;
}

/**
 * One node's WireGuard peers and relay duty, from the chosen paths.
 *
 * - A direct pair is a peer entry for the other node with its /24. The NAT
 *   side gets the public side's endpoint and a keepalive; the public side
 *   gets no endpoint for a NAT peer and learns it by roaming.
 * - A relayed pair adds the other node's /24 to the entry for the relay,
 *   and the relay forwards between the two /24s.
 *
 * @param self - The node.
 * @param all - Every meshed node of its workspace, itself included.
 * @param paths - From {@link choosePaths}.
 * @param supernet - The mesh supernet.
 * @returns Peers (without preshared keys) and the CIDR pairs it relays.
 */
export function peerEntries(
  self: PeerNode,
  all: readonly PeerNode[],
  paths: ReadonlyMap<string, ChosenPath>,
  supernet: string,
): { peers: MeshPeer[]; forwardPairs: [string, string][] } {
  const byId = new Map(all.map((n) => [n.id, n]));
  const entries = new Map<string, MeshPeer>();
  const entryFor = (peer: PeerNode): MeshPeer => {
    let e = entries.get(peer.id);
    if (!e) {
      const selfPublic = self.endpoint !== null;
      const peerPublic = peer.endpoint !== null;
      e = {
        node_id: peer.id,
        public_key: peer.publicKey,
        endpoint: peerPublic ? peer.endpoint : null,
        allowed_ips: [nodeSubnet(supernet, peer.meshIndex)],
        // The side behind NAT keeps the mapping open; between two public
        // nodes nothing needs keeping alive.
        keepalive_s: !selfPublic && peerPublic ? MESH_KEEPALIVE_S : 0,
      };
      entries.set(peer.id, e);
    }
    return e;
  };
  const forwardPairs: [string, string][] = [];
  for (const [key, chosen] of paths) {
    const [a, b] = key.split("|") as [string, string];
    const na = byId.get(a);
    const nb = byId.get(b);
    if (!na || !nb) continue;
    if (chosen.path === "direct") {
      if (a === self.id) entryFor(nb);
      else if (b === self.id) entryFor(na);
    } else if (chosen.path === "relayed" && chosen.relay) {
      const relay = byId.get(chosen.relay);
      if (!relay) continue;
      if (a === self.id || b === self.id) {
        const other = a === self.id ? nb : na;
        const e = entryFor(relay);
        const cidr = nodeSubnet(supernet, other.meshIndex);
        if (!e.allowed_ips.includes(cidr)) e.allowed_ips.push(cidr);
      } else if (relay.id === self.id) {
        forwardPairs.push([nodeSubnet(supernet, na.meshIndex), nodeSubnet(supernet, nb.meshIndex)]);
      }
    }
  }
  const peers = [...entries.values()].sort((x, y) =>
    x.node_id < y.node_id ? -1 : x.node_id > y.node_id ? 1 : 0,
  );
  return { peers, forwardPairs };
}

/**
 * Reads the stored paths of pairs among the given nodes.
 *
 * @param db - Database client.
 * @param nodeIds - The workspace's meshed nodes.
 * @returns `mesh_paths` rows by pair key, only for pairs among `nodeIds`.
 */
async function storedPaths(
  db: Db,
  nodeIds: readonly string[],
): Promise<Map<string, typeof meshPaths.$inferSelect>> {
  const ids = new Set(nodeIds);
  if (ids.size < 2) return new Map();
  // NOTE: pair keys are "<a>|<b>"; matching on each node's prefix keeps the
  // query free of an unbounded IN list (D1 caps bound parameters at 100).
  const rows: (typeof meshPaths.$inferSelect)[] = [];
  const list = [...ids];
  for (let i = 0; i < list.length; i += 50) {
    rows.push(
      ...(await db
        .select()
        .from(meshPaths)
        .where(or(...list.slice(i, i + 50).map((id) => like(meshPaths.pairKey, `${id}|%`))))),
    );
  }
  return new Map(
    rows
      .filter((r) => {
        const [a, b] = r.pairKey.split("|") as [string, string];
        return ids.has(a) && ids.has(b);
      })
      .map((r) => [r.pairKey, r]),
  );
}

/**
 * Records each pair's chosen path when it differs from what is stored, so
 * a newly direct pair gets its handshake grace period from now.
 *
 * @param db - Database client.
 * @param chosen - From {@link choosePaths}.
 * @param stored - What {@link storedPaths} read.
 * @param now - Unix ms.
 */
async function recordPaths(
  db: Db,
  chosen: ReadonlyMap<string, ChosenPath>,
  stored: ReadonlyMap<string, typeof meshPaths.$inferSelect>,
  now: number,
): Promise<void> {
  const changed = [...chosen].filter(([key, c]) => {
    const s = stored.get(key);
    return !s || s.path !== c.path || s.relayNodeId !== c.relay;
  });
  for (const [key, c] of changed) {
    const at = new Date(now);
    await db
      .insert(meshPaths)
      .values({
        pairKey: key,
        path: c.path,
        relayNodeId: c.relay,
        configuredAt: at,
        lastDirectAttemptAt: c.path === "direct" ? at : null,
      })
      .onConflictDoUpdate({
        target: meshPaths.pairKey,
        set: {
          path: c.path,
          relayNodeId: c.relay,
          configuredAt: at,
          ...(c.path === "direct" ? { lastDirectAttemptAt: at } : {}),
          updatedAt: at,
        },
      });
  }
}

// -----------------------------------------------------------------------------
// Preshared keys
// -----------------------------------------------------------------------------

/**
 * The preshared key of each pair of `nodeId` with `peerIds`, creating the
 * missing ones: 32 random bytes, sealed under the KEK at rest.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @param nodeId - The node.
 * @param peerIds - Its peers.
 * @returns Base64 keys by peer ID.
 */
export async function ensurePairPsks(
  db: Db,
  keys: KeyEnv,
  nodeId: string,
  peerIds: readonly string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const peer of peerIds) {
    const key = pairKey(nodeId, peer);
    let [row] = await db.select().from(meshPsks).where(eq(meshPsks.pairKey, key)).limit(1);
    if (!row) {
      const fresh = toBase64(crypto.getRandomValues(new Uint8Array(32)));
      await db
        .insert(meshPsks)
        .values({
          pairKey: key,
          pskSealed: await sealInstanceSecret(keys, fresh, PSK_SETTING, key),
        })
        .onConflictDoNothing();
      // Read back: a concurrent build may have inserted its own key first.
      [row] = await db.select().from(meshPsks).where(eq(meshPsks.pairKey, key)).limit(1);
    }
    if (!row) continue;
    out[peer] = await unsealInstanceSecret(keys, row.pskSealed as Sealed, PSK_SETTING, key);
  }
  return out;
}

/**
 * Drops every preshared key of a node's pairs, so the next frames carry
 * fresh ones: on key rotation, key change and removal.
 *
 * @param db - Database client.
 * @param nodeId - The node.
 */
export async function dropPairPsks(db: Db, nodeId: string): Promise<void> {
  await db
    .delete(meshPsks)
    .where(or(like(meshPsks.pairKey, `${nodeId}|%`), like(meshPsks.pairKey, `%|${nodeId}`)));
}

/**
 * Preshared keys not sealed under `currentKid`, for rotation and key status.
 *
 * @param currentKid - The current KEK id.
 * @returns The condition.
 */
export function stalePairPsks(currentKid: string) {
  return sql`(json_extract(${meshPsks.pskSealed}, '$.v') IS NOT 2 OR json_extract(${meshPsks.pskSealed}, '$.kid') IS NOT ${currentKid})`;
}

/**
 * Re-seals up to `limit` preshared keys not sealed under the current KEK;
 * part of the master key rotation.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @param currentKid - The current KEK id.
 * @param limit - Batch size.
 * @returns How many were re-sealed.
 */
export async function resealPairPsks(
  db: Db,
  keys: KeyEnv,
  currentKid: string,
  limit: number,
): Promise<number> {
  const rows = await db
    .select({
      pairKey: meshPsks.pairKey,
      pskSealed: meshPsks.pskSealed,
      raw: sql<string>`CAST(${meshPsks.pskSealed} AS TEXT)`,
    })
    .from(meshPsks)
    .where(stalePairPsks(currentKid))
    .limit(limit);
  for (const r of rows) {
    const psk = await unsealInstanceSecret(keys, r.pskSealed as Sealed, PSK_SETTING, r.pairKey);
    await db
      .update(meshPsks)
      .set({ pskSealed: await sealInstanceSecret(keys, psk, PSK_SETTING, r.pairKey) })
      .where(
        and(eq(meshPsks.pairKey, r.pairKey), sql`CAST(${meshPsks.pskSealed} AS TEXT) = ${r.raw}`),
      );
  }
  return rows.length;
}

// -----------------------------------------------------------------------------
// Desired state
// -----------------------------------------------------------------------------

/** A replica's mesh address as {@link buildMeshConfig} lists it. */
export interface MeshReplica {
  ip: string;
  nodeId: string;
  environmentId: string;
  serviceId: string;
  /** `<service>.<environment>.<project>.internal`. */
  privateDomain: string;
  healthy: boolean;
  /** Ports with an ingress route. */
  routedPorts: number[];
}

/** A live replica on a meshed node, with what route workloads need. */
export interface ClusterReplica extends MeshReplica {
  projectId: string;
  deploymentId: string;
  image: string;
  /** The service's `networking.port`, which its routes target. */
  port: number | null;
  /** `networking.generated_domain`: the generated hostname is routed. */
  generatedDomain: boolean;
}

/**
 * Every live replica with a mesh IP on the workspace's meshed nodes.
 *
 * @param db - Database client.
 * @param workspaceId - The workspace.
 * @param nodeIds - Its meshed nodes; replicas elsewhere are left out.
 * @returns The replicas, by IP.
 */
export async function meshReplicas(
  db: Db,
  workspaceId: string,
  nodeIds: ReadonlySet<string>,
): Promise<ClusterReplica[]> {
  if (!nodeIds.size) return [];
  const rows = await db
    .select({
      ip: placements.meshIp,
      nodeId: placements.nodeId,
      state: placements.state,
      environmentId: deployments.environmentId,
      serviceId: deployments.serviceId,
      projectId: services.projectId,
      deploymentId: deployments.id,
      image: deployments.image,
      serviceSlug: services.slug,
      environmentSlug: environments.slug,
      projectSlug: projects.slug,
      networking: serviceConfigs.networking,
    })
    .from(placements)
    .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .innerJoin(environments, eq(environments.id, deployments.environmentId))
    .innerJoin(
      serviceConfigs,
      and(
        eq(serviceConfigs.serviceId, deployments.serviceId),
        eq(serviceConfigs.environmentId, deployments.environmentId),
        eq(serviceConfigs.version, deployments.configVersion),
      ),
    )
    .where(
      and(
        eq(projects.workspaceId, workspaceId),
        isNotNull(placements.meshIp),
        inArray(deployments.status, [...LIVE_DEPLOYMENT_STATUSES]),
        notInArray(placements.state, [...PLACEMENT_ONLY_STATES]),
        isNull(services.deletedAt),
        isNull(projects.deletedAt),
      ),
    )
    .orderBy(asc(placements.meshIp));
  return rows
    .filter((r) => nodeIds.has(r.nodeId) && r.ip !== null && r.image !== null)
    .map((r) => ({
      ip: r.ip!,
      nodeId: r.nodeId,
      environmentId: r.environmentId,
      serviceId: r.serviceId,
      projectId: r.projectId,
      deploymentId: r.deploymentId,
      image: r.image!,
      privateDomain: `${r.serviceSlug}.${r.environmentSlug}.${r.projectSlug}.internal`,
      healthy: r.state === "healthy",
      routedPorts: [],
      port: r.networking.port ?? null,
      generatedDomain: r.networking.generated_domain !== false,
    }));
}

/**
 * Every cron run with a mesh IP that is starting or running on the
 * workspace's meshed nodes, as mesh addresses (ADR 0005 and 0010): other
 * nodes admit their environment's traffic from them, and the private DNS
 * names them after the cron service.
 *
 * @param db - Database client.
 * @param workspaceId - The workspace.
 * @param nodeIds - Its meshed nodes.
 * @returns The runs' addresses, by IP.
 */
export async function meshRunAddresses(
  db: Db,
  workspaceId: string,
  nodeIds: ReadonlySet<string>,
): Promise<MeshReplica[]> {
  if (!nodeIds.size) return [];
  const rows = await db
    .select({
      ip: cronRuns.meshIp,
      nodeId: cronRuns.nodeId,
      status: cronRuns.status,
      environmentId: cronRuns.environmentId,
      serviceId: cronRuns.serviceId,
      serviceSlug: services.slug,
      environmentSlug: environments.slug,
      projectSlug: projects.slug,
    })
    .from(cronRuns)
    .innerJoin(services, eq(services.id, cronRuns.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .innerJoin(environments, eq(environments.id, cronRuns.environmentId))
    .where(
      and(
        eq(projects.workspaceId, workspaceId),
        isNotNull(cronRuns.meshIp),
        inArray(cronRuns.status, [...PLACED_CRON_RUN_STATUSES]),
      ),
    )
    .orderBy(asc(cronRuns.meshIp));
  return rows
    .filter((r) => r.nodeId !== null && nodeIds.has(r.nodeId) && r.ip !== null)
    .map((r) => ({
      ip: r.ip!,
      nodeId: r.nodeId!,
      environmentId: r.environmentId,
      serviceId: r.serviceId,
      privateDomain: `${r.serviceSlug}.${r.environmentSlug}.${r.projectSlug}.internal`,
      healthy: r.status === "running",
      routedPorts: [],
    }));
}

/** What {@link buildMeshConfig} needs about the node and its cluster. */
export interface MeshConfigInput {
  /** The node, meshed. */
  self: NodeRow;
  /** Every meshed node of its workspace, itself included. */
  all: readonly NodeRow[];
  settings: MeshSettings;
  /** Generation of the frame; bound into the sealed keys' AAD. */
  generation: number;
  /** Mesh addresses to list: every replica of each environment with a replica on the node. */
  addresses: readonly MeshReplica[];
  /** nftables tag of each listed environment. */
  netTags: ReadonlyMap<string, number>;
  now?: number;
}

/**
 * Chooses the paths of the workspace's pairs and records changes.
 *
 * @param db - Database client.
 * @param all - The workspace's meshed nodes.
 * @param now - Unix ms.
 * @returns The chosen paths.
 */
async function planPaths(
  db: Db,
  all: readonly NodeRow[],
  now: number,
): Promise<Map<string, ChosenPath>> {
  const stored = await storedPaths(
    db,
    all.map((n) => n.id),
  );
  const chosen = choosePaths(all.map(asPathNode), storedChoices(stored));
  await recordPaths(db, chosen, stored, now);
  return chosen;
}

/** A node row as the path chooser sees it. */
function asPathNode(n: NodeRow): PathNode {
  return { id: n.id, endpoint: n.meshEndpoint, labels: n.labels };
}

/** The part of `mesh_paths` rows {@link choosePaths} reads. */
function storedChoices(
  stored: ReadonlyMap<string, typeof meshPaths.$inferSelect>,
): Map<string, StoredPath> {
  return new Map([...stored].map(([k, v]) => [k, { path: v.path, relayNodeId: v.relayNodeId }]));
}

/**
 * A meshed node as its peers configure it: with the pending rotation's
 * key, when there is one, so they are ready when the node switches.
 */
function asPeer(n: NodeRow): PeerNode {
  return { ...asPathNode(n), meshIndex: n.meshIndex!, publicKey: n.wgPubkeyNext ?? n.wgPubkey! };
}

/**
 * A meshed node's `desired_state.mesh`: address plan, peers with their
 * preshared keys sealed to the node, relay pairs, every node's `.1` and the
 * mesh IPs its nftables rules need.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings, to open the stored preshared keys.
 * @param input - The node, its cluster and what to list.
 * @returns The frame's `mesh`.
 */
export async function buildMeshConfig(
  db: Db,
  keys: KeyEnv,
  input: MeshConfigInput,
): Promise<MeshConfig> {
  const { self, all, settings } = input;
  const now = input.now ?? Date.now();
  const index = self.meshIndex!;
  const chosen = await planPaths(db, all, now);
  const { peers, forwardPairs } = peerEntries(
    asPeer(self),
    all.map(asPeer),
    chosen,
    settings.supernet,
  );
  let psksSealed: MeshConfig["psks_sealed"] = null;
  if (peers.length) {
    const psks = await ensurePairPsks(
      db,
      keys,
      self.id,
      peers.map((p) => p.node_id),
    );
    psksSealed = await sealBox(
      self.encryptionPublicKey!,
      JSON.stringify({ psks }),
      "mesh-psks",
      meshPsksAad(self.id, input.generation),
    );
  }
  const rotating = self.meshRotateRequestedAt !== null;
  return {
    supernet: settings.supernet,
    node_index: index,
    address: meshAddress(settings.supernet, index, 1),
    dns_address: meshAddress(settings.supernet, index, 2),
    listen_port: self.meshListenPort ?? MESH_LISTEN_PORT,
    mtu: MESH_MTU,
    accept_fwmark: MESH_ACCEPT_FWMARK,
    rotate_key: rotating && self.wgPubkeyNext === null,
    activate_epoch: rotating ? self.meshActivateEpoch : null,
    peers,
    psks_sealed: psksSealed,
    forward_pairs: forwardPairs,
    node_addresses: all.map((n) => meshAddress(settings.supernet, n.meshIndex!, 1)),
    addresses: input.addresses.flatMap((r) => {
      const tag = input.netTags.get(r.environmentId);
      if (tag === undefined) return [];
      return [
        {
          ip: r.ip,
          env_tag: tag,
          node_id: r.nodeId,
          routed_ports: r.routedPorts,
          private_domain: r.privateDomain,
          healthy: r.healthy,
        },
      ];
    }),
  };
}

// -----------------------------------------------------------------------------
// Agent reports
// -----------------------------------------------------------------------------

/** Pushes new desired state to nodes. */
export type RefreshFn = (nodeIds: readonly string[]) => Promise<void>;

/**
 * Applies a node's `mesh_status`: readiness, and each tunnel's handshake.
 *
 * - A direct pair that hasn't handshaken {@link MESH_DIRECT_GRACE_MS} after
 *   it was configured, while both nodes are ready, falls back to a relay.
 * - A relayed fallback is tried direct again after {@link MESH_DIRECT_RETRY_MS}.
 * - A rotating node reporting its new epoch finishes the rotation.
 *
 * Nodes whose frames change are pushed new desired state.
 *
 * @param db - Database client.
 * @param nodeId - The reporting node.
 * @param status - The frame.
 * @param refresh - Pushes desired state to nodes.
 * @param now - Unix ms.
 */
export async function onMeshStatus(
  db: Db,
  nodeId: string,
  status: MeshStatus,
  refresh: RefreshFn,
  now = Date.now(),
): Promise<void> {
  const [before] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  const [node] = await db
    .update(nodes)
    .set({ meshReady: status.ready, meshError: status.error ?? null, meshStatusAt: new Date(now) })
    .where(and(eq(nodes.id, nodeId), isNull(nodes.deletedAt)))
    .returning();
  if (!node || !before) return;
  const settings = await getMeshSettings(db);
  if (!isMeshed(node, settings)) return;

  const toRefresh = new Set<string>();
  if (await finishRotation(db, node, status.epoch, now)) toRefresh.add(node.id);
  const all = await meshedNodes(db, node.workspaceId, settings);
  // Readiness gates the scheduler and DNS guidance, and other nodes route
  // through this one only while it is up.
  if (before.meshReady !== status.ready) for (const n of all) toRefresh.add(n.id);

  const byId = new Map(all.map((n) => [n.id, n]));
  const stored = await storedPaths(
    db,
    all.map((n) => n.id),
  );
  const reported = new Map(status.peers.map((p) => [p.node_id, p]));
  for (const peer of all) {
    if (peer.id === nodeId) continue;
    const key = pairKey(nodeId, peer.id);
    const row = stored.get(key);
    if (!row) continue;
    const report = reported.get(peer.id);
    let lastHandshake = row.lastHandshakeAt ? +row.lastHandshakeAt : null;
    if (report) {
      const side: MeshPairSide = {
        nodeId,
        endpoint: report.endpoint,
        lastHandshakeAt: report.last_handshake_ms,
        rxBytes: report.rx_bytes,
        txBytes: report.tx_bytes,
        reportedAt: now,
      };
      const handshake = report.last_handshake_ms;
      if (handshake !== null) lastHandshake = Math.max(lastHandshake ?? 0, handshake);
      // NOTE: both nodes of a pair report it, each through its own Durable
      // Object; one statement per side keeps either from losing the other's.
      await db
        .update(meshPaths)
        .set({
          sides: sql`json_set(COALESCE(${meshPaths.sides}, '{}'), ${`$."${nodeId}"`}, json(${JSON.stringify(side)}))`,
          ...(handshake !== null
            ? {
                lastHandshakeAt: sql`MAX(COALESCE(${meshPaths.lastHandshakeAt}, 0), ${handshake})`,
              }
            : {}),
          updatedAt: new Date(now),
        })
        .where(eq(meshPaths.pairKey, key));
    }
    const update: Partial<typeof meshPaths.$inferInsert> = {};
    const other = byId.get(peer.id)!;
    const directPossible = node.meshEndpoint !== null || other.meshEndpoint !== null;
    const relay = relayCandidates(all.map(asPathNode), nodeId, peer.id)[0];
    if (
      row.path === "direct" &&
      relay &&
      node.meshReady &&
      other.meshReady &&
      now - +row.configuredAt >= MESH_DIRECT_GRACE_MS &&
      (lastHandshake === null || now - lastHandshake >= MESH_HANDSHAKE_STALE_MS)
    ) {
      Object.assign(update, {
        path: "relayed",
        relayNodeId: relay.id,
        configuredAt: new Date(now),
        sides: {},
      });
      toRefresh.add(nodeId).add(peer.id).add(relay.id);
    } else if (
      row.path === "relayed" &&
      directPossible &&
      now - +(row.lastDirectAttemptAt ?? row.configuredAt) >= MESH_DIRECT_RETRY_MS
    ) {
      Object.assign(update, {
        path: "direct",
        relayNodeId: null,
        configuredAt: new Date(now),
        lastDirectAttemptAt: new Date(now),
        sides: {},
        lastHandshakeAt: null,
      });
      toRefresh.add(nodeId).add(peer.id);
      if (row.relayNodeId) toRefresh.add(row.relayNodeId);
    }
    if (Object.keys(update).length) {
      // Compare-and-swap: the peer's Durable Object may decide the same switch.
      await db
        .update(meshPaths)
        .set({ ...update, updatedAt: new Date(now) })
        .where(
          and(
            eq(meshPaths.pairKey, key),
            eq(meshPaths.path, row.path),
            eq(meshPaths.configuredAt, row.configuredAt),
          ),
        );
    }
  }
  if (toRefresh.size) await refresh([...toRefresh]);
}

/**
 * Finishes a node's rotation once it reports the new key's epoch: the next
 * key becomes the current one.
 *
 * @returns Whether a rotation finished.
 */
async function finishRotation(db: Db, node: NodeRow, epoch: number, now: number): Promise<boolean> {
  if (node.wgPubkeyNext === null || node.wgKeyNextEpoch === null) return false;
  if (epoch !== node.wgKeyNextEpoch) return false;
  const [done] = await db
    .update(nodes)
    .set({
      wgPubkey: node.wgPubkeyNext,
      wgKeyEpoch: node.wgKeyNextEpoch,
      wgPubkeyNext: null,
      wgKeyNextEpoch: null,
      wgKeyRotatedAt: new Date(now),
      meshRotateRequestedAt: null,
      meshRotateGeneration: null,
      meshRotateAnnouncedAt: null,
      meshActivateEpoch: null,
    })
    .where(and(eq(nodes.id, node.id), eq(nodes.wgKeyNextEpoch, node.wgKeyNextEpoch)))
    .returning({ id: nodes.id });
  return !!done;
}

/**
 * Applies a node's `mesh_key`: the key it generated after `rotate_key`.
 * Every pair of the node gets a new preshared key, and every peer (and the
 * node) is sent the new key and keys.
 *
 * SECURITY: accepted only while a rotation was asked for and for an epoch
 * past the current one, so a replayed or unsolicited frame changes nothing.
 *
 * @param db - Database client.
 * @param nodeId - The reporting node.
 * @param frame - The frame.
 * @param refresh - Pushes desired state to nodes.
 * @param now - Unix ms.
 * @returns Whether the key was taken.
 */
export async function onMeshKey(
  db: Db,
  nodeId: string,
  frame: MeshKey,
  refresh: RefreshFn,
  now = Date.now(),
): Promise<boolean> {
  const [node] = await db
    .update(nodes)
    .set({
      wgPubkeyNext: frame.public_key,
      wgKeyNextEpoch: frame.epoch,
      meshRotateAnnouncedAt: new Date(now),
    })
    .where(
      and(
        eq(nodes.id, nodeId),
        isNull(nodes.deletedAt),
        isNotNull(nodes.meshRotateRequestedAt),
        isNull(nodes.wgPubkeyNext),
        sql`${nodes.wgKeyEpoch} < ${frame.epoch}`,
      ),
    )
    .returning();
  if (!node) return false;
  await dropPairPsks(db, nodeId);
  const settings = await getMeshSettings(db);
  const all = await meshedNodes(db, node.workspaceId, settings);
  await refresh(all.map((n) => n.id));
  return true;
}

/**
 * Asks a meshed node to rotate its key. One node of a workspace rotates at
 * a time, so two nodes' tunnels never pause together.
 *
 * @param db - Database client.
 * @param nodeId - The node.
 * @param now - Unix ms.
 * @returns `started`, or why not.
 */
export async function requestRotation(
  db: Db,
  nodeId: string,
  now = Date.now(),
): Promise<"started" | "not_joined" | "in_progress" | "not_found"> {
  const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!node || node.deletedAt) return "not_found";
  const settings = await getMeshSettings(db);
  if (!isMeshed(node, settings)) return "not_joined";
  const [started] = await db
    .update(nodes)
    .set({ meshRotateRequestedAt: new Date(now) })
    .where(
      and(
        eq(nodes.id, nodeId),
        sql`NOT EXISTS (SELECT 1 FROM nodes AS other WHERE other.workspace_id = ${node.workspaceId}
          AND other.deleted_at IS NULL AND other.mesh_rotate_requested_at IS NOT NULL)`,
      ),
    )
    .returning({ id: nodes.id });
  return started ? "started" : "in_progress";
}

/**
 * Moves key rotations along; run on every heartbeat of a rotating node and
 * by the minute tick:
 * - a node whose new key reached every online peer (each caught up with the
 *   generation it was last sent), or whose peers had
 *   {@link MESH_ACTIVATE_AFTER_MS}, is told to activate it;
 * - a rotation the node never answered is dropped after
 *   {@link MESH_ROTATION_ABANDON_MS};
 * - with `scheduled`, nodes whose key is older than
 *   {@link MESH_KEY_MAX_AGE_MS} start one, one per workspace at a time.
 *
 * @param db - Database client.
 * @param refresh - Pushes desired state to nodes.
 * @param options - `now`, `nodeId` to look at one node only, `scheduled`
 *   to also start due rotations.
 * @returns How many nodes moved on.
 */
export async function progressRotations(
  db: Db,
  refresh: RefreshFn,
  options: { now?: number; nodeId?: string; scheduled?: boolean } = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const settings = await getMeshSettings(db);
  if (!settings.enabled) return 0;
  let moved = 0;
  const rotating = await db
    .select()
    .from(nodes)
    .where(
      and(
        isNull(nodes.deletedAt),
        isNotNull(nodes.meshRotateRequestedAt),
        ...(options.nodeId ? [eq(nodes.id, options.nodeId)] : []),
      ),
    );
  for (const node of rotating) {
    if (node.wgPubkeyNext === null) {
      if (now - +node.meshRotateRequestedAt! >= MESH_ROTATION_ABANDON_MS) {
        await db
          .update(nodes)
          .set({ meshRotateRequestedAt: null })
          .where(and(eq(nodes.id, node.id), isNull(nodes.wgPubkeyNext)));
        moved++;
      }
      continue;
    }
    if (node.meshActivateEpoch !== null) continue;
    const peers = (await meshedNodes(db, node.workspaceId, settings)).filter(
      (n) => n.id !== node.id && effectiveStatus(n, now) === "online",
    );
    const caughtUp = peers.every((p) => p.observedGeneration >= p.desiredGeneration);
    const announced = node.meshRotateAnnouncedAt ? +node.meshRotateAnnouncedAt : now;
    if (!caughtUp && now - announced < MESH_ACTIVATE_AFTER_MS) continue;
    const [set] = await db
      .update(nodes)
      .set({ meshActivateEpoch: node.wgKeyNextEpoch })
      .where(and(eq(nodes.id, node.id), isNull(nodes.meshActivateEpoch)))
      .returning({ id: nodes.id });
    if (set) {
      moved++;
      await refresh([node.id]);
    }
  }
  if (!options.scheduled) return moved;
  const due = await db
    .select()
    .from(nodes)
    .where(
      and(
        isNull(nodes.deletedAt),
        isNotNull(nodes.meshIndex),
        isNull(nodes.meshRotateRequestedAt),
        sql`COALESCE(${nodes.wgKeyRotatedAt}, ${nodes.createdAt}) <= ${now - MESH_KEY_MAX_AGE_MS}`,
      ),
    )
    .orderBy(asc(nodes.id))
    .limit(50);
  const started = new Set<string>();
  for (const node of due) {
    if (started.has(node.workspaceId) || !isMeshed(node, settings)) continue;
    if ((await requestRotation(db, node.id, now)) === "started") {
      started.add(node.workspaceId);
      moved++;
      await refresh([node.id]);
    }
  }
  return moved;
}

// -----------------------------------------------------------------------------
// Dashboard view
// -----------------------------------------------------------------------------

/**
 * The workspace's mesh as `GET /v1/workspaces/{ws}/mesh` returns it: every
 * live node (meshed or not, so the dashboard can say why not) and every
 * pair of meshed nodes with its path and latest handshake.
 *
 * A pair shows `down` when it has no path, when either side isn't ready,
 * or when a direct tunnel past its grace period has no recent handshake.
 *
 * @param db - Database client.
 * @param workspaceId - The workspace.
 * @param now - Unix ms.
 * @returns The view.
 */
export async function readMesh(db: Db, workspaceId: string, now = Date.now()): Promise<Mesh> {
  const settings = await getMeshSettings(db);
  const rows = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.workspaceId, workspaceId), isNull(nodes.deletedAt)))
    .orderBy(asc(nodes.name));
  const meshed = rows.filter((n) => isMeshed(n, settings));
  const stored = await storedPaths(
    db,
    meshed.map((n) => n.id),
  );
  const chosen = choosePaths(meshed.map(asPathNode), storedChoices(stored));
  const ready = new Map(meshed.map((n) => [n.id, n.meshReady]));
  const relays = new Set<string>();
  const pairs: MeshPair[] = [];
  for (const [key, c] of chosen) {
    const [a, b] = key.split("|") as [string, string];
    const row = stored.get(key);
    const last = row?.lastHandshakeAt ? +row.lastHandshakeAt : null;
    let path: MeshPair["path"] = c.path;
    if (!ready.get(a) || !ready.get(b)) path = "down";
    else if (
      c.path === "direct" &&
      row &&
      now - +row.configuredAt >= MESH_DIRECT_GRACE_MS &&
      (last === null || now - last >= MESH_HANDSHAKE_STALE_MS)
    ) {
      path = "down";
    }
    if (c.path === "relayed" && c.relay) relays.add(c.relay);
    pairs.push({
      nodes: [a, b],
      path,
      relay_node_id: c.path === "relayed" ? c.relay : null,
      last_handshake_at: last,
      sides:
        c.path === "direct"
          ? Object.values(row?.sides ?? {}).map((s) => ({
              node_id: s.nodeId,
              endpoint: s.endpoint,
              last_handshake_at: s.lastHandshakeAt,
              rx_bytes: s.rxBytes,
              tx_bytes: s.txBytes,
            }))
          : [],
    });
  }
  return {
    enabled: settings.enabled,
    supernet: settings.supernet,
    nodes: rows.map((n) => toMeshNode(n, settings, relays.has(n.id), now)),
    pairs,
  };
}

/**
 * One node as the mesh view shows it.
 *
 * @param n - The node's row.
 * @param settings - The mesh settings.
 * @param relay - It relays a pair.
 * @param now - Unix ms.
 * @returns The API shape.
 */
export function toMeshNode(
  n: NodeRow,
  settings: MeshSettings,
  relay: boolean,
  now = Date.now(),
): MeshNode {
  const meshed = isMeshed(n, settings);
  return {
    id: n.id,
    name: n.name,
    status: effectiveStatus(n, now),
    supported: n.protocolVersion >= MESH_PROTOCOL_VERSION,
    mesh_index: meshed ? n.meshIndex : null,
    address: meshed ? meshAddress(settings.supernet, n.meshIndex!, 1) : null,
    public_key: n.wgPubkey,
    mode: n.meshMode,
    nat: n.meshNat,
    endpoint: n.meshEndpoint,
    listen_port: n.meshListenPort,
    docker_firewall: n.meshDockerFirewall,
    accept_fwmark: n.meshAcceptFwmark,
    ready: meshed && n.meshReady,
    error: n.meshError,
    key_epoch: n.wgKeyEpoch,
    key_rotated_at: n.wgKeyRotatedAt ? +n.wgKeyRotatedAt : null,
    rotating: n.meshRotateRequestedAt !== null,
    relay,
    status_at: n.meshStatusAt ? +n.meshStatusAt : null,
  };
}

/**
 * The nodes whose frames list a node's mesh state: every meshed node of the
 * same workspaces as `nodeIds`, plus `nodeIds` themselves.
 *
 * @param db - Database client.
 * @param nodeIds - Nodes whose workloads or mesh state changed.
 * @param settings - The mesh settings.
 * @returns The nodes to refresh.
 */
export async function meshRefreshTargets(
  db: Db,
  nodeIds: readonly string[],
  settings: MeshSettings,
): Promise<string[]> {
  const out = new Set(nodeIds);
  if (!settings.enabled || !nodeIds.length) return [...out];
  const workspaces = new Set<string>();
  for (let i = 0; i < nodeIds.length; i += 50) {
    const rows = await db
      .select({ workspaceId: nodes.workspaceId, meshIndex: nodes.meshIndex })
      .from(nodes)
      .where(inArray(nodes.id, nodeIds.slice(i, i + 50)));
    for (const r of rows) if (r.meshIndex !== null) workspaces.add(r.workspaceId);
  }
  for (const ws of workspaces) {
    for (const n of await meshedNodes(db, ws, settings)) out.add(n.id);
  }
  return [...out];
}

/**
 * Whether a node can serve other nodes' replicas right now, for DNS
 * guidance: meshed, online, and its last report says ready.
 *
 * @param n - The node's row.
 * @param settings - The mesh settings.
 * @param now - Unix ms.
 * @returns `true` when other nodes' replicas are reachable through it.
 */
export function meshServing(n: NodeRow, settings: MeshSettings, now = Date.now()): boolean {
  return isMeshed(n, settings) && n.meshReady && effectiveStatus(n, now) === "online";
}

/**
 * Lets every node that already reported a usable `wg0` join the mesh, after
 * an instance admin turned it on.
 *
 * @param db - Database client.
 * @returns IDs of the nodes that joined.
 */
export async function joinWaitingNodes(db: Db): Promise<string[]> {
  const settings = await getMeshSettings(db);
  const waiting = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(isNull(nodes.deletedAt), isNull(nodes.meshIndex), isNotNull(nodes.wgPubkey)))
    .orderBy(asc(nodes.id));
  const joined: string[] = [];
  for (const n of waiting) {
    if ((await joinMesh(db, n.id, settings)) !== null) joined.push(n.id);
  }
  return joined;
}
