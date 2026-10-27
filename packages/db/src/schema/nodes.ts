/**
 * Nodes (machines running the agent) and the single-use tokens that let them join.
 *
 * @module
 */
import type { Capabilities, VolumeQuotaMode } from "@roundhouse/protocol";
import type { DrainMoveState, NodeDrainStatus, NodeStatus } from "@roundhouse/shared";
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { id, json, timestamp, timestamps } from "./columns";
import { workspaces } from "./workspaces";

/**
 * Where a node's compute comes from: `server` for machines joined by hand,
 * otherwise the cloud provider (`@roundhouse/providers` ID) that created it.
 */
export type NodeProvider = "server" | "hetzner" | "digitalocean" | "vultr" | "linode";

/** A machine running the node agent. */
export const nodes = sqliteTable(
  "nodes",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hostname: text("hostname"),
    provider: text("provider").$type<NodeProvider>().notNull().default("server"),
    region: text("region"),
    /** The provider's server ID, for nodes Roundhouse provisioned; deleting the node deletes it. */
    providerServerId: text("provider_server_id"),
    /**
     * When reconciliation first found the provider no longer has the server
     * (deleted in the provider's console); cleared when it reappears.
     */
    providerServerMissingAt: timestamp("provider_server_missing_at"),
    labels: json<Record<string, string>>("labels")
      .notNull()
      .$defaultFn(() => ({})),
    publicIp: text("public_ip"),
    /**
     * DNS name clients reach the node at, for TCP proxy endpoints; the public
     * IP is used when unset.
     */
    publicHostname: text("public_hostname"),
    /** The node's mesh address (`wg0`, its `.1`); set when it joins the mesh. */
    wgIp: text("wg_ip"),
    /** Current WireGuard public key, base64, from `hello.mesh`; the private key never leaves the node. */
    wgPubkey: text("wg_pubkey"),
    /**
     * The node's /24 in the mesh supernet (1–254, ADR 0005), unique among
     * live nodes; `null` until it joins the mesh.
     */
    meshIndex: integer("mesh_index"),
    /** The key a rotation moves to, from `mesh_key`; peers use it from then on. */
    wgPubkeyNext: text("wg_pubkey_next"),
    /** Epoch of {@link nodes.wgPubkey}; 0 for the key the node joined with. */
    wgKeyEpoch: integer("wg_key_epoch").notNull().default(0),
    /** Epoch of {@link nodes.wgPubkeyNext}. */
    wgKeyNextEpoch: integer("wg_key_next_epoch"),
    wgKeyRotatedAt: timestamp("wg_key_rotated_at"),
    /** A rotation was asked for (operator or the 90-day schedule) and hasn't finished. */
    meshRotateRequestedAt: timestamp("mesh_rotate_requested_at"),
    /** Desired-state generation of the peers' frames carrying the new key. */
    meshRotateGeneration: integer("mesh_rotate_generation"),
    /** When the peers were sent the new key; activation follows within 60 s. */
    meshRotateAnnouncedAt: timestamp("mesh_rotate_announced_at"),
    /** Epoch the node is told to swap to (`desired_state.mesh.activate_epoch`). */
    meshActivateEpoch: integer("mesh_activate_epoch"),
    meshMode: text("mesh_mode").$type<"kernel" | "userspace" | "unavailable">(),
    meshNat: text("mesh_nat").$type<"public" | "nat">(),
    /** Where peers reach the node (`host:port`), `null` behind NAT; see `lib/mesh.ts`. */
    meshEndpoint: text("mesh_endpoint"),
    /** Agent config `mesh.endpoint`. */
    meshEndpointOverride: text("mesh_endpoint_override"),
    meshListenPort: integer("mesh_listen_port"),
    meshDockerFirewall: text("mesh_docker_firewall").$type<"iptables" | "nftables">(),
    meshAcceptFwmark: integer("mesh_accept_fwmark", { mode: "boolean" }),
    /** `mesh_status.ready` as last reported; the scheduler spans environments only over ready nodes. */
    meshReady: integer("mesh_ready", { mode: "boolean" }).notNull().default(false),
    meshError: text("mesh_error"),
    meshStatusAt: timestamp("mesh_status_at"),
    /**
     * The htpasswd user this node pulls from the builder's registry with,
     * over the mesh (ADR 0005, "Registry over the mesh"); derived from the
     * node ID. Set with the password the first time it is needed.
     */
    registryPullUser: text("registry_pull_user"),
    /** Its password, sealed under the KEK (setting `registry_pull`, field = node ID). */
    registryPullPasswordSealed: json<unknown>("registry_pull_password_sealed"),
    /** bcrypt of the password, computed once when the password is made, for `pull_users`. */
    registryPullBcrypt: text("registry_pull_bcrypt"),
    /**
     * When the node's stateless replicas were last rescheduled because it was
     * offline; cleared when it comes back, so one outage reschedules once.
     */
    rescheduledAt: timestamp("rescheduled_at"),
    /** Agent's Ed25519 identity key from join, base64. */
    identityPublicKey: text("identity_public_key").notNull(),
    /**
     * Agent's X25519 encryption key, base64: variables and build secrets are
     * sealed to it. Set at join, or once through a signed
     * `hello.encryption_key` for nodes that joined before protocol 4.
     * Nodes without one get no workloads or builds.
     */
    encryptionPublicKey: text("encryption_public_key"),
    /** `nodeEncryptionKeyId(encryption_public_key)`. */
    encryptionKeyId: text("encryption_key_id"),
    encryptionKeyRegisteredAt: timestamp("encryption_key_registered_at"),
    /**
     * Control-plane signing kids the agent accepts (ADR 0014 §13): the kid
     * handed out at join, then `hello.pinned_kids`, plus successors announced
     * to it since. Picks the key its frames are signed with during a
     * rollover, and shows which nodes would need a re-join after one.
     */
    pinnedSigningKids: json<string[]>("pinned_signing_kids"),
    /**
     * How the node enforces volume quotas, from `hello.volume_quota`; a volume
     * migration refuses an enforcing source moving to a `none` target.
     */
    volumeQuota: text("volume_quota").$type<VolumeQuotaMode>(),
    /** SHA-256 of the bearer credential the agent uses to connect. */
    credentialHash: text("credential_hash").notNull().unique(),
    status: text("status").$type<NodeStatus>().notNull().default("pending"),
    os: text("os"),
    arch: text("arch"),
    kernel: text("kernel"),
    dockerVersion: text("docker_version"),
    agentVersion: text("agent_version"),
    /**
     * `hello.protocol_version` of the agent's latest connection. Builds and
     * workloads only go to agents at `SEALED_ENV_PROTOCOL_VERSION` or later.
     */
    protocolVersion: integer("protocol_version").notNull().default(1),
    capabilities: json<Capabilities>("capabilities"),
    cpuTotal: integer("cpu_total"),
    memTotal: integer("mem_total"),
    diskTotal: integer("disk_total"),
    // Latest heartbeat snapshot; history lives in Analytics Engine.
    cpuPercent: real("cpu_percent"),
    memUsed: integer("mem_used"),
    diskUsed: integer("disk_used"),
    load1: real("load1"),
    desiredGeneration: integer("desired_generation").notNull().default(0),
    observedGeneration: integer("observed_generation").notNull().default(0),
    lastHeartbeatAt: timestamp("last_heartbeat_at"),
    ...timestamps,
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    index("nodes_workspace_idx").on(t.workspaceId),
    uniqueIndex("nodes_mesh_index_uq")
      .on(t.meshIndex)
      .where(sql`${t.meshIndex} IS NOT NULL AND ${t.deletedAt} IS NULL`),
  ],
);

