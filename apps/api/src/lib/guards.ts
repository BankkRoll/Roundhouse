/**
 * Request guards that sit in front of route handlers: same-origin enforcement
 * for cookie-authenticated mutations, and per-IP rate limits on endpoints that
 * accept secrets (passwords, setup key, join and invite tokens, node credentials).
 *
 * @module
 */
import { createMiddleware } from "hono/factory";
import { type AppEnv, clientIp, originOf } from "../context";
import { bearerSecret } from "./api-tokens";
import { errorBody } from "./errors";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Routes called by agents and scripts, which send no Origin and use bearer credentials. */
const NON_BROWSER_ROUTES = [/^\/v1\/nodes\/join$/, /^\/v1\/webhooks\/github\/?$/];

/**
 * Rejects cross-origin state-changing requests to `/v1/*`.
 *
 * SameSite=Lax cookies already block cross-site requests, but not same-site
 * ones, and user apps will be served from sibling subdomains of the same site.
 * Browsers always send `Origin` on non-GET requests, so requiring it to match
 * closes that gap without affecting CLI/agent callers.
 *
 * Requests with a bearer credential are exempt: a bearer request is
 * authenticated by its `Authorization` header alone (cookies are ignored when
 * one is present), and a cross-site page can't attach that header without a
 * CORS preflight this API never grants.
 */
export const sameOriginMutations = createMiddleware<AppEnv>(async (c, next) => {
  if (
    SAFE_METHODS.has(c.req.method) ||
    NON_BROWSER_ROUTES.some((r) => r.test(c.req.path)) ||
    bearerSecret(c.req.header("authorization")) !== null
  ) {
    return next();
  }
  const origin = c.req.header("origin");
  const fetchSite = c.req.header("sec-fetch-site");
  const crossOrigin =
    (origin !== undefined && origin !== originOf(c)) ||
    (origin === undefined &&
      fetchSite !== undefined &&
      !["same-origin", "none"].includes(fetchSite));
  if (crossOrigin) {
    return c.json(errorBody("forbidden", "Cross-origin request rejected"), 403);
  }
  return next();
});

/**
 * Canonical form of a request path for classification: percent-decoded, with
 * repeated and trailing slashes collapsed.
 *
 * SECURITY: Routers differ in how they treat `/a/`, `//a`, and `%2D`; Better
 * Auth's router in particular is looser than Hono's. Classifying the
 * canonical form means no spelling of a limited path escapes its bucket.
 */
function canonicalPath(path: string): string {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Malformed escapes can't route anywhere meaningful; classify the raw path.
  }
  return decoded.replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");
}

/**
 * Which limiter bucket a request falls into.
 *
 * @param method - HTTP method.
 * @param path - Request path as received, before any decoding.
 * @returns A bucket name (`auth` for Better Auth and re-authentication, `setup`, `join`, `invite`, `webhook`, or
 *   `connect:<nodeId>`), or `null` if the request isn't limited.
 * @example
 * rateLimitBucket("POST", "/api/auth/change-password"); // "auth"
 * rateLimitBucket("GET", "/v1/nodes/node_1/connect");  // "connect:node_1"
 */
export function rateLimitBucket(method: string, path: string): string | null {
  const p = canonicalPath(path);
  const verb = method.toUpperCase();
  if (verb === "GET") {
    const connect = /^\/v1\/nodes\/([^/]+)\/connect$/.exec(p);
    return connect ? `connect:${connect[1]}` : null;
  }
  if (verb !== "POST") return null;
  if (p === "/api/auth" || p.startsWith("/api/auth/") || p === "/v1/auth/reauth") return "auth";
  if (p === "/v1/setup") return "setup";
  if (p === "/v1/nodes/join") return "join";
  if (p === "/v1/invites/accept" || p === "/v1/invites/lookup") return "invite";
  if (p === "/v1/webhooks/github") return "webhook";
  return null;
}

/**
 * Per-IP rate limit for secret-accepting endpoints, backed by the Workers
 * rate-limiting binding so it holds across isolates. The GitHub webhook has
 * its own, looser limiter. Agent connects are keyed
 * by node and IP, so one noisy node can't lock out others behind the same NAT.
 *
 * NOTE: The binding is optional so local tooling without it still works; a
 * production deploy always declares it in wrangler.jsonc.
 */
export const rateLimitSecrets = createMiddleware<AppEnv>(async (c, next) => {
  const bucket = rateLimitBucket(c.req.method, new URL(c.req.url).pathname);
  const limiter = bucket === "webhook" ? c.env.WEBHOOK_LIMITER : c.env.AUTH_LIMITER;
  if (!bucket || !limiter) return next();
  const { success } = await limiter.limit({ key: `${bucket}:${clientIp(c) ?? "unknown"}` });
  if (!success) {
    c.header("retry-after", "60");
    return c.json(errorBody("rate_limited", "Too many attempts; try again in a minute"), 429);
  }
  return next();
});
