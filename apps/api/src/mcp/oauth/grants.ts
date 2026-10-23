/**
 * Grants and the tokens issued under them (ADR 0012 section 1):
 *
 * - {@link exchangeAuthorizationCode}: PKCE-checked, single-use code →
 *   a new grant, an access token and a refresh token. A code presented twice
 *   revokes the grant the first exchange created.
 * - {@link refreshGrant}: a rotating, single-use refresh token → a new pair,
 *   sliding the grant's 30-day window. A spent refresh token revokes the grant.
 * - {@link revokeGrant}: ends a grant and every access token under it.
 * - {@link resolveOAuthAccessToken}: an `oat_` secret → its principal, for `/mcp` only.
 *
 * Access tokens are `api_tokens` rows (`kind = 'oauth'`, `audience` = the
 * `/mcp` URL), so `requireWorkspace` caps them by the user's current role like
 * every token. Only SHA-256 hashes of codes and tokens are stored.
 *
 * @module
 */
import {
  apiTokens,
  type Db,
  type OAuthGrantRevocation,
  oauthCodes,
  oauthGrants,
  oauthRefreshTokens,
  users,
  workspaceMembers,
  workspaces,
} from "@roundhouse/db";
import { type ApiTokenScope, isApiTokenScope, newId, type Role } from "@roundhouse/shared";
import { and, eq, gt, isNotNull, isNull, lt } from "drizzle-orm";
import { type AuditEntry, auditInsert } from "../../lib/audit";
import { hashToken, randomToken } from "../../lib/crypto";
import { resourceMatches } from "./authorize";
import {
  ACCESS_TOKEN_TTL_MS,
  AUTHORIZATION_CODE_TTL_MS,
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_REFRESH_TOKEN_PREFIX,
  REFRESH_TOKEN_TTL_MS,
} from "./config";
import { OAuthFailure } from "./errors";

/** The token endpoint's success body (RFC 6749 section 5.1). */
export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Who and where a token request comes from, for audit records. */
export interface RequestMeta {
  ip: string | null;
  now?: number;
}

const MAX_SECRET_LENGTH = 256;
const LAST_USED_RESOLUTION_MS = 60_000;

const invalidGrant = (description: string) => new OAuthFailure("invalid_grant", description);

async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const b64url = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const a = new TextEncoder().encode(b64url);
  const b = new TextEncoder().encode(challenge);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

/** The user's current role in a live workspace, or `null` when they're no longer a member. */
async function memberRole(db: Db, userId: string, workspaceId: string): Promise<Role | null> {
  const [row] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(1);
  return row?.role ?? null;
}

interface MintInput {
  grantId: string;
  userId: string;
  workspaceId: string;
  clientName: string;
  scopes: readonly string[];
  resource: string;
  now: number;
}

/** A fresh access + refresh pair and the rows that store their hashes. */
async function mintPair(input: MintInput) {
  const access = randomToken(OAUTH_ACCESS_TOKEN_PREFIX.slice(0, -1));
  const refresh = randomToken(OAUTH_REFRESH_TOKEN_PREFIX.slice(0, -1));
  const accessRow = {
    id: newId("apiToken"),
    workspaceId: input.workspaceId,
    userId: input.userId,
    name: input.clientName,
    scopes: [...input.scopes],
    tokenHash: await hashToken(access),
    tokenPrefix: access.slice(0, OAUTH_ACCESS_TOKEN_PREFIX.length + 4),
    expiresAt: new Date(input.now + ACCESS_TOKEN_TTL_MS),
    kind: "oauth" as const,
    audience: input.resource,
    oauthGrantId: input.grantId,
  } satisfies typeof apiTokens.$inferInsert;
  const refreshRow = {
    tokenHash: await hashToken(refresh),
    grantId: input.grantId,
  } satisfies typeof oauthRefreshTokens.$inferInsert;
  const response: TokenResponse = {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_MS / 1000,
    refresh_token: refresh,
    scope: input.scopes.join(" "),
  };
  return { accessRow, refreshRow, response };
}

function revokedAudit(
  grant: { id: string; workspaceId: string; userId: string; clientId: string; clientName: string },
  reason: OAuthGrantRevocation,
  actor: Pick<AuditEntry, "actorType" | "actorId">,
  ip: string | null,
): AuditEntry {
  return {
    workspaceId: grant.workspaceId,
    ...actor,
    action: "mcp_client.revoked",
    targetType: "mcp_client",
    targetId: grant.id,
    metadata: { name: grant.clientName, client_id: grant.clientId, reason },
    ip,
  };
}

