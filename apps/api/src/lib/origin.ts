/**
 * The control plane's public origin (ADR 0014 "Auth"): the one place every
 * absolute URL comes from (Better Auth's `baseURL` and `trustedOrigins`,
 * invite, install, join and GitHub manifest URLs, the agent connect URL,
 * the OAuth/MCP metadata, the same-origin guard). It comes from
 * `PUBLIC_ORIGIN`, never from the request's `Host`, which an attacker
 * controls.
 *
 * Owned by the api-auth stream.
 *
 * @module
 */
import type { AppContext } from "../context";
import { ApiError } from "./errors";

/** Bindings {@link publicOrigin} reads. */
export interface OriginEnv {
  /** Canonical origin, e.g. `https://cp.example.com`. */
  PUBLIC_ORIGIN?: string;
  /** `"1"` in local development. */
  ROUNDHOUSE_DEV?: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Normalises a configured public origin to `scheme://host[:port]`.
 *
 * Only `https:` is accepted, except `http:` on a loopback host (a control
 * plane run locally with `wrangler dev`). A path other than `/`, a query, a
 * fragment or credentials are refused rather than dropped, so a typo can't
 * silently point links somewhere else.
 *
 * @param raw - The configured value.
 * @returns The origin, without a trailing slash, or `null` when it is invalid.
 * @example
 * normalizeOrigin("https://CP.example.com/"); // "https://cp.example.com"
 * normalizeOrigin("https://cp.example.com:443"); // "https://cp.example.com"
 * normalizeOrigin("http://cp.example.com"); // null
 */
export function normalizeOrigin(raw: string): string | null {
  const value = raw.trim();
  if (!value || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
  return null;
}

/**
 * The public origin from the bindings alone, for code that runs outside a
 * request (workflows, cron jobs).
 *
 * @param env - The Worker bindings.
 * @returns The normalised `PUBLIC_ORIGIN`, or `null` when it is unset or invalid.
 */
export function configuredOrigin(env: OriginEnv): string | null {
  return env.PUBLIC_ORIGIN ? normalizeOrigin(env.PUBLIC_ORIGIN) : null;
}

/**
 * The public origin, e.g. `https://cp.example.com`.
 *
 * With `ROUNDHOUSE_DEV=1` and no `PUBLIC_ORIGIN`, the request's own origin
 * is used, so `wrangler dev` behind the Vite proxy works without setup.
 *
 * @param c - Request context.
 * @returns The origin, without a trailing slash.
 * @throws {ApiError} 503 `public_origin_missing` when `PUBLIC_ORIGIN` is
 *   unset or invalid outside development.
 */
export function publicOrigin(c: AppContext): string {
  const configured = configuredOrigin(c.env);
  if (configured) return configured;
  if (!c.env.PUBLIC_ORIGIN && c.env.ROUNDHOUSE_DEV === "1") return new URL(c.req.url).origin;
  throw new ApiError(
    503,
    "public_origin_missing",
    c.env.PUBLIC_ORIGIN
      ? "PUBLIC_ORIGIN must be an https:// origin without a path, e.g. https://cp.example.com."
      : "PUBLIC_ORIGIN is not configured. Set it to this control plane's URL with `npx wrangler secret put PUBLIC_ORIGIN`.",
  );
}

/**
 * Whether the control plane can build absolute URLs: `PUBLIC_ORIGIN` is
 * valid, or development falls back to the request origin.
 *
 * @param env - The Worker bindings.
 * @returns `true` when {@link publicOrigin} won't throw.
 */
export function hasPublicOrigin(env: OriginEnv): boolean {
  return configuredOrigin(env) !== null || (!env.PUBLIC_ORIGIN && env.ROUNDHOUSE_DEV === "1");
}
