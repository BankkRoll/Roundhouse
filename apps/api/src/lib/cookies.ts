/**
 * Bridges Better Auth's server-side API calls to the browser: lets a route
 * that signs a user up or in on their behalf hand them the session cookie.
 *
 * @module
 */
import type { AppContext } from "../context";

/**
 * Copies `Set-Cookie` headers from a Better Auth call onto the Hono response,
 * so server-side sign-up/sign-in calls log the browser in.
 *
 * @param c - Request context.
 * @param from - Headers returned by a Better Auth API call made with `returnHeaders: true`.
 */
export function forwardCookies(c: AppContext, from: Headers): void {
  for (const cookie of from.getSetCookie()) {
    c.header("set-cookie", cookie, { append: true });
  }
}