/**
 * Revokes a grant and every access token issued under it. Idempotent: a
 * grant already revoked is left as is and nothing is audited.
 *
 * @param db - Database client.
 * @param grantId - The grant.
 * @param reason - Why, recorded on the grant and in the audit entry.
 * @param actor - Who revoked it: the user, or `system` for reuse detection.
 * @param meta - Client IP and clock.
 * @returns `true` when this call revoked it.
 */
export async function revokeGrant(
  db: Db,
  grantId: string,
  reason: OAuthGrantRevocation,
  actor: Pick<AuditEntry, "actorType" | "actorId">,
  meta: RequestMeta,
): Promise<boolean> {
  const now = new Date(meta.now ?? Date.now());
  const [grant] = await db
    .update(oauthGrants)
    .set({ revokedAt: now, revokedReason: reason, updatedAt: now })
    .where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)))
    .returning();
  if (!grant) return false;
  await db.batch([
    db
      .update(apiTokens)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(apiTokens.oauthGrantId, grantId), isNull(apiTokens.revokedAt))),
    db.delete(oauthRefreshTokens).where(eq(oauthRefreshTokens.grantId, grantId)),
    auditInsert(db, revokedAudit(grant, reason, actor, meta.ip)),
  ]);
  return true;
}

/** The token endpoint's `authorization_code` parameters. */
export interface CodeExchange {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  /** Optional on the token request; must match the code's when sent. */
  resource?: string;
}

/**
 * Exchanges an authorization code for a new grant and its first tokens.
 *
 * The code is claimed (`used_at` set) before anything is checked, so a
 * failed attempt burns it too and a verifier can't be guessed across tries.
 *
 * @param db - Database client.
 * @param input - Code, client, redirect URI, PKCE verifier and resource.
 * @param clientName - Display name for the grant and its tokens.
 * @param meta - Client IP and clock.
 * @returns The token response.
 * @throws {OAuthFailure} `invalid_grant` for an unknown, expired, reused or
 *   mismatched code, or a wrong verifier; `invalid_target` for a wrong resource.
 */
export async function exchangeAuthorizationCode(
  db: Db,
  input: CodeExchange,
  clientName: (clientId: string) => Promise<string>,
  meta: RequestMeta,
): Promise<TokenResponse> {
  const now = meta.now ?? Date.now();
  if (input.code.length > MAX_SECRET_LENGTH) throw invalidGrant("Unknown authorization code");
  const codeHash = await hashToken(input.code);
  // NOTE: Expired codes are pruned here rather than by the retention cron;
  // the index on expires_at keeps it cheap, and codes only matter for a minute.
  await db
    .delete(oauthCodes)
    .where(lt(oauthCodes.expiresAt, new Date(now - 10 * AUTHORIZATION_CODE_TTL_MS)));
  const [code] = await db
    .update(oauthCodes)
    .set({ usedAt: new Date(now), updatedAt: new Date(now) })
    .where(and(eq(oauthCodes.codeHash, codeHash), isNull(oauthCodes.usedAt)))
    .returning();
  if (!code) {
    const [spent] = await db
      .select({ grantId: oauthCodes.grantId })
      .from(oauthCodes)
      .where(and(eq(oauthCodes.codeHash, codeHash), isNotNull(oauthCodes.usedAt)))
      .limit(1);
    // SECURITY: OAuth 2.1 section 4.1.3: a code used twice may have been
    // intercepted, so whatever the first use obtained is revoked.
    if (spent?.grantId) {
      await revokeGrant(
        db,
        spent.grantId,
        "code_reuse",
        { actorType: "system", actorId: null },
        meta,
      );
    }
    throw invalidGrant("Unknown or already used authorization code");
  }
  if (+code.expiresAt <= now) throw invalidGrant("The authorization code has expired");
  if (code.clientId !== input.clientId) throw invalidGrant("The code was issued to another client");
  if (code.redirectUri !== input.redirectUri) throw invalidGrant("redirect_uri does not match");
  if (!(await pkceMatches(input.codeVerifier, code.codeChallenge))) {
    throw invalidGrant("code_verifier does not match the code_challenge");
  }
  if (input.resource !== undefined && !resourceMatches(input.resource, code.resource)) {
    throw new OAuthFailure("invalid_target", `This code is for ${code.resource}`);
  }
  if (!(await memberRole(db, code.userId, code.workspaceId))) {
    throw invalidGrant("The user is no longer a member of the workspace");
  }
  const name = await clientName(code.clientId);
  const grantId = newId("oauthGrant");
  const scopes = code.scopes.filter(isApiTokenScope);
  const pair = await mintPair({
    grantId,
    userId: code.userId,
    workspaceId: code.workspaceId,
    clientName: name,
    scopes,
    resource: code.resource,
    now,
  });
  await db.batch([
    db.insert(oauthGrants).values({
      id: grantId,
      clientId: code.clientId,
      clientName: name,
      userId: code.userId,
      workspaceId: code.workspaceId,
      scopes,
      resource: code.resource,
      refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
      lastUsedAt: new Date(now),
    }),
    db.insert(oauthRefreshTokens).values(pair.refreshRow),
    db.insert(apiTokens).values(pair.accessRow),
    db.update(oauthCodes).set({ grantId }).where(eq(oauthCodes.codeHash, codeHash)),
  ]);
  return pair.response;
}

