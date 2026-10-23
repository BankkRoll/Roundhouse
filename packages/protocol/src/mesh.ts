/**
 * WireGuard mesh contracts (ADR 0005), from `MESH_PROTOCOL_VERSION`:
 * - `hello.mesh`: the node's public key and reachability; the private key
 *   never leaves the node;
 * - `desired_state.mesh`: address plan, peers (preshared keys sealed), relay
 *   pairs and the cluster's mesh IPs for nftables;
 * - `mesh_status` and `mesh_key`: agent reports.
 *
 * Mirrored by `go/mesh.go`.
 *
 * @module
 */
import { z } from "zod";
import { SealedBoxSchema } from "./box";
import {
  boundedString,
  Count,
  HostPortString,
  Ipv4CidrString,
  Ipv4String,
  ipv4InCidr,
  MAX_MESH_ADDRESSES,
  MAX_MESH_ALLOWED_IPS,
  MAX_MESH_FORWARD_PAIRS,
  MAX_MESH_PEERS,
  MAX_MESSAGE_BYTES,
  MAX_PORTS,
  NodeIdString,
  PortNumber,
  UnixMillis,
} from "./limits";

const Base64Key32 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "expected a base64 32-byte key");

/** How the agent runs `wg0`: kernel module, embedded wireguard-go, or not at all. */
export const MESH_MODES = ["kernel", "userspace", "unavailable"] as const;

/** Reachability the agent infers: `public` when the observed address is on one of its interfaces. */
export const MESH_NAT_KINDS = ["public", "nat"] as const;

/** Docker's firewall backend, which decides how accepted mesh packets get past Docker's drop. */
export const DOCKER_FIREWALLS = ["iptables", "nftables"] as const;

/** The mesh part of `hello`. */
export const HelloMeshSchema = z.object({
  /** WireGuard public key, standard base64 of 32 bytes. */
  public_key: Base64Key32,
  listen_port: PortNumber,
  mode: z.enum(MESH_MODES),
  nat: z.enum(MESH_NAT_KINDS),
  /** Agent config `mesh.endpoint`, for nodes reachable only through a port forward. */
  endpoint_override: HostPortString.nullable(),
  docker_firewall: z.enum(DOCKER_FIREWALLS),
  /** Docker accepts packets carrying `accept_fwmark` (DOCKER-USER rule or `--bridge-accept-fwmark`). */
  accept_fwmark: z.boolean(),
});

/** The mesh part of `hello`. */
export type HelloMesh = z.infer<typeof HelloMeshSchema>;

/** One WireGuard peer. Its preshared key travels in `MeshConfig.psks_sealed`. */
export const MeshPeerSchema = z.object({
  node_id: NodeIdString,
  public_key: Base64Key32,
  /** `null` on the public side of a direct pair: it learns the address by roaming. */
  endpoint: HostPortString.nullable(),
  /** The peer's /24, plus the /24s of pairs it relays for this node. */
  allowed_ips: z.array(Ipv4CidrString).min(1).max(MAX_MESH_ALLOWED_IPS),
  keepalive_s: z.union([z.literal(0), z.literal(25)]),
});

/** One WireGuard peer. */
export type MeshPeer = z.infer<typeof MeshPeerSchema>;

/** A mesh IP this node must know for NAT and isolation rules. */
export const MeshAddressSchema = z.object({
  ip: Ipv4String,
  /** `environments.net_tag`: small, unique per install, keys the nftables sets. */
  env_tag: z.number().int().min(1).max(65_535),
  node_id: NodeIdString,
  /** Ports with an ingress route, admitted from other nodes' `.1` addresses. */
  routed_ports: z.array(PortNumber).max(MAX_PORTS),
});

/** A mesh IP this node must know. */
export type MeshAddress = z.infer<typeof MeshAddressSchema>;

/**
 * `desired_state.mesh`: everything the agent needs to run `wg0`, the private
 * DNS listener and the `inet roundhouse` table. `null` in a `desired_state`
 * means mesh off: the agent tears `wg0` and its table down.
 */
