/**
 * Mesh tables of the mock database (ADR 0005): each server's reported mesh state and
 * the pairs between servers. Whether the mesh is on, and its supernet, live with the
 * instance settings (`db.deploy.instance`).
 *
 * The default seed has the mesh off and nobody joined, as on a new install.
 * `seedMeshNetwork` (in `mesh-handlers.ts`) turns it on with five meshed servers: two
 * public, two behind NAT whose pair is relayed through `hel-1`, and one whose Docker
 * firewall drops mesh packets, so its pairs are down. `nbg-1 ↔ lab-1` is down too: its
 * last handshake is ten minutes old, as when a firewall blocks UDP 51820.
 *
 * @module
 */
import type { MeshNode, MeshPair, NodeDrain } from "../lib/api/mesh-client";
import type { Node } from "../lib/api/types";

/** A server's mesh state, without the fields its node row already has. */
export type DbMeshNode = Omit<MeshNode, "id" | "name" | "status">;

/** Every mesh table. */
export interface MeshDb {
  /** Mesh state by node id; a node without a row never reported any. */
  nodes: Record<string, DbMeshNode>;
  pairs: MeshPair[];
  /** Each server's latest drain, by node id. */
  drains: Record<string, NodeDrain>;
}

/** Ids of the servers {@link seedMeshNetwork} adds or joins, for tests. */
export const MESH_SEED = {
  hel: "node_hel1",
  nbg: "node_nbg1",
  home: "node_home1",
  lab: "node_lab1",
  office: "node_office1",
  pending: "node_fsn1",
} as const;

/**
 * The mesh state of a server that never reported any: supported when its agent has
 * connected, not joined.
 *
 * @param node - The server.
 * @returns Its state.
 */
export function unjoinedMeshNode(node: Pick<Node, "agent_version">): DbMeshNode {
  return {
    supported: node.agent_version !== null,
    mesh_index: null,
    address: null,
    public_key: null,
    mode: null,
    nat: null,
    endpoint: null,
    listen_port: null,
    docker_firewall: null,
    accept_fwmark: null,
    ready: false,
    error: null,
    key_epoch: 0,
    key_rotated_at: null,
    rotating: false,
    relay: false,
    status_at: null,
  };
}

/** @returns Empty mesh tables. */
export function emptyMesh(): MeshDb {
  return { nodes: {}, pairs: [], drains: {} };
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MB = 1024 ** 2;

function joined(index: number, now: number, fields: Partial<DbMeshNode>): DbMeshNode {
  return {
    supported: true,
    mesh_index: index,
    address: `10.200.${index}.1`,
    public_key: `${"A".repeat(42)}${index}=`,
    mode: "kernel",
    nat: "public",
    endpoint: null,
    listen_port: 51820,
    docker_firewall: "iptables",
    accept_fwmark: true,
    ready: true,
    error: null,
    key_epoch: 1,
    key_rotated_at: now - 12 * DAY,
    rotating: false,
    relay: false,
    status_at: now - 20_000,
    ...fields,
  };
}

function pair(
  a: string,
  b: string,
  path: MeshPair["path"],
  lastHandshakeAt: number | null,
  extra: Partial<MeshPair> = {},
): MeshPair {
  const nodes = (a < b ? [a, b] : [b, a]) as [string, string];
  return {
    nodes,
    path,
    relay_node_id: null,
    last_handshake_at: lastHandshakeAt,
    sides: [],
    ...extra,
  };
}

/** The extra servers {@link seedMeshNetwork} adds beside `hel-1` and `fsn-1`. */
export const MESH_SEED_NODES: { id: string; name: string; public_ip: string | null }[] = [
  { id: MESH_SEED.nbg, name: "nbg-1", public_ip: "203.0.113.20" },
  { id: MESH_SEED.home, name: "home-1", public_ip: null },
  { id: MESH_SEED.lab, name: "lab-1", public_ip: null },
  { id: MESH_SEED.office, name: "office-1", public_ip: null },
];

/**
 * Builds the mesh tables of a five-server network.
 *
 * @param now - Reference time.
 * @returns The tables.
 */
export function seededMesh(now: number): MeshDb {
  const { hel, nbg, home, lab, office } = MESH_SEED;
  return {
    drains: {},
    nodes: {
      [hel]: joined(1, now, { endpoint: "203.0.113.10:51820", relay: true }),
      [nbg]: joined(2, now, {
        mode: "userspace",
        endpoint: "203.0.113.20:51820",
        docker_firewall: "nftables",
      }),
      [home]: joined(3, now, { nat: "nat" }),
      [lab]: joined(4, now, { nat: "nat" }),
      [office]: joined(5, now, {
        nat: "nat",
        docker_firewall: "nftables",
        accept_fwmark: false,
        ready: false,
        error: "Docker's nftables backend drops forwarded mesh packets",
      }),
    },
    pairs: [
      pair(hel, nbg, "direct", now - 40_000, {
        sides: [
          {
            node_id: hel,
            endpoint: "203.0.113.20:51820",
            last_handshake_at: now - 40_000,
            rx_bytes: 182 * MB,
            tx_bytes: 96 * MB,
          },
          {
            node_id: nbg,
            endpoint: "203.0.113.10:51820",
            last_handshake_at: now - 41_000,
            rx_bytes: 95 * MB,
            tx_bytes: 181 * MB,
          },
        ],
      }),
      pair(hel, home, "direct", now - 55_000, {
        sides: [
          {
            node_id: hel,
            endpoint: "198.51.100.7:40211",
            last_handshake_at: now - 55_000,
            rx_bytes: 12 * MB,
            tx_bytes: 30 * MB,
          },
        ],
      }),
      pair(hel, lab, "direct", now - 70_000),
      pair(nbg, home, "direct", now - 30_000),
      pair(nbg, lab, "down", now - 10 * MINUTE),
      pair(home, lab, "relayed", now - 25_000, { relay_node_id: hel }),
      pair(hel, office, "down", null),
      pair(nbg, office, "down", null),
      pair(home, office, "down", null),
      pair(lab, office, "down", null),
    ],
  };
}
