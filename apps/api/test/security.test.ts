/**
 * Regression tests for findings from the Phase 0 security review. Each block
 * names the attack it guards against.
 */
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { createDb, type Db } from "@roundhouse/db";
import { HEARTBEAT_INTERVAL_MS, OFFLINE_AFTER_MS } from "@roundhouse/shared";
import { afterEach, describe, expect, it } from "vitest";
import { CloseCode } from "../src/durable/node-connection";
import { errorCodeForStatus } from "../src/lib/errors";
import { rateLimitBucket } from "../src/lib/guards";
import { isShellSafeOrigin } from "../src/lib/nodes";
import {
  addMember,
  call,
  connectAgent,
  eventually,
  heartbeat,
  hello,
  install,
  interceptD1,
  joinBody,
  joinNode,
  ORIGIN,
} from "./helpers";

const setupBody = (masterKey: string) => ({
  master_key: masterKey,
  name: "Mallory",
  email: "mallory@example.com",
  password: "a long enough password",
  workspace_name: "Pwned",
});

describe("setup takeover", () => {
  it("rejects setup without the install's master key", async () => {
    const res = await call("/v1/setup", {
      method: "POST",
      json: setupBody("dGhpcyBpcyBub3QgdGhlIG1hc3RlciBrZXkgYXQgYWxsIQ=="),
    });
    expect(res.status).toBe(403);
    expect((await (await call("/v1/setup")).json()) as object).toMatchObject({ needs_setup: true });
  });

  it("does not consume the setup lock on a wrong key", async () => {
    await call("/v1/setup", { method: "POST", json: setupBody("wrong") });
    const ok = await call("/v1/setup", { method: "POST", json: setupBody(env.MASTER_KEY!) });
    expect(ok.status).toBe(201);
  });
});

