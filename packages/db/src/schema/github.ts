/**
 * GitHub App installations known to this instance. The App itself (ID,
 * private key, webhook secret) is an instance setting.
 *
 * @module
 */
import type { GithubAccountType } from "@roundhouse/shared";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { id, timestamps } from "./columns";
import { workspaces } from "./workspaces";

/** One installation of the instance's GitHub App on a user or organization. */
export const githubInstallations = sqliteTable(
  "github_installations",
  {
    id: id(),
    /** GitHub's numeric installation ID. */
    installationId: integer("installation_id").notNull().unique(),
    accountLogin: text("account_login").notNull(),
    accountType: text("account_type").$type<GithubAccountType>().notNull(),
    /** Workspace that claimed the installation; `null` until one does. */
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("github_installations_workspace_idx").on(t.workspaceId)],
);

/**
 * Webhook deliveries already accepted, keyed by `X-GitHub-Delivery`, so a
 * redelivered or replayed payload is processed at most once.
 */
export const githubDeliveries = sqliteTable(
  "github_deliveries",
  {
    /** GitHub's delivery GUID. */
    id: text("id").primaryKey(),
    /** `X-GitHub-Event`. */
    event: text("event").notNull(),
    ...timestamps,
  },
  (t) => [index("github_deliveries_created_idx").on(t.createdAt)],
);
