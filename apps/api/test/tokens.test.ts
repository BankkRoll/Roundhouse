/**
 * API tokens: issuing (shown once, stored hashed), bearer authentication of
 * /v1 routes, workspace and scope limits intersected with the creator's
 * role, token and member management only with explicit scopes, expiry,
 * revocation, `last_used_at`, audit attribution, the failed-auth rate limit,
 * and the same-origin guard's bearer exemption.
 */
import { env } from "cloudflare:test";
import { API_TOKEN_PRESETS } from "@roundhouse/shared";
import { afterEach, describe, expect, it } from "vitest";
import { hashToken } from "../src/lib/crypto";
import { addMember, type Client, call, install, ORIGIN } from "./helpers";
import { createProject } from "./pipeline-helpers";

interface Created {
  token: {
    id: string;
    name: string;
    scopes: string[];
    prefix: string;
    created_by: { user_id: string; name: string };
    last_used_at: number | null;
    expires_at: number | null;
    revoked_at: number | null;
  };
  secret: string;
}

async function createToken(
  c: Client,
  workspaceId: string,
  scopes: readonly string[],
  extra: Partial<{ name: string; expires_in_days: number | null }> = {},
) {
  return c.json<Created>(`/v1/workspaces/${workspaceId}/tokens`, {
    method: "POST",
    json: { name: "ci", scopes, expires_in_days: 30, ...extra },
  });
}

async function mint(c: Client, workspaceId: string, scopes: readonly string[]) {
  const res = await createToken(c, workspaceId, scopes);
  if (res.status !== 201)
    throw new Error(`create token: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Calls the API with a bearer token and no cookie. */
async function as<T = unknown>(
  secret: string,
  path: string,
  init: RequestInit & { json?: unknown } = {},
) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${secret}`);
  const res = await call(path, { ...init, headers });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
}

async function memberId(owner: Client, workspaceId: string, email: string) {
  const { body } = await owner.json<{ members: { id: string; email: string }[] }>(
    `/v1/workspaces/${workspaceId}/members`,
  );
  return body.members.find((m) => m.email === email)!.id;
}

