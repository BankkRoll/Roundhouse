/**
 * Nodes (machines running the agent) and the single-use tokens that let them join.
 *
 * @module
 */
import type { Capabilities } from "@openrail/protocol";
import type { NodeStatus } from "@openrail/shared";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { id, json, timestamp, timestamps } from "./columns";
import { workspaces } from "./workspaces";

/** Where a node's compute comes from. */
export type NodeProvider = "server" | "hetzner";

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
    labels: json<Record<string, string>>("labels")
      .notNull()
      .$defaultFn(() => ({})),
    publicIp: text("public_ip"),
    wgIp: text("wg_ip"),
    wgPubkey: text("wg_pubkey"),
    /** Agent's Ed25519 identity key from join, base64. */
    identityPublicKey: text("identity_public_key").notNull(),
    /** SHA-256 of the bearer credential the agent uses to connect. */
    credentialHash: text("credential_hash").notNull().unique(),
    status: text("status").$type<NodeStatus>().notNull().default("pending"),
    os: text("os"),
    arch: text("arch"),
    kernel: text("kernel"),
    dockerVersion: text("docker_version"),
    agentVersion: text("agent_version"),
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