/** How two meshed nodes reach each other (ADR 0005, "Pair paths"). */
export type MeshPath = "direct" | "relayed" | "down";

/** One side of a pair's tunnel as that node last reported it in `mesh_status`. */
export interface MeshPairSide {
  nodeId: string;
  endpoint: string | null;
  lastHandshakeAt: number | null;
  rxBytes: number;
  txBytes: number;
  reportedAt: number;
}

/**
 * The WireGuard preshared key of a pair of nodes, sealed under the KEK with
 * AAD `mesh-psk:<pair_key>`. Rotated whenever either node's key rotates.
 */
export const meshPsks = sqliteTable("mesh_psks", {
  /** `<lower node id>|<higher node id>`. */
  pairKey: text("pair_key").primaryKey(),
  pskSealed: json<unknown>("psk_sealed").notNull(),
  ...timestamps,
});

/** The path the control plane chose for a pair, and its health. */
export const meshPaths = sqliteTable("mesh_paths", {
  /** `<lower node id>|<higher node id>`. */
  pairKey: text("pair_key").primaryKey(),
  path: text("path").$type<MeshPath>().notNull(),
  relayNodeId: text("relay_node_id").references(() => nodes.id, { onDelete: "set null" }),
  /** When the pair was last configured on this path; a direct path gets 120 s to handshake. */
  configuredAt: timestamp("configured_at").notNull(),
  lastHandshakeAt: timestamp("last_handshake_at"),
  /** When the pair last went direct; a relayed fallback tries direct again after 30 min. */
  lastDirectAttemptAt: timestamp("last_direct_attempt_at"),
  /**
   * Each side's latest report for the tunnel, by node ID. Each side's report
   * is written with `json_set`, so the two nodes' Durable Objects never
   * overwrite each other's.
   */
  sides: json<Record<string, MeshPairSide>>("sides"),
  ...timestamps,
});

/** One replica move of a drain, as {@link nodeDrains} records it. */
export interface NodeDrainMove {
  workloadId: string;
  deploymentId: string;
  serviceId: string;
  environmentId: string;
  replica: number;
  state: DrainMoveState;
  toNodeId: string | null;
  newWorkloadId: string | null;
  error: string | null;
}

/** A volume service a drain can't move. */
export interface NodeDrainBlock {
  serviceId: string;
  environmentId: string;
  serviceName: string;
}

/**
 * One drain of a node (ADR 0005, "Node lifecycle"), driven by
 * `DRAIN_WORKFLOW`, with each move's progress for the dashboard.
 */
export const nodeDrains = sqliteTable(
  "node_drains",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    /** Volume services are stopped (and degraded) instead of blocking the drain. */
    force: integer("force", { mode: "boolean" }).notNull().default(false),
    status: text("status").$type<NodeDrainStatus>().notNull().default("running"),
    moves: json<NodeDrainMove[]>("moves")
      .notNull()
      .$defaultFn(() => []),
    blocked: json<NodeDrainBlock[]>("blocked")
      .notNull()
      .$defaultFn(() => []),
    error: text("error"),
    /** `drain-<node>-<ts>`. */
    workflowInstanceId: text("workflow_instance_id"),
    startedBy: text("started_by").references(() => users.id, { onDelete: "set null" }),
    finishedAt: timestamp("finished_at"),
    ...timestamps,
  },
  (t) => [index("node_drains_node_idx").on(t.nodeId, t.id)],
);

/** Single-use token that lets a new machine join a workspace. Only the hash is stored. */
export const nodeJoinTokens = sqliteTable(
  "node_join_tokens",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("node_join_tokens_workspace_idx").on(t.workspaceId)],
);
