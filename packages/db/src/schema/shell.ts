/**
 * Web shell sessions (ADR 0012 "Web shell", ADR 0014 §15): who opened a
 * shell into which replica, when, for how long and how it ended. Nothing
 * here holds terminal input or output, and `command` keeps only the program
 * (argv[0]): arguments may carry secrets.
 *
 * @module
 */
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { id, timestamp, timestamps } from "./columns";
import { nodes } from "./nodes";
import { environments, projects, services } from "./projects";
import { apiTokens, workspaces } from "./workspaces";

/** One shell session. Open while `ended_at` is `null`. */
export const shellSessions = sqliteTable(
  "shell_sessions",
  {
    /** `shl_…`, also the session ID on the wire. */
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    /** `wl_…` of the replica; a soft link, since placements are replaced on deploy. */
    workloadId: text("workload_id").notNull(),
    deploymentId: text("deployment_id"),
    replica: integer("replica").notNull(),
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Set when an API token opened it. */
    tokenId: text("token_id").references(() => apiTokens.id, { onDelete: "set null" }),
    /** Browser session that opened it; revoking that session closes the shell. */
    authSessionId: text("auth_session_id"),
    clientIp: text("client_ip"),
    /** argv[0] only: the arguments may carry secrets. */
    command: text("command").notNull(),
    /** The container user the agent reported (`exec_opened.user`). */
    containerUser: text("container_user"),
    startedAt: timestamp("started_at").notNull(),
    /** When the agent confirmed the process started. */
    openedAt: timestamp("opened_at"),
    endedAt: timestamp("ended_at"),
    /** A `ShellExitReason`, or `terminated` when someone ended it from the API. */
    endReason: text("end_reason"),
    exitCode: integer("exit_code"),
    bytesIn: integer("bytes_in").notNull().default(0),
    bytesOut: integer("bytes_out").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("shell_sessions_project_idx").on(t.projectId, t.startedAt),
    index("shell_sessions_workspace_idx").on(t.workspaceId, t.startedAt),
    index("shell_sessions_open_node_idx").on(t.nodeId).where(sql`ended_at IS NULL`),
    index("shell_sessions_open_user_idx").on(t.userId).where(sql`ended_at IS NULL`),
  ],
);
