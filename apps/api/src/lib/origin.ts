/**
 * The control plane's public origin (ADR 0014 "Auth"): the one place every
 * absolute URL comes from (Better Auth's `baseURL` and `trustedOrigins`,
 * invite, install, join and GitHub manifest URLs, the agent connect URL,
 * the same-origin guard). It must come from `PUBLIC_ORIGIN`, never from the
 * request's `Host`, which an attacker controls.
 *
 * Owned by the api-auth stream.
 *
 * @module
 */
import type { AppContext } from "../context";

/**
 * The public origin, e.g. `https://cp.example.com`.
 *
 * TODO(api-auth): return the normalised `PUBLIC_ORIGIN` (scheme + host +
 * port, no path), and throw 503 `public_origin_missing` when it is unset
 * outside development. Until then this keeps the request-derived origin.
 *
 * @param c - Request context.
 * @returns The origin, without a trailing slash.
 */
export function publicOrigin(c: AppContext): string {
  return new URL(c.req.url).origin;
}
