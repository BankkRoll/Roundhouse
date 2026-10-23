/**
 * Session freshness for dangerous actions (ADR 0014 "Auth"). A session is
 * fresh within `REAUTH_WINDOW_MS` of signing in or of `POST /v1/auth/reauth`
 * (which sets `sessions.reauthenticated_at`); API tokens never are.
 *
 * Routes whose policy has `reauth: true` get {@link requireFreshSession} from
 * the router itself (`createRouter` in `../context`), before their handler
 * runs, so no handler can forget it.
 *
 * @module
 */
import { sessions } from "@roundhouse/db";
import { isFreshSession, REAUTH_WINDOW_MS } from "@roundhouse/shared";
import { eq } from "drizzle-orm";
import { type AppContext, requirePrincipal } from "../context";
import { ApiError } from "./errors";

/** Path of the route that makes a session fresh again. */
export const REAUTH_PATH = "/v1/auth/reauth";

/**
 * Until when the caller's session counts as fresh.
 *
 * @param c - Request context.
 * @returns Unix ms, or `null` without a browser session (API tokens are never fresh).
 */
export async function freshUntil(c: AppContext): Promise<number | null> {
  const principal = await requirePrincipal(c);
  // SECURITY: A bearer request ignores cookies, so a session cookie riding
  // along with an API token must not make the token "fresh".
  if (principal.token || !principal.session) return null;
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
 * recently. The error's `details[0].code` says what the client can do:
 * `session_stale` (re-authenticate at {@link REAUTH_PATH} and retry) or
 * `api_token` (nothing: sign in with a browser session instead).
 *
 * @param c - Request context.
 * @throws {ApiError} 401 when anonymous; 403 `reauth_required` otherwise.
 */
export async function requireFreshSession(c: AppContext): Promise<void> {
  const principal = await requirePrincipal(c);
  if (principal.token) {
    throw new ApiError(
      403,
      "reauth_required",
      "This action needs a recently re-authenticated browser session; API tokens can't perform it",
      [{ field: "session", code: "api_token", message: "Sign in and confirm your password" }],
    );
  }
  const until = await freshUntil(c);
  if (until === null || !isFreshSession(until - REAUTH_WINDOW_MS, Date.now())) {
    throw new ApiError(403, "reauth_required", "Confirm your password to continue", [
      {
        field: "session",
        code: "session_stale",
        message: `POST ${REAUTH_PATH} with your password, then retry`,
      },
    ]);
  }
}
