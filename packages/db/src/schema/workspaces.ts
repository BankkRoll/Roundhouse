/**
 * Tenancy tables: workspaces, their members, teams and invites, API tokens,
 * and the hash-chained audit log.
 *
 * @module
 */
import type {
  AuditAction,
  AuditActorType,
  MemberDefaultProjectRole,
  Role,
  ViewerDefaultProjectRole,
} from "@roundhouse/shared";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { id, json, timestamp, timestamps } from "./columns";

/** Tenancy boundary: every project, node, and token belongs to a workspace. */
export const workspaces = sqliteTable("workspaces", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  /** Project role every `member` has on every project; see `impliedProjectRole`. */
  memberDefaultProjectRole: text("member_default_project_role")
    .$type<MemberDefaultProjectRole>()
    .notNull()
    .default("developer"),
  /** Project role every `viewer` has on every project. */
  viewerDefaultProjectRole: text("viewer_default_project_role")
    .$type<ViewerDefaultProjectRole>()
    .notNull()
    .default("viewer"),
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

/**
 * A named group of workspace members, used as a principal for project
 * grants and protection rules. Managed with `members:manage`.
 */
export const teams = sqliteTable(
  "teams",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    ...timestamps,
  },
  (t) => [uniqueIndex("teams_ws_slug_uq").on(t.workspaceId, t.slug)],
);

/**
 * Membership of a user in a team. The user must be a member of the team's
 * workspace; removing them from the workspace removes these rows (the API
 * deletes them in the same batch).
 */
export const teamMembers = sqliteTable(
  "team_members",
  {
    id: id(),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("team_members_team_user_uq").on(t.teamId, t.userId),
    index("team_members_user_idx").on(t.userId),
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
    lastUsedAt: timestamp("last_used_at"),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    ...timestamps,
  },
  (t) => [index("api_tokens_workspace_idx").on(t.workspaceId)],
);

/**
 * Append-only, hash-chained record of every mutating action and every
 * sign-in. One chain for the whole install, appended only through the
 * `AuditChain` Durable Object so `seq` and `prev_hash` never fork.
 *
 * `workspace_id` is a soft link, not a foreign key: deleting a workspace must
 * not delete its history. `NULL` means an instance-level entry (see
 * `INSTANCE_AUDIT_ACTIONS`), visible to instance admins only.
 */
export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: id(),
    workspaceId: text("workspace_id"),
    /** Position in the chain, from 1. Entries before ADR 0014 have no hash. */
    seq: integer("seq").notNull().unique(),
    /** `hash` of entry `seq - 1`; 64 zeros for the first chained entry. `NULL` before the chain. */
    prevHash: text("prev_hash"),
    /** Lowercase hex SHA-256 of the entry's canonical form; see ADR 0014. `NULL` before the chain. */
    hash: text("hash"),
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
  (t) => [
    index("audit_logs_workspace_id_idx").on(t.workspaceId, t.id),
    index("audit_logs_action_idx").on(t.action, t.id),
  ],
);