/** The token endpoint's `refresh_token` parameters. */
export interface RefreshRequest {
  refreshToken: string;
  clientId: string;
  /** Narrows the new access token's scopes; never widens them. */
  scope?: readonly string[];
  resource?: string;
}

/**
 * Rotates a refresh token: the presented one is spent, and a new access and
 * refresh token are issued under the same grant.
 *
 * @param db - Database client.
 * @param input - Refresh token, client and optional narrower scope.
 * @param meta - Client IP and clock.
 * @returns The token response.
 * @throws {OAuthFailure} `invalid_grant` for an unknown, spent, expired or
 *   revoked token, a client mismatch, or a user who left the workspace;
 *   `invalid_scope` for a wider scope; `invalid_target` for another resource.
 */
export async function refreshGrant(
  db: Db,
  input: RefreshRequest,
  meta: RequestMeta,
): Promise<TokenResponse> {
  const now = meta.now ?? Date.now();
  if (input.refreshToken.length > MAX_SECRET_LENGTH) throw invalidGrant("Unknown refresh token");
  const tokenHash = await hashToken(input.refreshToken);
  const reuse = async (grantId: string) => {
    // SECURITY: A rotated refresh token coming back means two parties hold
    // it; the grant can't tell which is legitimate, so it ends for both.
    await revokeGrant(db, grantId, "refresh_reuse", { actorType: "system", actorId: null }, meta);
    return invalidGrant("Unknown or already used refresh token");
  };
  const [presented] = await db
    .select({ grantId: oauthRefreshTokens.grantId, usedAt: oauthRefreshTokens.usedAt })
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.tokenHash, tokenHash))
    .limit(1);
  if (!presented) throw invalidGrant("Unknown or already used refresh token");
  if (presented.usedAt) throw await reuse(presented.grantId);
  const [grant] = await db
    .select()
    .from(oauthGrants)
    .where(eq(oauthGrants.id, presented.grantId))
    .limit(1);
  if (!grant || grant.revokedAt) throw invalidGrant("The grant has been revoked");
  if (+grant.refreshExpiresAt <= now) throw invalidGrant("The refresh token has expired");
  if (grant.clientId !== input.clientId)
    throw invalidGrant("The token was issued to another client");
  if (input.resource !== undefined && !resourceMatches(input.resource, grant.resource)) {
    throw new OAuthFailure("invalid_target", `This grant is for ${grant.resource}`);
  }
  const granted = grant.scopes.filter(isApiTokenScope);
  let scopes: readonly ApiTokenScope[] = granted;
  if (input.scope?.length) {
    const wider = input.scope.filter((s) => !(granted as readonly string[]).includes(s));
    if (wider.length) throw new OAuthFailure("invalid_scope", `Not granted: ${wider.join(" ")}`);
    scopes = [...new Set(input.scope)] as ApiTokenScope[];
  }
  if (!(await memberRole(db, grant.userId, grant.workspaceId))) {
    await revokeGrant(db, grant.id, "member", { actorType: "system", actorId: null }, meta);
    throw invalidGrant("The user is no longer a member of the workspace");
  }
  // The token is spent only once the request is known to succeed, so a
  // client's malformed retry doesn't look like theft; losing this race to a
  // concurrent use of the same token does.
  const [claimed] = await db
    .update(oauthRefreshTokens)
    .set({ usedAt: new Date(now), updatedAt: new Date(now) })
    .where(and(eq(oauthRefreshTokens.tokenHash, tokenHash), isNull(oauthRefreshTokens.usedAt)))
    .returning({ grantId: oauthRefreshTokens.grantId });
  if (!claimed) throw await reuse(grant.id);
  const pair = await mintPair({
    grantId: grant.id,
    userId: grant.userId,
    workspaceId: grant.workspaceId,
    clientName: grant.clientName,
    scopes,
    resource: grant.resource,
    now,
  });
  await db.batch([
    db.insert(oauthRefreshTokens).values(pair.refreshRow),
    db.insert(apiTokens).values(pair.accessRow),
    db
      .update(oauthGrants)
      .set({
        refreshExpiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
        lastUsedAt: new Date(now),
        updatedAt: new Date(now),
      })
      .where(eq(oauthGrants.id, grant.id)),
    // PERF: Every refresh mints a row; expired access tokens and refresh
    // tokens past any possible use are dropped here so a grant stays small.
    db
      .delete(apiTokens)
      .where(
        and(
          eq(apiTokens.oauthGrantId, grant.id),
          lt(apiTokens.expiresAt, new Date(now - ACCESS_TOKEN_TTL_MS)),
        ),
      ),
    db
      .delete(oauthRefreshTokens)
      .where(
        and(
          eq(oauthRefreshTokens.grantId, grant.id),
          lt(oauthRefreshTokens.usedAt, new Date(now - REFRESH_TOKEN_TTL_MS)),
        ),
      ),
  ]);
  return pair.response;
}

