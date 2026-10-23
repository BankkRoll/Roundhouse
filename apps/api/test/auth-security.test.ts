/**
 * Account security routes (ADR 0014 "Auth"): security status,
 * re-authentication, the caller's sessions, and sign-out auditing.
 */
import { env } from "cloudflare:test";
import { LOGIN_FREE_ATTEMPTS, REAUTH_WINDOW_MS } from "@roundhouse/shared";
import { describe, expect, it } from "vitest";
import { DISABLED_AUTH_PATHS } from "../src/auth";
import { rateLimitBucket } from "../src/lib/guards";
import { addMember, call, install, nextTotpCode, signInAs } from "./helpers";

const EMAIL = "mara@example.com";
const PASSWORD = "correct horse battery";

async function actions() {
  const { results } = await env.DB.prepare(
    "SELECT action, workspace_id, actor_id, target_id, metadata FROM audit_logs WHERE action LIKE 'auth.%' ORDER BY seq",
  ).all<{
    action: string;
    workspace_id: string | null;
    actor_id: string | null;
    target_id: string | null;
    metadata: string | null;
  }>();
  return results;
}

describe("GET /v1/auth/security", () => {
  it("reports 2FA, backup codes and freshness", async () => {
    const { owner } = await install();
    const res = await owner.json<{ fresh_until: number }>("/v1/auth/security");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      two_factor_enabled: true,
      two_factor_required: true,
      backup_codes_remaining: 0,
      instance_admin: true,
      fresh_until: expect.any(Number),
    });
    expect(res.body.fresh_until).toBeGreaterThan(Date.now());
  });

  it("refuses API tokens and anonymous callers", async () => {
    const { owner, workspaceId } = await install();
    const token = await owner.json<{ secret: string }>(`/v1/workspaces/${workspaceId}/tokens`, {
      method: "POST",
      json: { name: "ci", scopes: ["projects:read"], expires_in_days: 1 },
    });
    const viaToken = await call("/v1/auth/security", {
      headers: { authorization: `Bearer ${token.body.secret}` },
    });
    expect(viaToken.status).toBe(403);
    expect((await call("/v1/auth/security")).status).toBe(401);
  });
});

describe("POST /v1/auth/reauth", () => {
  async function staleSession() {
    const { owner, userId } = await install();
    await env.DB.prepare("UPDATE sessions SET created_at = ?")
      .bind(Date.now() - REAUTH_WINDOW_MS - 60_000)
      .run();
    return { owner, userId };
  }

  it("makes the session fresh with the password and a current code", async () => {
    const { owner, userId } = await staleSession();
    const before = await owner.json<{ fresh_until: number | null }>("/v1/auth/security");
    expect(before.body.fresh_until).toBeNull();
    const res = await owner.json<{ fresh_until: number }>("/v1/auth/reauth", {
      method: "POST",
      json: { password: PASSWORD, code: await nextTotpCode(EMAIL) },
    });
    expect(res.status).toBe(200);
    expect(res.body.fresh_until).toBeGreaterThan(Date.now() + REAUTH_WINDOW_MS - 5_000);
    const after = await owner.json<{ fresh_until: number | null }>("/v1/auth/security");
    expect(after.body.fresh_until).toBe(res.body.fresh_until);
    const audit = (await actions()).filter((a) => a.action === "auth.reauthenticated");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ workspace_id: null, actor_id: userId });
  });

  it("needs the code when 2FA is on", async () => {
    const { owner } = await staleSession();
    const res = await owner.request("/v1/auth/reauth", {
      method: "POST",
      json: { password: PASSWORD },
    });
    expect(res.status).toBe(400);
    const wrong = await owner.request("/v1/auth/reauth", {
      method: "POST",
      json: { password: PASSWORD, code: "000000" },
    });
    expect(wrong.status).toBe(401);
    expect((await actions()).map((a) => a.action)).toContain("auth.two_factor_failed");
  });

  it("refuses a wrong password, audits it, and counts it toward the lockout", async () => {
    const { owner, userId } = await staleSession();
    for (let i = 0; i < LOGIN_FREE_ATTEMPTS; i++) {
      const res = await owner.request("/v1/auth/reauth", {
        method: "POST",
        json: { password: "not my password" },
      });
      expect(res.status).toBe(401);
    }
    const locked = await owner.request("/v1/auth/reauth", {
      method: "POST",
      json: { password: PASSWORD, code: await nextTotpCode(EMAIL) },
    });
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await locked.json()).toMatchObject({ error: { code: "account_locked" } });
    const failed = (await actions()).filter((a) => a.action === "auth.sign_in_failed");
    expect(failed).toHaveLength(LOGIN_FREE_ATTEMPTS);
    expect(JSON.parse(failed[0]!.metadata!)).toMatchObject({ reason: "reauth_password" });
    for (const row of failed) expect(row.metadata).not.toContain("not my password");
    expect(failed[0]!.target_id).toBe(userId);
    // The same counter guards password sign-in.
    const signIn = await call("/api/auth/sign-in/email", {
      method: "POST",
      json: { email: EMAIL, password: PASSWORD },
    });
    expect(signIn.status).toBe(429);
  });

  it("shares the per-IP sign-in limiter", () => {
    expect(rateLimitBucket("POST", "/v1/auth/reauth")).toBe("auth");
    expect(rateLimitBucket("POST", "/v1//auth/reauth/")).toBe("auth");
  });

  it("is passed by members without 2FA with the password alone", async () => {
    const { owner, workspaceId } = await install();
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    const res = await member.request("/v1/auth/reauth", {
      method: "POST",
      json: { password: "a perfectly fine password" },
    });
    expect(res.status).toBe(200);
  });
});

