/**
 * Keeps API and auth responses out of every cache (ADR 0014 "Cache"): they
 * are per-user, often carry session state, and a shared cache or the
 * browser's back-forward cache must never replay them to someone else.
 *
 * @module
 */
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../context";

/** Value of `Cache-Control` on every `/v1/*` and `/api/auth/*` response. */
export const NO_STORE = "no-store, private";

/**
 * Sets `Cache-Control: no-store, private` and adds `Cookie` to `Vary`.
 *
 * NOTE: Responses passed through from a Durable Object have immutable
 * headers, so those are copied into a new response first. WebSocket
 * upgrades (101) are left alone: copying would drop the socket, and caches
 * never store a 101 anyway.
 */
export const noStore = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  if (c.res.status === 101) return;
  let res = c.res;
  try {
    res.headers.set("cache-control", NO_STORE);
  } catch {
    res = new Response(res.body, res);
    res.headers.set("cache-control", NO_STORE);
  }
  const vary = res.headers.get("vary");
  if (!vary?.split(",").some((v) => v.trim().toLowerCase() === "cookie")) {
    res.headers.set("vary", vary ? `${vary}, Cookie` : "Cookie");
  }
  if (res !== c.res) c.res = res;
});
