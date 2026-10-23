/**
 * Fresh sessions (ADR 0014 "Fresh sessions"): every route whose policy says
 * `reauth: true` refuses a stale session and every API token with 403
 * `reauth_required` before its handler runs, and `POST /v1/auth/reauth`
 * makes a session fresh again for `REAUTH_WINDOW_MS`.
 */
import { env } from "cloudflare:test";
import { REAUTH_WINDOW_MS } from "@roundhouse/shared";
import { describe, expect, it } from "vitest";
import { POLICY_KEY, type RoutePolicy } from "../src/contracts";
import { app } from "../src/index";
import { type Client, call, install, nextTotpCode, signInAs } from "./helpers";

const PASSWORD = "correct horse battery";
const EMAIL = "mara@example.com";

/** Password plus an unused code: `install()` enrolls the admin in two-factor. */
async function credentials() {
  return { password: PASSWORD, code: await nextTotpCode(EMAIL) };
}

interface ErrorResponse {
  error: { code: string; message: string; details?: { field: string; code: string }[] };
}

/** Every served operation whose policy needs a fresh session. */
function freshRoutes(): { method: string; path: string }[] {
  const doc = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } });
  const out: { method: string; path: string }[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item as Record<string, Record<string, unknown>>)) {
      if ((op[POLICY_KEY] as RoutePolicy | undefined)?.reauth) out.push({ method, path });
    }
  }
  return out;
}

/** Ages the user's sessions past the window, as if they signed in long ago. */
async function makeStale(userId: string, ago = REAUTH_WINDOW_MS + 60_000) {
  await env.DB.prepare(
    "UPDATE sessions SET created_at = ?, reauthenticated_at = NULL WHERE user_id = ?",
  )
    .bind(Date.now() - ago, userId)
    .run();
}

function concrete(path: string) {
  return path.replace(/\{(\w+)\}/g, (_, name: string) => `${name}_x`);
}

async function createToken(owner: Client, workspaceId: string) {
  const res = await owner.json<{ secret: string }>(`/v1/workspaces/${workspaceId}/tokens`, {
    method: "POST",
    json: {
      name: "ci",
      scopes: ["nodes:manage", "github:manage", "members:manage", "projects:create"],
      expires_in_days: 1,
    },
  });
  if (res.status !== 201) throw new Error(`token: ${res.status}`);
  return res.body.secret;
}