describe("issuing tokens", () => {
  it("returns the secret once and stores only its hash", async () => {
    const { owner, workspaceId, userId } = await install();
    const res = await createToken(owner, workspaceId, API_TOKEN_PRESETS.deploy, {
      name: "GitHub Actions",
    });
    expect(res.status).toBe(201);
    const { token, secret } = res.body;
    expect(secret).toMatch(/^tok_[A-Za-z0-9_-]{43}$/);
    expect(token).toMatchObject({
      name: "GitHub Actions",
      scopes: [...API_TOKEN_PRESETS.deploy],
      prefix: secret.slice(0, 8),
      created_by: { user_id: userId, name: "Mara Okafor" },
      last_used_at: null,
      revoked_at: null,
    });
    expect(token.expires_at! - Date.now()).toBeGreaterThan(29 * 86_400_000);

    const row = await env.DB.prepare("SELECT * FROM api_tokens").first<Record<string, unknown>>();
    expect(row!.token_hash).toBe(await hashToken(secret));
    expect(JSON.stringify(row)).not.toContain(secret);

    const list = await owner.json<{ tokens: Record<string, unknown>[] }>(
      `/v1/workspaces/${workspaceId}/tokens`,
    );
    expect(list.body.tokens).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(secret);
    expect(list.body.tokens[0]).not.toHaveProperty("secret");

    const audit = await env.DB.prepare(
      "SELECT actor_type, metadata FROM audit_logs WHERE action = 'token.created'",
    ).first<{ actor_type: string; metadata: string }>();
    expect(audit?.actor_type).toBe("user");
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it("lets only owners and admins manage tokens", async () => {
    const { owner, workspaceId } = await install();
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    expect((await createToken(member, workspaceId, ["projects:read"])).status).toBe(403);
    expect((await member.json(`/v1/workspaces/${workspaceId}/tokens`)).status).toBe(403);
    const admin = await addMember(owner, workspaceId, "a@example.com", "admin");
    expect((await createToken(admin, workspaceId, ["projects:read"])).status).toBe(201);
  });

  it("refuses scopes beyond the creator's role and invalid requests", async () => {
    const { owner, workspaceId } = await install();
    const admin = await addMember(owner, workspaceId, "a@example.com", "admin");
    const beyond = await createToken(admin, workspaceId, ["projects:read", "workspace:delete"]);
    expect(beyond.status).toBe(403);
    for (const scopes of [
      [],
      ["instance:manage"],
      ["workspaces:create"],
      ["root"],
      ["projects:read", "projects:read"],
    ]) {
      expect((await createToken(owner, workspaceId, scopes)).status, JSON.stringify(scopes)).toBe(
        400,
      );
    }
    for (const expires of [0, 367, 1.5]) {
      expect(
        (await createToken(owner, workspaceId, ["projects:read"], { expires_in_days: expires }))
          .status,
      ).toBe(400);
    }
    const forever = await createToken(owner, workspaceId, ["projects:read"], {
      expires_in_days: null,
    });
    expect(forever.body.token.expires_at).toBeNull();
  });
});

describe("bearer authentication", () => {
  it("authenticates /v1 routes, attributes audit entries to the token, and ignores cookies", async () => {
    const { owner, workspaceId, userId } = await install();
    const { token, secret } = await mint(owner, workspaceId, [
      "projects:read",
      "projects:create",
      "audit:read",
    ]);
    const list = await as<{ projects: unknown[] }>(
      secret,
      `/v1/workspaces/${workspaceId}/projects`,
    );
    expect(list.status).toBe(200);

    // No Origin, as from a CI runner.
    const created = await as<{ id: string }>(secret, `/v1/workspaces/${workspaceId}/projects`, {
      method: "POST",
      json: { name: "From CI" },
      headers: { origin: "" },
    });
    expect(created.status).toBe(201);
    const log = await as<{
      items: { action: string; actor_type: string; actor_id: string; actor_name: string }[];
    }>(secret, `/v1/workspaces/${workspaceId}/audit-logs`);
    expect(log.body.items[0]).toMatchObject({
      action: "project.created",
      actor_type: "token",
      actor_id: token.id,
      actor_name: "ci",
    });

    const me = await as<{
      user: { id: string };
      workspaces: { id: string }[];
      token: { id: string; workspace_id: string; scopes: string[] };
    }>(secret, "/v1/me");
    expect(me.body.user.id).toBe(userId);
    expect(me.body.workspaces.map((w) => w.id)).toEqual([workspaceId]);
    expect(me.body.token).toEqual({
      id: token.id,
      name: "ci",
      workspace_id: workspaceId,
      scopes: ["projects:read", "projects:create", "audit:read"],
    });
    const browserMe = await owner.json<Record<string, unknown>>("/v1/me");
    expect(browserMe.body).not.toHaveProperty("token");

    // A bearer header is authoritative: a valid cookie can't rescue a bad token.
    const mixed = await call(`/v1/workspaces/${workspaceId}/projects`, {
      headers: { authorization: "Bearer tok_not-a-real-token", cookie: owner.cookie },
    });
    expect(mixed.status).toBe(401);
    expect(((await mixed.json()) as { error: { code: string } }).error.code).toBe("invalid_token");
  });

  it("limits a token to its scopes and its workspace", async () => {
    const { owner, workspaceId } = await install();
    const other = await owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Other" },
    });
    const p = await createProject(owner, workspaceId);
    const { secret } = await mint(owner, workspaceId, ["projects:read"]);
    expect((await as(secret, `/v1/projects/${p.id}`)).status).toBe(200);
    const denied = await as<{ error: { message: string } }>(
      secret,
      `/v1/workspaces/${workspaceId}/projects`,
      { method: "POST", json: { name: "Nope" } },
    );
    expect(denied.status).toBe(403);
    expect(denied.body.error.message).toContain("projects:create");
    expect((await as(secret, `/v1/workspaces/${other.body.id}/projects`)).status).toBe(404);
    expect((await as(secret, `/v1/workspaces/${other.body.id}`)).status).toBe(404);
  });

  it("is bounded by the creator's current role and membership", async () => {
    const { owner, workspaceId } = await install();
    const admin = await addMember(owner, workspaceId, "a@example.com", "admin");
    const { secret } = await mint(admin, workspaceId, ["projects:read", "projects:create"]);
    const create = () =>
      as(secret, `/v1/workspaces/${workspaceId}/projects`, {
        method: "POST",
        json: { name: "X" },
      });
    expect((await create()).status).toBe(201);
    const id = await memberId(owner, workspaceId, "a@example.com");
    await owner.json(`/v1/workspaces/${workspaceId}/members/${id}`, {
      method: "PATCH",
      json: { role: "viewer" },
    });
    expect((await create()).status).toBe(403);
    expect((await as(secret, `/v1/workspaces/${workspaceId}/projects`)).status).toBe(200);
    await owner.request(`/v1/workspaces/${workspaceId}/members/${id}`, { method: "DELETE" });
    expect((await as(secret, `/v1/workspaces/${workspaceId}/projects`)).status).toBe(401);
  });

  it("refuses session-only routes", async () => {
    const { owner, workspaceId } = await install();
    const invite = await owner.json<{ url: string }>(`/v1/workspaces/${workspaceId}/invites`, {
      method: "POST",
      json: { email: "new@example.com", role: "viewer" },
    });
    const { secret } = await mint(owner, workspaceId, ["workspace:read", "members:manage"]);
    expect(
      (await as(secret, "/v1/workspaces", { method: "POST", json: { name: "W" } })).status,
    ).toBe(403);
    const inviteToken = invite.body.url.split("/invite/")[1]!;
    const accept = await as(secret, `/v1/invites/${inviteToken}/accept`, {
      method: "POST",
      json: {},
    });
    expect(accept.status).toBe(403);
  });

  it("never performs an instance action, even with one stored among its scopes", async () => {
    const { owner, workspaceId } = await install();
    const { token, secret } = await mint(owner, workspaceId, ["workspace:read"]);
    await env.DB.prepare("UPDATE api_tokens SET scopes = ? WHERE id = ?")
      .bind(JSON.stringify(["workspace:read", "instance:manage", "workspaces:create"]), token.id)
      .run();
    expect((await as(secret, "/v1/instance/settings")).status).toBe(403);
    const me = await as<{ user: { instance_admin: boolean }; token: { scopes: string[] } }>(
      secret,
      "/v1/me",
    );
    expect(me.body.token.scopes).toEqual(["workspace:read"]);
    expect(me.body.user.instance_admin).toBe(false);
  });
});

