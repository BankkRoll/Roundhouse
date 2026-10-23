import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SETUP_LOCK_TTL_MS } from "../src/lib/settings";
import { call, failStatement, install } from "./helpers";

const setupBody = () => ({
  name: "Mara Okafor",
  email: "mara@example.com",
  password: "correct horse battery",
  master_key: env.MASTER_KEY,
  workspace_name: "Nightjar Labs",
});

const putSetting = (key: string, value: number) =>
  env.DB.prepare(
    "INSERT INTO instance_settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)",
  )
    .bind(key, JSON.stringify(value), Date.now(), Date.now())
    .run();

describe("setup", () => {
  it("reports that setup is needed on a fresh install", async () => {
    const res = await call("/v1/setup");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ needs_setup: true, master_key_configured: true });
  });

  it("creates the owner, signs them in, and closes setup", async () => {
    const { owner, workspaceId } = await install();

    const me = await owner.json<{
      user: { email: string };
      workspaces: { id: string; role: string }[];
    }>("/v1/me");
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("mara@example.com");
    expect(me.body.workspaces).toEqual([
      {
        id: workspaceId,
        name: "Nightjar Labs",
        slug: "nightjar-labs",
        role: "owner",
        member_id: expect.stringMatching(/^mem_/),
      },
    ]);

    const status = await (await call("/v1/setup")).json();
    expect(status).toMatchObject({ needs_setup: false });
  });

  it("refuses to run twice", async () => {
    await install();
    const again = await call("/v1/setup", {
      method: "POST",
      json: {
        name: "Attacker",
        email: "evil@example.com",
        password: "another long password",
        master_key: env.MASTER_KEY,
        workspace_name: "Pwned",
      },
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: { code: "already_setup", message: expect.any(String) },
    });
  });

  it("only lets one of several concurrent setups win", async () => {
    const attempts = await Promise.all(
      [1, 2, 3].map((i) =>
        call("/v1/setup", {
          method: "POST",
          json: {
            name: `User ${i}`,
            email: `u${i}@example.com`,
            password: "correct horse battery",
            master_key: env.MASTER_KEY,
            workspace_name: `WS ${i}`,
          },
        }),
      ),
    );
    const statuses = attempts.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409]);
  });

  it("validates input with the standard error shape", async () => {
    const res = await call("/v1/setup", {
      method: "POST",
      json: { name: "x", email: "not-an-email", password: "short", workspace_name: "w" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "invalid_request",
        message: expect.stringMatching(/master_key|email|password/),
      },
    });
  });

  it("returns 503 with guidance when MASTER_KEY is missing", async () => {
    const original = env.MASTER_KEY;
    try {
      (env as { MASTER_KEY?: string }).MASTER_KEY = undefined;
      const status = await (await call("/v1/setup")).json();
      expect(status).toEqual({ needs_setup: true, master_key_configured: false });

      const res = await call("/v1/setup", {
        method: "POST",
        json: { ...setupBody(), master_key: original },
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: {
          code: "master_key_missing",
          message: expect.stringContaining("wrangler secret put"),
        },
      });
    } finally {
      (env as { MASTER_KEY?: string }).MASTER_KEY = original;
    }
  });

  it("rolls back and releases the lock when a step fails", async () => {
    const restore = failStatement(/^insert into "audit_logs"/);
    try {
      const res = await call("/v1/setup", { method: "POST", json: setupBody() });
      expect(res.status).toBe(500);
    } finally {
      restore();
    }
    const counts = await env.DB.prepare(
      `SELECT (SELECT count(*) FROM users) AS users,
              (SELECT count(*) FROM workspaces) AS workspaces,
              (SELECT count(*) FROM instance_settings WHERE key = 'setup_lock') AS locks`,
    ).first();
    expect(counts).toEqual({ users: 0, workspaces: 0, locks: 0 });
    expect(await (await call("/v1/setup")).json()).toMatchObject({ needs_setup: true });
    expect((await call("/v1/setup", { method: "POST", json: setupBody() })).status).toBe(201);
  });

  it("reclaims a lock stranded by a setup that died mid-way", async () => {
    await putSetting("setup_lock", Date.now() - SETUP_LOCK_TTL_MS - 1000);
    const res = await call("/v1/setup", { method: "POST", json: setupBody() });
    expect(res.status).toBe(201);
  });

  it("respects a lock held by a setup still in progress", async () => {
    await putSetting("setup_lock", Date.now() - 5000);
    const res = await call("/v1/setup", { method: "POST", json: setupBody() });
    expect(res.status).toBe(409);
  });

  it("never reclaims an old lock once setup has completed", async () => {
    await install();
    await env.DB.prepare("UPDATE instance_settings SET value = ? WHERE key = 'setup_lock'")
      .bind(JSON.stringify(Date.now() - SETUP_LOCK_TTL_MS - 1000))
      .run();
    const res = await call("/v1/setup", {
      method: "POST",
      json: { ...setupBody(), email: "second@example.com" },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "already_setup" } });
  });

  it("keeps public sign-up closed after setup", async () => {
    await install();
    const res = await call("/api/auth/sign-up/email", {
      method: "POST",
      json: { name: "Rando", email: "rando@example.com", password: "a long enough password" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const me = await call("/v1/me", { headers: { cookie: res.headers.get("set-cookie") ?? "" } });
    expect(me.status).toBe(401);
  });

  it("lets the owner sign in with their password", async () => {
    await install();
    const ok = await call("/api/auth/sign-in/email", {
      method: "POST",
      json: { email: "mara@example.com", password: "correct horse battery" },
    });
    expect(ok.status).toBe(200);
    const bad = await call("/api/auth/sign-in/email", {
      method: "POST",
      json: { email: "mara@example.com", password: "wrong password!!" },
    });
    expect(bad.status).toBe(401);
  });

  it("serves an OpenAPI document", async () => {
    const res = await call("/v1/openapi.json");
    expect(res.status).toBe(200);
    type Doc = {
      openapi: string;
      info: { version: string };
      paths: Record<string, Record<string, { responses: object; security?: unknown }>>;
      components: {
        securitySchemes: Record<string, { in: string }>;
        schemas: Record<string, { properties: Record<string, { enum?: string[] }> }>;
      };
    };
    const doc = (await res.json()) as Doc;
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(doc.paths)).toContain("/v1/workspaces/{workspaceId}/nodes");

    expect(doc.components.securitySchemes.session).toMatchObject({ type: "apiKey", in: "cookie" });
    expect(doc.components.securitySchemes.api_token).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
    for (const path of [
      "/v1/workspaces/{workspaceId}/nodes",
      "/v1/workspaces/{workspaceId}/projects",
    ]) {
      expect(doc.paths[path]!.get!.security, path).toEqual([{ session: [] }, { api_token: [] }]);
    }
    expect(doc.paths["/v1/workspaces"]!.post!.security).toEqual([{ session: [] }]);
    expect(doc.paths["/v1/instance/settings"]!.get!.security).toEqual([{ session: [] }]);
    for (const [path, method] of [
      ["/v1/setup", "post"],
      ["/v1/nodes/join", "post"],
      ["/v1/invites/{token}/accept", "post"],
    ] as const) {
      expect(Object.keys(doc.paths[path]![method]!.responses)).toContain("429");
    }
    const audit = doc.components.schemas.AuditLog!.properties;
    expect(audit.action!.enum).toContain("node.joined");
    expect(audit.actor_type!.enum).toEqual(["user", "token", "node", "system"]);
  });

  it("returns JSON 404s for unknown API paths", async () => {
    const res = await call("/v1/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } });
  });
});
