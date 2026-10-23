/**
 * Session freshness for dangerous actions (ADR 0014 "Auth"): routes whose
 * policy has `reauth: true` call {@link requireFreshSession}. A session is
 * fresh within `REAUTH_WINDOW_MS` of signing in or of `POST /v1/auth/reauth`
 * (which sets `sessions.reauthenticated_at`).
 *
 * Owned by the api-auth stream; the api-authz-rbac-github stream calls it
 * from the route guard.
 *
 * @module
 */
import { sessions } from "@roundhouse/db";
import { isFreshSession, REAUTH_WINDOW_MS } from "@roundhouse/shared";
import { eq } from "drizzle-orm";
import { type AppContext, currentPrincipal } from "../context";
import { ApiError } from "./errors";

/**
 * Until when the caller's session counts as fresh.
 *
 * @param c - Request context.
 * @returns Unix ms, or `null` without a browser session (API tokens are never fresh).
 */
export async function freshUntil(c: AppContext): Promise<number | null> {
  const principal = await currentPrincipal(c);
  if (!principal?.session || principal.token) return null;
  const [row] = await c
    .get("db")
    .select({ createdAt: sessions.createdAt, reauthenticatedAt: sessions.reauthenticatedAt })
    .from(sessions)
    .where(eq(sessions.id, principal.session.id))
    .limit(1);
  if (!row) return null;
  const at = Math.max(+row.createdAt, row.reauthenticatedAt ? +row.reauthenticatedAt : 0);
  return at + REAUTH_WINDOW_MS;
}

/**
 * Refuses the request unless the session signed in or re-authenticated
 * recently.
 *
 * @param c - Request context.
 * @throws {ApiError} 403 `reauth_required`.
 */
export async function requireFreshSession(c: AppContext): Promise<void> {
  const until = await freshUntil(c);
  const now = Date.now();
  if (until === null || !isFreshSession(until - REAUTH_WINDOW_MS, now)) {
    throw new ApiError(403, "reauth_required", "Confirm your password to continue");
  }
}