export const MeshConfigSchema = z
  .object({
    /** Instance `mesh_supernet`, e.g. `10.200.0.0/16`; at most a /16 so 254 /24s fit. */
    supernet: Ipv4CidrString.refine((c) => Number(c.split("/")[1]) <= 16, {
      message: "the supernet must be a /16 or larger",
    }),
    node_index: z.number().int().min(1).max(254),
    /** `wg0` address, the node's `.1`. */
    address: Ipv4String,
    /** Private DNS listener on `rh-dns0`, the node's `.2`. */
    dns_address: Ipv4String,
    listen_port: PortNumber,
    mtu: z.number().int().min(1280).max(1500),
    /** The fwmark Docker accepts, e.g. `0x2000000`. */
    accept_fwmark: z.number().int().min(1).max(0xffff_ffff),
    /** Generate a new key, keep the old one, and report it in `mesh_key`. */
    rotate_key: z.boolean(),
    /** Swap to the key of this `mesh_key.epoch`. */
    activate_epoch: z.number().int().positive().nullable(),
    peers: z.array(MeshPeerSchema).max(MAX_MESH_PEERS),
    /**
     * `SealedMeshPsksSchema` (one key per peer), AAD `meshPsksAad`. Present
     * exactly when `peers` is non-empty, which makes the frame
     * credential-bearing.
     */
    psks_sealed: SealedBoxSchema.nullable(),
    /** CIDR pairs this node relays `wg0 → wg0`. */
    forward_pairs: z.array(z.tuple([Ipv4CidrString, Ipv4CidrString])).max(MAX_MESH_FORWARD_PAIRS),
    /** Every node's `.1`: the "ingress source" set. */
    node_addresses: z.array(Ipv4String).max(MAX_MESH_PEERS + 1),
    /** Every mesh IP of every environment with a replica on this node, local and remote. */
    addresses: z.array(MeshAddressSchema).max(MAX_MESH_ADDRESSES),
  })
  .superRefine((m, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });
    for (const field of ["address", "dns_address"] as const) {
      if (!ipv4InCidr(m[field], m.supernet)) issue(`${field} must be inside the supernet`, [field]);
    }
    if (new Set(m.peers.map((p) => p.node_id)).size !== m.peers.length) {
      issue("duplicate peer", ["peers"]);
    }
    if (m.peers.length > 0 !== (m.psks_sealed !== null)) {
      issue("psks_sealed is required exactly when there are peers", ["psks_sealed"]);
    }
    if (new Set(m.addresses.map((a) => a.ip)).size !== m.addresses.length) {
      issue("duplicate mesh address", ["addresses"]);
    }
    m.addresses.forEach((a, i) => {
      if (!ipv4InCidr(a.ip, m.supernet))
        issue("mesh ips must be inside the supernet", ["addresses", i]);
    });
  });

/** `desired_state.mesh`. */
export type MeshConfig = z.infer<typeof MeshConfigSchema>;

/** One peer as `wg0` sees it. */
export const MeshPeerStatusSchema = z.object({
  node_id: NodeIdString,
  last_handshake_ms: UnixMillis.nullable(),
  endpoint: HostPortString.nullable(),
  rx_bytes: Count,
  tx_bytes: Count,
});

/** One peer as `wg0` sees it. */
export type MeshPeerStatus = z.infer<typeof MeshPeerStatusSchema>;

/** Mesh health, every 30 s and on change (at most 4/s). */
export const MeshStatusSchema = z.object({
  type: z.literal("mesh_status"),
  /** Epoch of the key `wg0` currently uses. */
  epoch: Count,
  peers: z.array(MeshPeerStatusSchema).max(MAX_MESH_PEERS),
  /** `wg0` up, nftables applied, DNS listening. */
  ready: z.boolean(),
  /** Why the mesh isn't ready, e.g. a missing fwmark rule. */
  error: boundedString(MAX_MESSAGE_BYTES, 1).optional(),
});

/** Mesh health. */
export type MeshStatus = z.infer<typeof MeshStatusSchema>;

/** The next WireGuard public key, after `desired_state.mesh.rotate_key`. */
export const MeshKeySchema = z.object({
  type: z.literal("mesh_key"),
  public_key: Base64Key32,
  /** Increases with every rotation; `activate_epoch` names it. */
  epoch: z.number().int().positive(),
});

/** The next WireGuard public key. */
export type MeshKey = z.infer<typeof MeshKeySchema>;