/**
 * The revocation endpoint (RFC 7009): either token of a grant ends the grant.
 * Unknown tokens, and tokens of another client, are ignored, as the RFC
 * requires a 200 either way.
 *
 * @param db - Database client.
 * @param token - Presented token.
 * @param clientId - `client_id`, when the client sent one.
 * @param meta - Client IP and clock.
 */
export async function revokeByToken(
  db: Db,
  token: string,
  clientId: string | undefined,
  meta: RequestMeta,
): Promise<void> {
  if (token.length > MAX_SECRET_LENGTH) return;
  const hash = await hashToken(token);
  let grantId: string | null = null;
  if (token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)) {
    const [row] = await db
      .select({ grantId: oauthRefreshTokens.grantId })
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.tokenHash, hash))
      .limit(1);
    grantId = row?.grantId ?? null;
  } else if (token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
    const [row] = await db
      .select({ grantId: apiTokens.oauthGrantId })
      .from(apiTokens)
      .where(and(eq(apiTokens.tokenHash, hash), eq(apiTokens.kind, "oauth")))
      .limit(1);
    grantId = row?.grantId ?? null;
  }
  if (!grantId) return;
  const [grant] = await db
    .select({ clientId: oauthGrants.clientId, userId: oauthGrants.userId })
    .from(oauthGrants)
    .where(eq(oauthGrants.id, grantId))
    .limit(1);
  if (!grant || (clientId !== undefined && clientId !== grant.clientId)) return;
  await revokeGrant(db, grantId, "client", { actorType: "user", actorId: grant.userId }, meta);
}

/** An OAuth access token resolved for `/mcp`. */
export interface OAuthPrincipalRow {
  id: string;
  name: string;
  workspaceId: string;
  scopes: readonly ApiTokenScope[];
  grantId: string;
  clientId: string;
  expiresAt: number;
  user: { id: string; name: string; email: string; image: string | null };
}

/**
 * Looks up the live OAuth access token a secret belongs to.
 *
 * @param db - Database client.
 * @param secret - Presented bearer secret.
 * @param audience - The resource being called; must equal the token's audience.
 * @param now - Current time, unix ms.
 * @returns The token, or `null` when unknown, expired, revoked, issued for
 *   another audience, its grant is revoked, or its user left the workspace.
 */
