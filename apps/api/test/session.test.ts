/**
 * Session refresh on /v1: when Better Auth extends a session it reads, the
 * re-issued cookie reaches the client on the /v1 response, so browsers and
 * the CLI keep a session that is in use.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { install } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

async function sessionExpiry(): Promise<number> {
  const row = await env.DB.prepare("SELECT expires_at FROM sessions").first<{
    expires_at: number;
  }>();
  return row!.expires_at;
}

describe("session refresh", () => {
  it("passes nothing through for a fresh session", async () => {
    const { owner } = await install();
    const res = await owner.request("/v1/me");
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("forwards the re-issued cookie when Better Auth extends the session", async () => {
    const { owner } = await install();
    // A session past Better Auth's update age (a day old): one hour left of seven days.
    const soon = Date.now() + 60 * 60 * 1000;
    await env.DB.prepare("UPDATE sessions SET expires_at = ?").bind(soon).run();

    const res = await owner.request("/v1/me");
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => /^(__Secure-)?better-auth\.session_token=/.test(c));
    expect(session).toBeDefined();
    expect(session).toMatch(/HttpOnly/i);
    expect(await sessionExpiry()).toBeGreaterThan(soon + 6 * DAY_MS);

    // The refreshed cookie authenticates like the old one.
    const next = await owner.request("/v1/me", {
      headers: { cookie: session!.split(";")[0]! },
    });
    expect(next.status).toBe(200);
  });

  it("forwards it on error responses too", async () => {
    const { owner } = await install();
    await env.DB.prepare("UPDATE sessions SET expires_at = ?")
      .bind(Date.now() + 60 * 60 * 1000)
      .run();
    const res = await owner.request("/v1/workspaces/ws_missing");
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie().some((c) => c.includes("session_token="))).toBe(true);
  });
});