describe("token and member management by tokens", () => {
  it("can't manage tokens without tokens:manage, nor grant scopes it lacks", async () => {
    const { owner, workspaceId } = await install();
    const plain = await mint(owner, workspaceId, ["projects:read"]);
    expect(
      (
        await as(plain.secret, `/v1/workspaces/${workspaceId}/tokens`, {
          method: "POST",
          json: { name: "x", scopes: ["projects:read"], expires_in_days: 1 },
        })
      ).status,
    ).toBe(403);
    expect((await as(plain.secret, `/v1/workspaces/${workspaceId}/tokens`)).status).toBe(403);
    expect(
      (
        await as(plain.secret, `/v1/workspaces/${workspaceId}/tokens/${plain.token.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(403);

    const manager = await mint(owner, workspaceId, ["tokens:manage", "projects:read"]);
    const subset = await as<Created>(manager.secret, `/v1/workspaces/${workspaceId}/tokens`, {
      method: "POST",
      json: { name: "child", scopes: ["projects:read"], expires_in_days: 1 },
    });
    expect(subset.status).toBe(201);
    const wider = await as(manager.secret, `/v1/workspaces/${workspaceId}/tokens`, {
      method: "POST",
      json: { name: "wider", scopes: ["projects:manage"], expires_in_days: 1 },
    });
    expect(wider.status).toBe(403);
    const audit = await env.DB.prepare(
      "SELECT actor_type, actor_id FROM audit_logs WHERE action = 'token.created' ORDER BY id DESC",
    ).first<{ actor_type: string; actor_id: string }>();
    expect(audit).toEqual({ actor_type: "token", actor_id: manager.token.id });
  });

  it("can't manage members without members:manage", async () => {
    const { owner, workspaceId } = await install();
    await addMember(owner, workspaceId, "v@example.com", "viewer");
    const id = await memberId(owner, workspaceId, "v@example.com");
    const change = (secret: string) =>
      as(secret, `/v1/workspaces/${workspaceId}/members/${id}`, {
        method: "PATCH",
        json: { role: "member" },
      });
    const reader = await mint(owner, workspaceId, ["members:read"]);
    expect((await change(reader.secret)).status).toBe(403);
    expect(
      (await as(reader.secret, `/v1/workspaces/${workspaceId}/members/${id}`, { method: "DELETE" }))
        .status,
    ).toBe(403);
    const manager = await mint(owner, workspaceId, ["members:manage"]);
    expect((await change(manager.secret)).status).toBe(200);
  });
});

describe("token lifecycle", () => {
  it("stops working once expired", async () => {
    const { owner, workspaceId } = await install();
    const { token, secret } = await mint(owner, workspaceId, ["workspace:read"]);
    expect((await as(secret, `/v1/workspaces/${workspaceId}`)).status).toBe(200);
    await env.DB.prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, token.id)
      .run();
    const res = await as<{ error: { code: string } }>(secret, `/v1/workspaces/${workspaceId}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("invalid_token");
  });

  it("revokes once, audits once, and keeps the revoked token listed", async () => {
    const { owner, workspaceId } = await install();
    const { token, secret } = await mint(owner, workspaceId, ["workspace:read"]);
    const revoke = () =>
      owner.request(`/v1/workspaces/${workspaceId}/tokens/${token.id}`, { method: "DELETE" });
    expect((await revoke()).status).toBe(204);
    expect((await revoke()).status).toBe(204);
    expect((await as(secret, `/v1/workspaces/${workspaceId}`)).status).toBe(401);
    const list = await owner.json<{ tokens: { revoked_at: number | null }[] }>(
      `/v1/workspaces/${workspaceId}/tokens`,
    );
    expect(list.body.tokens[0]!.revoked_at).toEqual(expect.any(Number));
    const n = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_logs WHERE action = 'token.revoked'",
    ).first<{ n: number }>();
    expect(n?.n).toBe(1);
    expect(
      (
        await owner.request(`/v1/workspaces/${workspaceId}/tokens/tok_missing`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
  });

  it("can't revoke another workspace's token", async () => {
    const { owner, workspaceId } = await install();
    const other = await owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Other" },
    });
    const { token } = await mint(owner, other.body.id, ["workspace:read"]);
    const res = await owner.request(`/v1/workspaces/${workspaceId}/tokens/${token.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("records last use at most once a minute", async () => {
    const { owner, workspaceId } = await install();
    const { token, secret } = await mint(owner, workspaceId, ["workspace:read"]);
    const lastUsed = async () =>
      (
        await env.DB.prepare("SELECT last_used_at FROM api_tokens WHERE id = ?")
          .bind(token.id)
          .first<{ last_used_at: number | null }>()
      )?.last_used_at;
    await as(secret, `/v1/workspaces/${workspaceId}`);
    const first = await lastUsed();
    expect(first).toEqual(expect.any(Number));
    await as(secret, `/v1/workspaces/${workspaceId}`);
    expect(await lastUsed()).toBe(first);
    await env.DB.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
      .bind(Date.now() - 61_000, token.id)
      .run();
    await as(secret, `/v1/workspaces/${workspaceId}`);
    expect(await lastUsed()).toBeGreaterThan(first! - 1);
  });
});

describe("abuse", () => {
  const original = env.AUTH_LIMITER;
  afterEach(() => {
    (env as { AUTH_LIMITER?: RateLimit }).AUTH_LIMITER = original;
  });

  it("rate-limits failed token authentication per address, not successful use", async () => {
    const { owner, workspaceId } = await install();
    const { secret } = await mint(owner, workspaceId, ["workspace:read"]);
    const keys: string[] = [];
    let remaining = 3;
    (env as { AUTH_LIMITER?: RateLimit }).AUTH_LIMITER = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: remaining-- > 0 };
      },
    };
    const bad = () =>
      call(`/v1/workspaces/${workspaceId}`, {
        headers: { authorization: "Bearer tok_guess", "cf-connecting-ip": "198.51.100.7" },
      });
    for (let i = 0; i < 3; i++) expect((await bad()).status).toBe(401);
    const limited = await bad();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(keys.every((k) => k === "token:198.51.100.7")).toBe(true);
    const callsBefore = keys.length;
    expect((await as(secret, `/v1/workspaces/${workspaceId}`)).status).toBe(200);
    expect(keys.length).toBe(callsBefore);
  });

  it("exempts bearer requests from the same-origin guard, not cookie ones", async () => {
    const { owner, workspaceId } = await install();
    const { secret } = await mint(owner, workspaceId, ["projects:read", "projects:create"]);
    const evil = { origin: "https://evil.test", "sec-fetch-site": "cross-site" };
    const bearer = await call(`/v1/workspaces/${workspaceId}/projects`, {
      method: "POST",
      json: { name: "CI" },
      headers: { ...evil, authorization: `Bearer ${secret}` },
    });
    expect(bearer.status).toBe(201);
    const cookie = await call(
      `/v1/workspaces/${workspaceId}/projects`,
      { method: "POST", json: { name: "CSRF" }, headers: evil },
      owner.cookie,
    );
    expect(cookie.status).toBe(403);
    const same = await call(
      `/v1/workspaces/${workspaceId}/projects`,
      { method: "POST", json: { name: "OK" }, headers: { origin: ORIGIN } },
      owner.cookie,
    );
    expect(same.status).toBe(201);
  });
});
