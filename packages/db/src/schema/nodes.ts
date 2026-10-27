/**
 * Nodes (machines running the agent) and the single-use tokens that let them join.
 *
 * @module
 */
import type { Capabilities, VolumeQuotaMode } from "@roundhouse/protocol";
import type { NodeStatus } from "@roundhouse/shared";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
    wgIp: text("wg_ip"),
    wgPubkey: text("wg_pubkey"),
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
  (t) => [index("nodes_workspace_idx").on(t.workspaceId)],
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