export async function resolveOAuthAccessToken(
  db: Db,
  secret: string,
  audience: string,
  now = Date.now(),
): Promise<OAuthPrincipalRow | null> {
  if (!secret.startsWith(OAUTH_ACCESS_TOKEN_PREFIX) || secret.length > MAX_SECRET_LENGTH) {
    return null;
  }
  const [row] = await db
    .select({ token: apiTokens, user: users, grant: oauthGrants })
    .from(apiTokens)
    .innerJoin(oauthGrants, eq(oauthGrants.id, apiTokens.oauthGrantId))
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .innerJoin(workspaces, eq(workspaces.id, apiTokens.workspaceId))
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, apiTokens.workspaceId),
        eq(workspaceMembers.userId, apiTokens.userId),
      ),
    )
    .where(
      and(
        eq(apiTokens.tokenHash, await hashToken(secret)),
        eq(apiTokens.kind, "oauth"),
        isNull(apiTokens.revokedAt),
        isNull(oauthGrants.revokedAt),
        isNull(workspaces.deletedAt),
        gt(apiTokens.expiresAt, new Date(now)),
      ),
    )
    .limit(1);
  // SECURITY: RFC 8707 audience binding: a token minted for another resource
  // (or a future second resource on this server) is refused here.
  if (!row || row.token.audience !== audience) return null;
  const { token, user, grant } = row;
  if (!token.lastUsedAt || now - +token.lastUsedAt >= LAST_USED_RESOLUTION_MS) {
    await db.batch([
      db
        .update(apiTokens)
        .set({ lastUsedAt: new Date(now) })
        .where(eq(apiTokens.id, token.id)),
      db
        .update(oauthGrants)
        .set({ lastUsedAt: new Date(now) })
        .where(eq(oauthGrants.id, grant.id)),
    ]);
  }
  return {
    id: token.id,
    name: token.name,
    workspaceId: token.workspaceId!,
    scopes: token.scopes.filter(isApiTokenScope),
    grantId: grant.id,
    clientId: grant.clientId,
    expiresAt: +token.expiresAt!,
    user: { id: user.id, name: user.name, email: user.email, image: user.image ?? null },
  };
}

/** A grant as the dashboard lists it. */
export interface ConnectedClient {
  id: string;
  client_id: string;
  name: string;
  domain: string;
  workspace: { id: string; name: string };
  scopes: ApiTokenScope[];
  created_at: number;
  last_used_at: number | null;
  expires_at: number;
}

/**
 * The user's live grants: unrevoked, with a refresh window still open.
 *
 * @param db - Database client.
 * @param userId - The signed-in user.
 * @param now - Current time, unix ms.
 * @returns Newest first.
 */
export async function listConnectedClients(
  db: Db,
  userId: string,
  now = Date.now(),
): Promise<ConnectedClient[]> {
  const rows = await db
    .select({ grant: oauthGrants, workspaceName: workspaces.name })
    .from(oauthGrants)
    .innerJoin(workspaces, eq(workspaces.id, oauthGrants.workspaceId))
    .where(
      and(
        eq(oauthGrants.userId, userId),
        isNull(oauthGrants.revokedAt),
        isNull(workspaces.deletedAt),
        gt(oauthGrants.refreshExpiresAt, new Date(now)),
      ),
    );
  return rows
    .map(({ grant, workspaceName }) => ({
      id: grant.id,
      client_id: grant.clientId,
      name: grant.clientName,
      domain: new URL(grant.clientId).hostname,
      workspace: { id: grant.workspaceId, name: workspaceName },
      scopes: grant.scopes.filter(isApiTokenScope),
      created_at: +grant.createdAt,
      last_used_at: grant.lastUsedAt ? +grant.lastUsedAt : null,
      expires_at: +grant.refreshExpiresAt,
    }))
    .sort((a, b) => b.created_at - a.created_at);
}

/**
 * Finds one of the user's grants, revoked or not.
 *
 * @param db - Database client.
 * @param userId - The signed-in user.
 * @param grantId - Grant from the route.
 * @returns The grant, or `undefined` when it isn't theirs.
 */
export async function findUserGrant(db: Db, userId: string, grantId: string) {
  const [grant] = await db
    .select()
    .from(oauthGrants)
    .where(and(eq(oauthGrants.id, grantId), eq(oauthGrants.userId, userId)))
    .limit(1);
  return grant;
}
