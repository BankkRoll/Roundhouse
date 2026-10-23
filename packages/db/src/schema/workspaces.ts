/**
 * Tenancy tables: workspaces, their members and invites, API tokens, and the
 * audit log.
 *
 * @module
 */
import type { AuditAction, AuditActorType, Role } from "@openrail/shared";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { id, json, timestamp, timestamps } from "./columns";

/** Tenancy boundary: every project, node, and token belongs to a workspace. */
export const workspaces = sqliteTable("workspaces", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  ...timestamps,
  deletedAt: timestamp("deleted_at"),
});

/** A user's role within a workspace. */
export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<Role>().notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("workspace_members_ws_user_uq").on(t.workspaceId, t.userId),
    index("workspace_members_user_idx").on(t.userId),
  ],
);

/** Pending invitation to join a workspace. Only the token hash is stored. */
export const invites = sqliteTable(
  "invites",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").$type<Role>().notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    ...timestamps,
  },
  (t) => [index("invites_workspace_idx").on(t.workspaceId)],
);

/** Programmatic access token, owned by a user or a workspace. Only the hash is stored. */
export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: id(),
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    scopes: json<string[]>("scopes").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    /** First characters of the secret (`tok_` and four more), shown so people can tell tokens apart. */
    tokenPrefix: text("token_prefix"),
    lastUsedAt: timestamp("last_used_at"),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    ...timestamps,
  },
  (t) => [index("api_tokens_workspace_idx").on(t.workspaceId)],
);

/** Append-only record of every mutating action. */
export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: id(),
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    actorType: text("actor_type").$type<AuditActorType>().notNull(),
    actorId: text("actor_id"),
    action: text("action").$type<AuditAction>().notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: json<Record<string, unknown>>("metadata"),
    ip: text("ip"),
    ...timestamps,
  },
  // IDs are monotonic ULIDs, so (workspace_id, id) serves the newest-first
  // keyset pagination in the audit-log route without a separate sort.
  (t) => [index("audit_logs_workspace_id_idx").on(t.workspaceId, t.id)],
);
