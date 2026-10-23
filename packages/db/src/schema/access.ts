/**
 * Project access grants: a project role given to a user or a team. The
 * effective role is resolved by `resolveAccess` in `@roundhouse/shared`.
 *
 * @module
 */
import type { ProjectRole } from "@roundhouse/shared";
import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { id, timestamps } from "./columns";
import { projects } from "./projects";
import { teams } from "./workspaces";

/** Kinds of principal a grant targets. */
export type GrantPrincipalType = "user" | "team";

/** One project role for one user or team. At most one grant per principal and project. */
export const projectAccessGrants = sqliteTable(
  "project_access_grants",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    principalType: text("principal_type").$type<GrantPrincipalType>().notNull(),
    /** Set exactly when `principal_type` is `user`. */
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** Set exactly when `principal_type` is `team`. */
    teamId: text("team_id").references(() => teams.id, { onDelete: "cascade" }),
    role: text("role").$type<ProjectRole>().notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    // NOTE: NULLs are distinct in SQLite unique indexes, so each principal
    // type gets its own partial index (as variables do per scope).
    uniqueIndex("project_access_grants_user_uq")
      .on(t.projectId, t.userId)
      .where(sql`principal_type = 'user'`),
    uniqueIndex("project_access_grants_team_uq")
      .on(t.projectId, t.teamId)
      .where(sql`principal_type = 'team'`),
    index("project_access_grants_user_idx").on(t.userId),
    index("project_access_grants_team_idx").on(t.teamId),
    check(
      "project_access_grants_principal_ck",
      sql`(principal_type = 'user' AND user_id IS NOT NULL AND team_id IS NULL) OR (principal_type = 'team' AND team_id IS NOT NULL AND user_id IS NULL)`,
    ),
  ],
);
