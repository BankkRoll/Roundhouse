/**
 * API tokens: issuing them, resolving a presented secret to its principal,
 * and the wire shape of a stored token.
 *
 * A secret is `tok_` plus 256 random bits (base64url). Only its SHA-256 is
 * stored, with the first few characters kept in clear so people can tell
 * tokens apart. A token authenticates only while it is unrevoked, unexpired,
 * its workspace is live and its creator is still a member there; the
 * creator's current role bounds what its scopes can do (see
 * `requireWorkspace`).
 *
 * @module
 */
import { apiTokens, type Db, users, workspaceMembers, workspaces } from "@openrail/db";
import {
  type Action,
  API_TOKEN_DISPLAY_PREFIX_LENGTH,
  API_TOKEN_PREFIX,
  type ApiTokenScope,
  isApiTokenScope,
  newId,
  type Role,
} from "@openrail/shared";
import { and, eq, isNull } from "drizzle-orm";
import { hashToken, randomToken } from "./crypto";

/** How stale `last_used_at` may get before a request refreshes it. */
export const LAST_USED_RESOLUTION_MS = 60_000;

/** Longest secret worth hashing; real ones are 47 characters. */
const MAX_SECRET_LENGTH = 256;

/** A token resolved from a request's bearer secret. */
export interface TokenPrincipalRow {
  id: string;
  name: string;
  workspaceId: string;
  scopes: readonly Action[];
  /** Creator's current role in the token's workspace. */
  role: Role;
  user: { id: string; name: string; email: string; image: string | null };
}

/**
 * Whether an `Authorization` value is a bearer credential, and its secret.
 *
 * @param header - The raw `Authorization` header, if any.
 * @returns The secret after `Bearer `, or `null` when the header isn't a bearer one.
 */
export function bearerSecret(header: string | undefined): string | null {
  const match = header ? /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header) : null;
  return match ? match[1]! : null;
}

/**
 * Looks up the live token a secret belongs to.
 *
 * @param db - Database client.
 * @param secret - Presented secret.
 * @param now - Current time, unix ms.
 * @returns The token and its creator, or `null` when the secret is unknown,
 *   revoked, expired, or its creator or workspace is gone.
 */
export async function resolveApiToken(
  db: Db,
  secret: string,
  now = Date.now(),
): Promise<TokenPrincipalRow | null> {
  if (!secret.startsWith(API_TOKEN_PREFIX) || secret.length > MAX_SECRET_LENGTH) return null;
  const [row] = await db
    .select({ token: apiTokens, user: users, role: workspaceMembers.role })
    .from(apiTokens)
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
        isNull(apiTokens.revokedAt),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(1);
  if (!row || (row.token.expiresAt && +row.token.expiresAt <= now)) return null;
  const { token, user } = row;
  if (
    !token.lastUsedAt ||
    now - +token.lastUsedAt >= LAST_USED_RESOLUTION_MS ||
    +token.lastUsedAt > now
  ) {
    await db
      .update(apiTokens)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(apiTokens.id, token.id));
  }
  return {
    id: token.id,
    name: token.name,
    workspaceId: token.workspaceId!,
    scopes: token.scopes.filter(isApiTokenScope),
    role: row.role,
    user: { id: user.id, name: user.name, email: user.email, image: user.image ?? null },
  };
}

/** What a new token is created with. */
export interface NewApiToken {
  workspaceId: string;
  userId: string;
  name: string;
  scopes: readonly ApiTokenScope[];
  /** `null` for a token that never expires. */
  expiresAt: Date | null;
}

/**
 * Generates a secret and the row that stores its hash.
 *
 * @param input - Owner, name, scopes and expiry.
 * @returns The secret (return it to the caller once) and the row to insert.
 */
export async function issueApiToken(input: NewApiToken) {
  const secret = randomToken(API_TOKEN_PREFIX.slice(0, -1));
  const row = {
    id: newId("apiToken"),
    workspaceId: input.workspaceId,
    userId: input.userId,
    name: input.name,
    scopes: [...input.scopes],
    tokenHash: await hashToken(secret),
    tokenPrefix: secret.slice(0, API_TOKEN_DISPLAY_PREFIX_LENGTH),
    expiresAt: input.expiresAt,
  } satisfies typeof apiTokens.$inferInsert;
  return { secret, row };
}

/**
 * @param t - Token row.
 * @param creatorName - Name of the creator, when the account still exists.
 * @returns The `ApiToken` wire shape. Never includes the hash.
 */
export function toApiToken(t: typeof apiTokens.$inferSelect, creatorName: string | null) {
  return {
    id: t.id,
    name: t.name,
    scopes: t.scopes.filter(isApiTokenScope),
    prefix: t.tokenPrefix,
    created_by: t.userId ? { user_id: t.userId, name: creatorName } : null,
    last_used_at: t.lastUsedAt ? +t.lastUsedAt : null,
    expires_at: t.expiresAt ? +t.expiresAt : null,
    revoked_at: t.revokedAt ? +t.revokedAt : null,
    created_at: +t.createdAt,
  };
}