describe("cross-origin mutations", () => {
  it("rejects a foreign Origin on cookie-authenticated writes", async () => {
    const { owner, workspaceId } = await install();
    const res = await owner.request(`/v1/workspaces/${workspaceId}/nodes/join-tokens`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects cross-site fetches that omit Origin", async () => {
    const { owner, workspaceId } = await install();
    const res = await SELF.fetch(`${ORIGIN}/v1/workspaces/${workspaceId}/nodes/join-tokens`, {
      method: "POST",
      headers: { cookie: owner.cookie, "sec-fetch-site": "same-site" },
    });
    expect(res.status).toBe(403);
  });

  it("still allows same-origin writes and agent joins without Origin", async () => {
    const { owner, workspaceId } = await install();
    const { body } = await owner.json<{ token: string }>(
      `/v1/workspaces/${workspaceId}/nodes/join-tokens`,
      { method: "POST" },
    );
    const res = await SELF.fetch(`${ORIGIN}/v1/nodes/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(joinBody(body.token)),
    });
    expect(res.status).toBe(201);
  });
});

describe("rate limiting", () => {
  const original = env.AUTH_LIMITER;
  afterEach(() => {
    (env as { AUTH_LIMITER?: RateLimit }).AUTH_LIMITER = original;
  });

  it("classifies only secret-accepting endpoints", () => {
    expect(rateLimitBucket("POST", "/api/auth/sign-in/email")).toBe("auth");
    expect(rateLimitBucket("POST", "/v1/setup")).toBe("setup");
    expect(rateLimitBucket("POST", "/v1/nodes/join")).toBe("join");
    expect(rateLimitBucket("POST", "/v1/invites/inv_x/accept")).toBe("invite");
    expect(rateLimitBucket("GET", "/v1/setup")).toBeNull();
    expect(rateLimitBucket("POST", "/v1/workspaces")).toBeNull();
  });

  it("returns 429 per client IP once the limiter trips", async () => {
    await install();
    const keys: string[] = [];
    (env as { AUTH_LIMITER?: RateLimit }).AUTH_LIMITER = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: false };
      },
    };
    const res = await call("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "cf-connecting-ip": "198.51.100.7" },
      json: { email: "mara@example.com", password: "correct horse battery" },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(keys).toEqual(["auth:198.51.100.7"]);
  });
});

describe("account squatting via invites", () => {
  it("does not let anyone but an instance admin create workspaces", async () => {
    const { owner, workspaceId, userId } = await install();
    for (const role of ["viewer", "member", "admin"] as const) {
      const c = await addMember(owner, workspaceId, `${role}@example.com`, role);
      const res = await c.json("/v1/workspaces", { method: "POST", json: { name: "Mine" } });
      expect(res.status, role).toBe(403);
    }
    const ok = await owner.json("/v1/workspaces", { method: "POST", json: { name: "Mine" } });
    expect(ok.status).toBe(201);
    // Owning a workspace no longer grants it (ADR 0014, F3).
    await env.DB.prepare("UPDATE users SET instance_admin = 0 WHERE id = ?").bind(userId).run();
    const owned = await owner.json("/v1/workspaces", { method: "POST", json: { name: "More" } });
    expect(owned.status).toBe(403);
  });

  it("leaves invite-created accounts unverified", async () => {
    const { owner, workspaceId } = await install();
    await addMember(owner, workspaceId, "fresh@example.com", "member");
    const row = await env.DB.prepare("SELECT email_verified FROM users WHERE email = ?")
      .bind("fresh@example.com")
      .first<{ email_verified: number }>();
    expect(row?.email_verified).toBe(0);
  });

  it("cannot revoke (and erase) an already-accepted invite", async () => {
    const { owner, workspaceId } = await install();
    await addMember(owner, workspaceId, "accepted@example.com", "member");
    const invite = await env.DB.prepare("SELECT id FROM invites WHERE email = ?")
      .bind("accepted@example.com")
      .first<{ id: string }>();
    const res = await owner.request(`/v1/workspaces/${workspaceId}/invites/${invite!.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});

describe("node input validation", () => {
  it.each([
    ["oversized hostname", { hostname: "h".repeat(500_000) }],
    ["malformed public key", { public_key: "not-a-key" }],
    ["markup in public_ip", { public_ip: "<script>alert(1)</script>" }],
  ])("rejects a join with %s", async (_name, overrides) => {
    await install();
    const res = await call("/v1/nodes/join", {
      method: "POST",
      json: joinBody("njt_whatever", overrides),
    });
    expect(res.status).toBe(400);
  });

  it("prefers the observed client IP over the self-reported one", async () => {
    const { owner, workspaceId } = await install();
    const { body } = await owner.json<{ token: string }>(
      `/v1/workspaces/${workspaceId}/nodes/join-tokens`,
      { method: "POST" },
    );
    const res = await call("/v1/nodes/join", {
      method: "POST",
      headers: { "cf-connecting-ip": "198.51.100.20" },
      json: joinBody(body.token, { public_ip: "203.0.113.99" }),
    });
    const { node_id } = (await res.json()) as { node_id: string };
    const row = await env.DB.prepare("SELECT public_ip FROM nodes WHERE id = ?")
      .bind(node_id)
      .first<{ public_ip: string }>();
    expect(row?.public_ip).toBe("198.51.100.20");
  });
});

describe("agent connection abuse", () => {
  it("closes on a second hello", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const agent = await connectAgent(joined);
    agent.send(hello(joined.node_id));
    await agent.next();
    await agent.next();
    agent.send(hello(joined.node_id));
    expect((await agent.closed).code).toBe(CloseCode.policy);
  });

  it("drops heartbeat floods and closes persistent offenders", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const agent = await connectAgent(joined);
    agent.send(hello(joined.node_id));
    await agent.next();
    await agent.next();
    for (let i = 0; i < 50; i++) agent.send(heartbeat(i, i));
    const closed = await agent.closed;
    expect(closed).toMatchObject({ code: CloseCode.policy, reason: "heartbeat rate exceeded" });
    // Only the first heartbeat in the window was written.
    const row = await env.DB.prepare("SELECT cpu_percent FROM nodes WHERE id = ?")
      .bind(joined.node_id)
      .first<{ cpu_percent: number }>();
    expect(row?.cpu_percent).toBe(0);
  });

  it("evicts an authenticated socket that never says hello", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const agent = await connectAgent(joined);
    const stub = env.NODE_CONNECTION.get(env.NODE_CONNECTION.idFromName(joined.node_id));
    await runInDurableObject(stub, async (_obj, state) => {
      await state.storage.put("last_seen", Date.now() - OFFLINE_AFTER_MS - 1);
    });
    await runDurableObjectAlarm(stub);
    expect((await agent.closed).code).toBe(CloseCode.policy);
  });
});

describe("install.sh substitution", () => {
  it.each([
    ["https://cp.example.com", true],
    ["http://127.0.0.1:8787", true],
    ["https://cp$(id).example.com", false],
    ["https://cp`id`.example.com", false],
    ["https://cp.example.com;rm", false],
    ["https://a.example.com/x", false],
    ["ftp://example.com", false],
  ])("isShellSafeOrigin(%j) is %j", (origin, safe) => {
    expect(isShellSafeOrigin(origin)).toBe(safe);
  });

  it("substitutes the agent version placeholder", async () => {
    const text = await (await call("/install.sh")).text();
    expect(text).not.toContain("__AGENT_VERSION__");
  });
});

describe("rate limit coverage", () => {
  const original = env.AUTH_LIMITER;
  afterEach(() => {
    (env as { AUTH_LIMITER?: RateLimit }).AUTH_LIMITER = original;
  });

  function denyAll() {
    const keys: string[] = [];
    (env as { AUTH_LIMITER?: RateLimit }).AUTH_LIMITER = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: false };
      },
    };
    return keys;
  }

  it.each([
    ["/api/auth/change-password", "auth"],
    ["/api/auth/update-user", "auth"],
    ["/api/auth/sign-in/email/", "auth"],
    ["/api/auth//sign-in/email", "auth"],
    ["/api/auth/sign%2Din/email", "auth"],
    ["/api/%61uth/sign-in/email", "auth"],
    ["/v1/setup/", "setup"],
    ["/v1/%73etup", "setup"],
    ["/v1/nodes/join//", "join"],
    ["/v1/invites/inv_x/accept/", "invite"],
  ])("puts POST %s in the %s bucket", (path, bucket) => {
    expect(rateLimitBucket("POST", path)).toBe(bucket);
  });

  it("keys agent connects by node", () => {
    expect(rateLimitBucket("GET", "/v1/nodes/node_a/connect")).toBe("connect:node_a");
    expect(rateLimitBucket("GET", "/v1/nodes/node_a/connect/")).toBe("connect:node_a");
    expect(rateLimitBucket("GET", "/v1/nodes/node_a")).toBeNull();
    expect(rateLimitBucket("GET", "/v1/workspaces/ws_1/nodes")).toBeNull();
  });

  it("limits password changes", async () => {
    const { owner } = await install();
    const keys = denyAll();
    const res = await owner.request("/api/auth/change-password", {
      method: "POST",
      headers: { "cf-connecting-ip": "198.51.100.8" },
      json: { currentPassword: "correct horse battery", newPassword: "a brand new password" },
    });
    expect(res.status).toBe(429);
    expect(keys).toEqual(["auth:198.51.100.8"]);
  });

  it("limits agent connects per node and IP", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const keys = denyAll();
    const res = await call(`/v1/nodes/${joined.node_id}/connect`, {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer ${joined.credential}`,
        "cf-connecting-ip": "198.51.100.9",
      },
    });
    expect(res.status).toBe(429);
    expect(keys).toEqual([`connect:${joined.node_id}:198.51.100.9`]);
  });
});

describe("security headers", () => {
  it("are skipped only for the agent's WebSocket upgrade", async () => {
    const res = await call("/v1/setup", { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });
});

describe("framework errors", () => {
  it.each([
    [400, "invalid_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [413, "payload_too_large"],
    [418, "invalid_request"],
    [429, "rate_limited"],
    [503, "internal"],
  ])("map status %i to %s", (status, code) => {
    expect(errorCodeForStatus(status)).toBe(code);
  });

  it("answer malformed JSON with the standard error shape", async () => {
    const res = await call("/v1/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "invalid_request" } });
  });
});

describe("join failures", () => {
  it("returns 503 setup_incomplete before setup", async () => {
    const res = await call("/v1/nodes/join", { method: "POST", json: joinBody("njt_whatever") });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "setup_incomplete" } });
  });

  it("reports a broken signing key as an internal error, not missing setup", async () => {
    const { owner, workspaceId } = await install();
    const { body } = await owner.json<{ token: string }>(
      `/v1/workspaces/${workspaceId}/nodes/join-tokens`,
      { method: "POST" },
    );
    await env.DB.prepare("UPDATE instance_settings SET value = ? WHERE key = 'signing_key'")
      .bind(JSON.stringify({ kid: "k1" }))
      .run();
    const res = await call("/v1/nodes/join", { method: "POST", json: joinBody(body.token) });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "internal" } });
  });
});

describe("agent session robustness", () => {
  type Attachment = { lastBeatAt: number; strikes: number; helloReceived: boolean };

  async function greeted() {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const agent = await connectAgent(joined);
    agent.send(hello(joined.node_id));
    await agent.next();
    await agent.next();
    const stub = env.NODE_CONNECTION.get(env.NODE_CONNECTION.idFromName(joined.node_id));
    const attachment = () =>
      runInDurableObject(stub, (_obj, state) => {
        const ws = state.getWebSockets()[0];
        return ws ? (ws.deserializeAttachment() as Attachment) : null;
      });
    const backdateLastBeat = () =>
      runInDurableObject(stub, (_obj, state) => {
        const ws = state.getWebSockets()[0]!;
        const a = ws.deserializeAttachment() as Attachment;
        ws.serializeAttachment({ ...a, lastBeatAt: Date.now() - HEARTBEAT_INTERVAL_MS });
      });
    return { owner, workspaceId, joined, agent, attachment, backdateLastBeat };
  }

  it("forgives occasional early heartbeats over a long session", async () => {
    const { agent, attachment, backdateLastBeat } = await greeted();
    // Far more jittery beats than the strike limit, each followed by an on-time one.
    for (let i = 0; i < 12; i++) {
      await backdateLastBeat();
      agent.send(heartbeat(2 * i, i));
      await eventually(async () => {
        const a = await attachment();
        return a === null || a.lastBeatAt > Date.now() - 1000 ? true : undefined;
      });
      agent.send(heartbeat(2 * i + 1, i));
      await eventually(async () => {
        const a = await attachment();
        return a === null || a.strikes > 0 ? true : undefined;
      });
    }
    expect(await attachment()).toMatchObject({ strikes: 1 });
    agent.ws.close();
  });

  it("rejects a second hello sent before the first is processed", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const agent = await connectAgent(joined);
    const stub = env.NODE_CONNECTION.get(env.NODE_CONNECTION.idFromName(joined.node_id));
    // Holds the first hello's D1 write open long enough for the second to arrive.
    await runInDurableObject(stub, (obj) => {
      const internals = obj as unknown as { db: Db; env: { DB: D1Database } };
      internals.db = createDb(
        interceptD1(
          internals.env.DB,
          /^update "nodes"/,
          () => new Promise((r) => setTimeout(r, 200)),
        ),
      );
    });
    agent.send(hello(joined.node_id));
    agent.send(hello(joined.node_id));
    expect(await agent.closed).toMatchObject({ code: CloseCode.policy, reason: "duplicate hello" });
  });

  it.each(["draining", "maintenance"])("leaves an operator's %s status alone", async (status) => {
    const { joined, agent, backdateLastBeat } = await greeted();
    await env.DB.prepare("UPDATE nodes SET status = ? WHERE id = ?")
      .bind(status, joined.node_id)
      .run();
    await backdateLastBeat();
    agent.send(heartbeat(1, 77));
    const row = await eventually(async () => {
      const r = await env.DB.prepare("SELECT status, cpu_percent FROM nodes WHERE id = ?")
        .bind(joined.node_id)
        .first<{ status: string; cpu_percent: number | null }>();
      return r?.cpu_percent === 77 ? r : undefined;
    });
    expect(row.status).toBe(status);
    agent.ws.close();

    const again = await connectAgent(joined);
    again.send(hello(joined.node_id));
    await again.next();
    const after = await env.DB.prepare("SELECT status FROM nodes WHERE id = ?")
      .bind(joined.node_id)
      .first<{ status: string }>();
    expect(after?.status).toBe(status);
    again.ws.close();
  });
});