describe("sessions", () => {
  it("lists the caller's sessions without tokens and marks the current one", async () => {
    const { owner } = await install();
    await signInAs(EMAIL, PASSWORD);
    const res = await owner.json<{ sessions: Record<string, unknown>[] }>("/v1/auth/sessions");
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions.filter((s) => s.current)).toHaveLength(1);
    for (const s of res.body.sessions) {
      expect(Object.keys(s).sort()).toEqual(
        ["created_at", "current", "expires_at", "id", "ip_address", "user_agent"].sort(),
      );
    }
    const tokens = await env.DB.prepare("SELECT token FROM sessions").all<{ token: string }>();
    const text = JSON.stringify(res.body);
    for (const { token } of tokens.results) expect(text).not.toContain(token);
  });

  it("revokes one session, audited, and refuses other users' sessions", async () => {
    const { owner, userId } = await install();
    const other = await signInAs(EMAIL, PASSWORD);
    const list = await owner.json<{ sessions: { id: string; current: boolean }[] }>(
      "/v1/auth/sessions",
    );
    const target = list.body.sessions.find((s) => !s.current)!;
    const res = await owner.request(`/v1/auth/sessions/${target.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect((await other.request("/v1/me")).status).toBe(401);
    expect((await owner.request("/v1/me")).status).toBe(200);
    expect(
      (await owner.request(`/v1/auth/sessions/${target.id}`, { method: "DELETE" })).status,
    ).toBe(404);
    const [audit] = (await actions()).filter((a) => a.action === "auth.session_revoked");
    expect(audit).toMatchObject({ workspace_id: null, actor_id: userId, target_id: target.id });
    expect(JSON.parse(audit!.metadata!)).toEqual({ scope: "one", current: false });
  });

  it("revokes every other session", async () => {
    const { owner } = await install();
    const a = await signInAs(EMAIL, PASSWORD);
    const b = await signInAs(EMAIL, PASSWORD);
    const res = await owner.json<{ revoked: number }>("/v1/auth/sessions", { method: "DELETE" });
    expect(res.body).toEqual({ revoked: 2 });
    expect((await a.request("/v1/me")).status).toBe(401);
    expect((await b.request("/v1/me")).status).toBe(401);
    expect((await owner.request("/v1/me")).status).toBe(200);
  });

  it("keeps Better Auth's token-revealing session endpoints off", async () => {
    const { owner } = await install();
    expect(DISABLED_AUTH_PATHS).toContain("/list-sessions");
    const res = await owner.request("/api/auth/list-sessions");
    expect(res.status).toBe(404);
  });
});

describe("sign-out", () => {
  it("is audited at instance level", async () => {
    const { owner, userId } = await install();
    const res = await owner.request("/api/auth/sign-out", { method: "POST", json: {} });
    expect(res.status).toBe(200);
    const [audit] = (await actions()).filter((a) => a.action === "auth.signed_out");
    expect(audit).toMatchObject({ workspace_id: null, actor_id: userId });
  });
});
