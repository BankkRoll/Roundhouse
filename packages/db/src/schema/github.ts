/**
 * GitHub App installations known to this instance, the single-use state of
 * claiming one for a workspace, and the webhook replay guard. The App itself
 * (ID, private key, webhook secret) is an instance setting.
 *
 * @module
 */
import type { GithubAccountType } from "@roundhouse/shared";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { id, timestamp, timestamps } from "./columns";
import { workspaces } from "./workspaces";

/** One installation of the instance's GitHub App on a user or organization. */
export const githubInstallations = sqliteTable(
  "github_installations",
  {
    id: id(),
    /** GitHub's numeric installation ID. */
    installationId: integer("installation_id").notNull().unique(),
    accountLogin: text("account_login").notNull(),
    /** GitHub's numeric ID of the account the App is installed on; logins can be renamed. */
    accountId: integer("account_id"),
    accountType: text("account_type").$type<GithubAccountType>().notNull(),
    /**
     * Workspace that claimed the installation; `null` until one does. Only a
     * user proven (through GitHub OAuth) to administer the account can claim.
     */
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
    claimedBy: text("claimed_by").references(() => users.id, { onDelete: "set null" }),
    claimedAt: timestamp("claimed_at"),
    ...timestamps,
  },
  (t) => [index("github_installations_workspace_idx").on(t.workspaceId)],
);

/**
 * State of one installation claim, created when a user starts installing
 * the App for a workspace and consumed (once) by the callback. The signed
 * `state` parameter carries this row's ID.
 */
export const githubClaimStates = sqliteTable(
  "github_claim_states",
  {
    /** `ghc_…`, carried in the signed OAuth/install `state`. */
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at").notNull(),
    /** Set by the callback; a second use of the same state is refused. */
    consumedAt: timestamp("consumed_at"),
    ...timestamps,
  },
  (t) => [index("github_claim_states_expires_idx").on(t.expiresAt)],
);

/**
 * Webhook deliveries already accepted, keyed by `X-GitHub-Delivery`, so a
 * redelivered or replayed payload is processed at most once. The body hash
 * catches a replay under a fresh delivery ID (the header isn't signed).
 */
export const githubDeliveries = sqliteTable(
  "github_deliveries",
  {
    /** GitHub's delivery GUID. */
    id: text("id").primaryKey(),
    /** `X-GitHub-Event`. */
    event: text("event").notNull(),
    /**
     * Lowercase hex SHA-256 of the raw signed body. Unique, so the same body
     * is accepted once whatever delivery ID it arrives with. `NULL` on rows
     * from before ADR 0014.
     */
    bodyHash: text("body_hash").unique(),
    ...timestamps,
  },
  (t) => [index("github_deliveries_created_idx").on(t.createdAt)],
);
