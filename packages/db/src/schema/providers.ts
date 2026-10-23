/**
 * Cloud provider integrations (ADR 0012 "Hetzner in the API and dashboard",
 * generalised to every `@roundhouse/providers` adapter):
 *
 * - `provider_credentials`: one sealed API token per workspace and provider.
 * - `node_provisions`: one row per one-click provisioning run, tracked from
 *   the request until the node joins (or the run fails).
 *
 * @module
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { id, json, timestamp, timestamps } from "./columns";
import { nodeJoinTokens, nodes } from "./nodes";
import type { SealedValue } from "./projects";
import { workspaces } from "./workspaces";

/** A provider ID from `@roundhouse/providers`. */
export type CloudProviderId = "hetzner" | "digitalocean" | "vultr" | "linode";

/**
 * A workspace's API token for one cloud provider. Write-only: the API seals
 * it on the way in and never returns it.
 */
export const providerCredentials = sqliteTable(
  "provider_credentials",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").$type<CloudProviderId>().notNull(),
    /**
     * Sealed through `sealInstanceSecret` with setting key
     * `provider_credential` and field `<workspace>:<provider>:<row id>`, so a
     * ciphertext can't be moved to another workspace, provider or row.
     */
    tokenSealed: json<SealedValue>("token_sealed").notNull(),
    /** Keyed fingerprint (8 hex) so operators can tell tokens apart without seeing them. */
    fingerprint: text("fingerprint").notNull(),
    /** Last four characters of the token. */
    tokenLast4: text("token_last4").notNull(),
    /** Account name or email as the provider reports it, for display. */
    accountLabel: text("account_label"),
    validatedAt: timestamp("validated_at").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [uniqueIndex("provider_credentials_ws_provider_uq").on(t.workspaceId, t.provider)],
);

/** States of a {@link nodeProvisions} row. */
export type NodeProvisionStatus =
  /** Accepted; the workflow has not started creating the server. */
  | "queued"
  /** Creating the server and waiting for it to run. */
  | "creating"
  /** The server runs; waiting for its agent to join. */
  | "booting"
  /** The agent joined; `node_id` is set. */
  | "joined"
  /** Nothing is left running; `failure_reason` says why. */
  | "failed"
  /** An operator cancelled the run and nothing is left running. */
  | "cancelled"
  /**
   * Failed or cancelled, and deleting the server failed too: it may still
   * bill. The hourly reconcile retries the delete.
   */
  | "cleanup_failed";

/** One one-click provisioning run. The ID is also the workflow instance ID. */
export const nodeProvisions = sqliteTable(
  "node_provisions",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").$type<CloudProviderId>().notNull(),
    /** Node name, server name and the provider-side idempotency key. */
    name: text("name").notNull(),
    plan: text("plan").notNull(),
    region: text("region").notNull(),
    builder: integer("builder", { mode: "boolean" }).notNull().default(false),
    status: text("status").$type<NodeProvisionStatus>().notNull().default("queued"),
    /** Latest `ProvisionStep` the adapter reported, for the progress view. */
    step: text("step"),
    /** `ProvisionError.reason`, `join_timeout` or `provider_error`. */
    failureReason: text("failure_reason"),
    /** Human-readable failure, safe to show; never contains a token. */
    failureMessage: text("failure_message"),
    serverId: text("server_id"),
    ipv4: text("ipv4"),
    ipv6: text("ipv6"),
    /** The join token in the server's user data. */
    joinTokenId: text("join_token_id").references(() => nodeJoinTokens.id, {
      onDelete: "set null",
    }),
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "set null" }),
    /**
     * Set when an operator asks to cancel. A run still creating its server
     * finishes the cancel itself once the provider call returns, since only
     * it knows the server; the workflow checks this between steps.
     */
    cancelRequestedAt: timestamp("cancel_requested_at"),
    /**
     * The chosen offer's monthly price in minor units, from the provider's
     * catalogue when the server was created. An estimate for display only:
     * the provider's invoice is authoritative.
     */
    monthlyCents: integer("monthly_cents"),
    /** ISO 4217 currency of {@link monthlyCents}. */
    currency: text("currency"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
    finishedAt: timestamp("finished_at"),
  },
  (t) => [index("node_provisions_workspace_idx").on(t.workspaceId, t.status)],
);
