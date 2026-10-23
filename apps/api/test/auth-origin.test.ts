/**
 * `PUBLIC_ORIGIN` (ADR 0014 "Auth"): absolute URLs and the same-origin
 * guard come from the configured origin, never from the request's `Host`;
 * without it the control plane refuses to build them, except in development.
 */
import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeOrigin } from "../src/lib/origin";
import { call, install } from "./helpers";

type OriginBindings = { PUBLIC_ORIGIN?: string; ROUNDHOUSE_DEV?: string };
const bindings = env as OriginBindings;
const original = { ...bindings };

afterEach(() => {
  bindings.PUBLIC_ORIGIN = original.PUBLIC_ORIGIN;
  bindings.ROUNDHOUSE_DEV = original.ROUNDHOUSE_DEV;
});

describe("normalizeOrigin", () => {
  it.each([
    ["https://cp.example.com", "https://cp.example.com"],
    ["https://CP.Example.com/", "https://cp.example.com"],
    ["  https://cp.example.com:443  ", "https://cp.example.com"],
    ["https://cp.example.com:8443", "https://cp.example.com:8443"],
    ["http://localhost:8787", "http://localhost:8787"],
    ["http://127.0.0.1:8787/", "http://127.0.0.1:8787"],
  ])("accepts %s", (raw, expected) => {
    expect(normalizeOrigin(raw)).toBe(expected);
  });

  it.each([
    "",
    "cp.example.com",
    "http://cp.example.com",
    "https://cp.example.com/app",
    "https://cp.example.com/?x=1",
    "https://cp.example.com/#x",
    "https://user:pass@cp.example.com",
    "ftp://cp.example.com",
    "javascript:alert(1)",
  ])("refuses %j", (raw) => {
    expect(normalizeOrigin(raw)).toBeNull();
  });
});

describe("public origin", () => {
  it("builds invite links from PUBLIC_ORIGIN whatever Host the request names", async () => {
    const { owner, workspaceId } = await install();
    const res = await SELF.fetch(`https://attacker.example/v1/workspaces/${workspaceId}/invites`, {
      method: "POST",
      headers: {
        cookie: owner.cookie,
        origin: "https://cp.test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ email: "new@example.com", role: "member" }),
    });
    expect(res.status).toBe(201);
    const { url } = (await res.json()) as { url: string };
    expect(new URL(url).origin).toBe("https://cp.test");
  });

  it("checks Origin against PUBLIC_ORIGIN, not against Host", async () => {
    const { owner, workspaceId } = await install();
    const res = await SELF.fetch(`https://attacker.example/v1/workspaces/${workspaceId}`, {
      method: "PATCH",
      headers: {
        cookie: owner.cookie,
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(403);
  });

  it("serves the install script with PUBLIC_ORIGIN baked in", async () => {
    const res = await SELF.fetch("https://attacker.example/install.sh");
    expect(res.status).toBe(200);
    const script = await res.text();
    expect(script).toContain("https://cp.test");
    expect(script).not.toContain("attacker.example");
  });

  it("refuses to build URLs with 503 public_origin_missing when unset", async () => {
    const { owner } = await install();
    bindings.PUBLIC_ORIGIN = undefined;
    const res = await owner.request("/v1/me");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: {
        code: "public_origin_missing",
        message: expect.stringContaining("wrangler secret put PUBLIC_ORIGIN"),
      },
    });
    expect(await (await call("/v1/setup")).json()).toMatchObject({
      public_origin_configured: false,
    });
  });

  it("refuses an invalid PUBLIC_ORIGIN instead of guessing", async () => {
    bindings.PUBLIC_ORIGIN = "http://cp.example.com/dashboard";
    const res = await call("/install.sh");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "public_origin_missing" } });
  });

  it("refuses setup before the origin is configured", async () => {
    bindings.PUBLIC_ORIGIN = undefined;
    const res = await call("/v1/setup", {
      method: "POST",
      json: {
        name: "Mara Okafor",
        email: "mara@example.com",
        password: "correct horse battery",
        master_key: env.MASTER_KEY,
        workspace_name: "Nightjar Labs",
      },
    });
    expect(res.status).toBe(503);
    const users = await env.DB.prepare("SELECT count(*) AS n FROM users").first<{ n: number }>();
    expect(users?.n).toBe(0);
  });

  it("uses the request origin in development when PUBLIC_ORIGIN is unset", async () => {
    bindings.PUBLIC_ORIGIN = undefined;
    bindings.ROUNDHOUSE_DEV = "1";
    const res = await SELF.fetch("http://localhost:5173/install.sh");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("http://localhost:5173");
  });

  it("prefers PUBLIC_ORIGIN over the request origin in development too", async () => {
    bindings.ROUNDHOUSE_DEV = "1";
    const res = await SELF.fetch("http://localhost:5173/install.sh");
    expect(await res.text()).toContain("https://cp.test");
  });
});