describe("routes that need a fresh session", () => {
  it("include every dangerous route the ADR names", () => {
    const names = freshRoutes().map((r) => `${r.method.toUpperCase()} ${r.path}`);
    expect(names).toEqual(
      expect.arrayContaining([
        "PATCH /v1/instance/settings",
        "POST /v1/github/manifest",
        "DELETE /v1/github/installations/{installationId}",
        "PUT /v1/workspaces/{workspaceId}/integrations/{provider}",
        "DELETE /v1/workspaces/{workspaceId}/integrations/{provider}",
        "POST /v1/workspaces/{workspaceId}/nodes/provision",
        "POST /v1/workspaces/{workspaceId}/node-provisions/{provisionId}/cancel",
        "POST /v1/instance/keys/rotate",
        "PUT /v1/instance/admins/{userId}",
        "PATCH /v1/workspaces/{workspaceId}/access-settings",
        "POST /v1/workspaces/{workspaceId}/teams",
        "DELETE /v1/teams/{teamId}",
        "PUT /v1/teams/{teamId}/members",
        "PUT /v1/projects/{projectId}/access",
        "DELETE /v1/projects/{projectId}/access/{grantId}",
        "PUT /v1/environments/{environmentId}/protection",
      ]),
    );
  });

  it("refuse a stale session on every one of them, before looking at the request", async () => {
    const { owner, userId } = await install();
    await makeStale(userId);
    for (const { method, path } of freshRoutes()) {
      const res = await owner.json<ErrorResponse>(concrete(path), {
        method: method.toUpperCase(),
        json: {},
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error.code, `${method} ${path}`).toBe("reauth_required");
      expect(res.body.error.details?.[0]).toMatchObject({
        field: "session",
        code: "session_stale",
      });
    }
  });

  it("refuse every API token, whatever its scopes and however fresh its creator", async () => {
    const { owner, workspaceId } = await install();
    const secret = await createToken(owner, workspaceId);
    for (const { method, path } of freshRoutes()) {
      const res = await call(concrete(path), {
        method: method.toUpperCase(),
        json: {},
        headers: { authorization: `Bearer ${secret}` },
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      const body = (await res.json()) as ErrorResponse;
      expect(body.error.code).toBe("reauth_required");
      expect(body.error.details?.[0]).toMatchObject({ code: "api_token" });
    }
  });

  it("refuse anonymous callers with 401", async () => {
    await install();
    const res = await call("/v1/instance/settings", {
      method: "PATCH",
      json: { mcp_enabled: false },
    });
    expect(res.status).toBe(401);
  });

  it("let a session through right after sign-in, and leave other routes alone when stale", async () => {
    const { owner, userId } = await install();
    const fresh = await owner.request("/v1/instance/settings", {
      method: "PATCH",
      json: { mcp_enabled: false },
    });
    expect(fresh.status).toBe(200);
    await makeStale(userId);
    expect((await owner.request("/v1/instance/settings")).status).toBe(200);
    const stale = await owner.json<ErrorResponse>("/v1/instance/settings", {
      method: "PATCH",
      json: { mcp_enabled: true },
    });
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe("reauth_required");
    const row = await env.DB.prepare(
      "SELECT value FROM instance_settings WHERE key = 'mcp_enabled'",
    ).first<{ value: string }>();
    expect(JSON.parse(row!.value)).toBe(false);
  });
});

describe("POST /v1/auth/reauth", () => {
  it("makes a stale session fresh for the window, and audits it at instance level", async () => {
    const { owner, userId } = await install();
    await makeStale(userId);
    const before = Date.now();
    const res = await owner.json<{ fresh_until: number }>("/v1/auth/reauth", {
      method: "POST",
      json: await credentials(),
    });
    expect(res.status).toBe(200);
    expect(res.body.fresh_until).toBeGreaterThanOrEqual(before + REAUTH_WINDOW_MS);
    expect(res.body.fresh_until).toBeLessThanOrEqual(Date.now() + REAUTH_WINDOW_MS);

    const patched = await owner.request("/v1/instance/settings", {
      method: "PATCH",
      json: { mcp_enabled: false },
    });
    expect(patched.status).toBe(200);

    const audit = await env.DB.prepare(
      "SELECT workspace_id, actor_id, metadata FROM audit_logs WHERE action = 'auth.reauthenticated'",
    ).all<{ workspace_id: string | null; actor_id: string; metadata: string | null }>();
    expect(audit.results).toEqual([{ workspace_id: null, actor_id: userId, metadata: null }]);

    // The window runs from the re-authentication, not from sign-in.
    await env.DB.prepare("UPDATE sessions SET reauthenticated_at = ? WHERE user_id = ?")
      .bind(Date.now() - REAUTH_WINDOW_MS - 1000, userId)
      .run();
    const lapsed = await owner.json<ErrorResponse>("/v1/instance/settings", {
      method: "PATCH",
      json: { mcp_enabled: true },
    });
    expect(lapsed.body.error.code).toBe("reauth_required");
  });

  it("refuses a wrong password, records the failure without the password, and stays stale", async () => {
    const { owner, userId } = await install();
    await makeStale(userId);
    const res = await owner.json<ErrorResponse>("/v1/auth/reauth", {
      method: "POST",
      json: { password: "not my password at all" },
    });
    expect(res.status).toBe(400);
    const failure = await env.DB.prepare(
      "SELECT workspace_id, actor_id, metadata FROM audit_logs WHERE action = 'auth.sign_in_failed'",
    ).first<{ workspace_id: string | null; actor_id: string; metadata: string }>();
    expect(failure).toMatchObject({ workspace_id: null, actor_id: userId });
    const metadata = JSON.parse(failure!.metadata) as Record<string, string>;
    expect(metadata.reason).toBe("reauth_password");
    expect(metadata.email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(failure!.metadata).not.toContain("not my password");
    expect(failure!.metadata).not.toContain("mara@example.com");

    const still = await owner.json<ErrorResponse>("/v1/instance/settings", {
      method: "PATCH",
      json: { mcp_enabled: false },
    });
    expect(still.body.error.code).toBe("reauth_required");
  });

  it("asks for a second factor when the account has one, and accepts each code once", async () => {
    const { owner, userId } = await install();
    await makeStale(userId);
    const missing = await owner.json<ErrorResponse>("/v1/auth/reauth", {
      method: "POST",
      json: { password: PASSWORD },
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details?.[0]).toMatchObject({ field: "code" });
    const wrong = await owner.json<ErrorResponse>("/v1/auth/reauth", {
      method: "POST",
      json: { password: PASSWORD, code: "000000" },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details?.[0]).toMatchObject({ field: "code" });
    const stamped = await env.DB.prepare(
      "SELECT reauthenticated_at FROM sessions WHERE user_id = ?",
    )
      .bind(userId)
      .first<{ reauthenticated_at: number | null }>();
    expect(stamped?.reauthenticated_at).toBeNull();

    const good = await credentials();
    expect((await owner.request("/v1/auth/reauth", { method: "POST", json: good })).status).toBe(
      200,
    );
    const replay = await owner.json<ErrorResponse>("/v1/auth/reauth", {
      method: "POST",
      json: good,
    });
    expect(replay.status).toBe(400);
  });

  it("refuses API tokens and anonymous callers", async () => {
    const { owner, workspaceId } = await install();
    const secret = await createToken(owner, workspaceId);
    const token = await call("/v1/auth/reauth", {
      method: "POST",
      json: { password: PASSWORD },
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(token.status).toBe(403);
    const anonymous = await call("/v1/auth/reauth", {
      method: "POST",
      json: { password: PASSWORD },
    });
    expect(anonymous.status).toBe(401);
  });

  it("only re-freshes the session that re-authenticated", async () => {
    const { owner, userId } = await install();
    const second = (await signInAs(EMAIL, PASSWORD)).cookie;
    await makeStale(userId);
    expect(
      (await owner.request("/v1/auth/reauth", { method: "POST", json: await credentials() }))
        .status,
    ).toBe(200);
    const other = await call(
      "/v1/instance/settings",
      { method: "PATCH", json: { mcp_enabled: false } },
      second,
    );
    expect(other.status).toBe(403);
  });
});
