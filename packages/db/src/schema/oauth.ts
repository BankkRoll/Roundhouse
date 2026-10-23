/**
 * OAuth 2.1 for MCP clients (ADR 0012 section 1): the control plane is its own
 * authorization server, and its access tokens are `api_tokens` rows with
 * `kind = 'oauth'`, so RBAC and revocation reuse the token machinery.
 *
 * - `oauth_clients`: cached Client ID Metadata Documents, keyed by URL.
 * - `oauth_codes`: single-use authorization codes (60 s), hashed.
 * - `oauth_grants`: one user's consent for one client in one workspace;
 *   revoking it revokes every token issued under it.
 * - `oauth_refresh_tokens`: every refresh token a grant was issued, hashed,
 *   so presenting a spent one is detected and revokes the grant.
 *
 * @module
 */
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { json, timestamp, timestamps } from "./columns";
import { workspaces } from "./workspaces";

/**
 * A client known by its Client ID Metadata Document. `client_id` is the
 * document's HTTPS URL; the row is a cache, refreshed after 24 h.
 */
export const oauthClients = sqliteTable("oauth_clients", {
  /** SHA-256 hex of `client_id`. */
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().unique(),
  name: text("name").notNull(),
  logoUri: text("logo_uri"),
  clientUri: text("client_uri"),
  redirectUris: json<string[]>("redirect_uris").notNull(),
  fetchedAt: timestamp("fetched_at").notNull(),
  ...timestamps,
});

/** An issued authorization code. Only its SHA-256 is stored. */
export const oauthCodes = sqliteTable(
  "oauth_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    clientId: text("client_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scopes: json<string[]>("scopes").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    /** S256 PKCE challenge (base64url SHA-256 of the verifier). */
    codeChallenge: text("code_challenge").notNull(),
    resource: text("resource").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    /** Set when exchanged; a second exchange finds it set and revokes `grant_id`. */
    usedAt: timestamp("used_at"),
    /** The grant the exchange created. Not a foreign key: expired codes are pruned, grants are not. */
    grantId: text("grant_id"),
    ...timestamps,
  },
  (t) => [index("oauth_codes_expires_idx").on(t.expiresAt)],
);

/** Why a grant stopped working. */
export type OAuthGrantRevocation = "user" | "client" | "refresh_reuse" | "code_reuse" | "member";

/** One user's consent for one client in one workspace. */
export const oauthGrants = sqliteTable(
  "oauth_grants",
  {
    /** `oag_…` */
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    /** The client's name when consented, shown under "Connected apps". */
    clientName: text("client_name").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    scopes: json<string[]>("scopes").notNull(),
    /** Audience of every access token issued under the grant (the `/mcp` URL). */
    resource: text("resource").notNull(),
    /** Slides forward on every refresh. */
    refreshExpiresAt: timestamp("refresh_expires_at").notNull(),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
    revokedReason: text("revoked_reason").$type<OAuthGrantRevocation>(),
    ...timestamps,
  },
  (t) => [
    index("oauth_grants_user_idx").on(t.userId),
    index("oauth_grants_workspace_idx").on(t.workspaceId),
  ],
);

/** A refresh token issued under a grant. Only its SHA-256 is stored. */
export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    grantId: text("grant_id")
      .notNull()
      .references(() => oauthGrants.id, { onDelete: "cascade" }),
    /** Set when rotated; presenting it again means it leaked. */
    usedAt: timestamp("used_at"),
    ...timestamps,
  },
  (t) => [index("oauth_refresh_tokens_grant_idx").on(t.grantId)],
);
