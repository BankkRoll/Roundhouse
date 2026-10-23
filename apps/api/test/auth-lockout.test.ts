/**
 * Per-account sign-in lockout (ADR 0014 "Auth"): five free failures, then
 * 429 `account_locked` before the password is checked; unknown addresses
 * lock the same way; a complete sign-in or an instance admin clears it; and
 * sign-in attempts are audited without passwords or addresses.
 */
import { env } from "cloudflare:test";
import { LOGIN_FREE_ATTEMPTS } from "@roundhouse/shared";
import { describe, expect, it } from "vitest";
import { loginKey } from "../src/lib/lockout";
import { addMember, call, install, signInAs } from "./helpers";

const EMAIL = "mara@example.com";
const PASSWORD = "correct horse battery";

const signIn = (email: string, password: string) =>
  call("/api/auth/sign-in/email", { method: "POST", json: { email, password } });

async function failTimes(email: string, n: number) {
  for (let i = 0; i < n; i++) {
    const res = await signIn(email, "definitely wrong pw");
    expect(res.status).toBe(401);
  }
}

async function auditRows(action: string) {
  const { results } = await env.DB.prepare(
    "SELECT workspace_id, actor_id, target_id, metadata FROM audit_logs WHERE action = ? ORDER BY seq",
  )
    .bind(action)
    .all<{
      workspace_id: string | null;
      actor_id: string | null;
      target_id: string | null;
      metadata: string | null;
    }>();
  return results;
}

describe("sign-in lockout", () => {
  it("locks an account after the free attempts, even for the right password", async () => {
    await install();
    await failTimes(EMAIL, LOGIN_FREE_ATTEMPTS);
    const locked = await signIn(EMAIL, PASSWORD);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThanOrEqual(25);
    expect(Number(locked.headers.get("retry-after"))).toBeLessThanOrEqual(30);
    expect(await locked.json()).toEqual({
      code: "account_locked",
      message: expect.stringMatching(/^Too many failed attempts\. Try again in \d+ seconds\.$/),
    });
  });

  it("allows the free attempts without locking", async () => {
    await install();
    await failTimes(EMAIL, LOGIN_FREE_ATTEMPTS - 1);
    const client = await signInAs(EMAIL, PASSWORD);
    expect((await client.json("/v1/me")).status).toBe(200);
    // A complete sign-in forgets earlier failures.
    const rows = await env.DB.prepare("SELECT count(*) AS n FROM login_attempts").first<{
      n: number;
    }>();
    expect(rows?.n).toBe(0);
  });

  it("locks unknown addresses exactly like real ones", async () => {
    await install();
    await failTimes("nobody@example.com", LOGIN_FREE_ATTEMPTS);
    const unknown = await signIn("nobody@example.com", PASSWORD);
    await failTimes(EMAIL, LOGIN_FREE_ATTEMPTS);
    const known = await signIn(EMAIL, PASSWORD);
    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual(await known.json());
  });

  it("keys the counter on the lowercased address and stores no address", async () => {
    await install();
    await failTimes("MARA@Example.com", 2);
    const { results } = await env.DB.prepare("SELECT id, failures FROM login_attempts").all<{
      id: string;
      failures: number;
    }>();
    expect(results).toEqual([{ id: await loginKey(EMAIL), failures: 2 }]);
    expect(results[0]!.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("doubles the lock with every further failure", async () => {
    await install();
    await failTimes(EMAIL, LOGIN_FREE_ATTEMPTS);
    await env.DB.prepare("UPDATE login_attempts SET locked_until = ?")
      .bind(Date.now() - 1)
      .run();
    await failTimes(EMAIL, 1);
    const locked = await signIn(EMAIL, PASSWORD);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(30);
  });

  it("lets the account in once the lock has expired", async () => {
    await install();
    await failTimes(EMAIL, LOGIN_FREE_ATTEMPTS);
    await env.DB.prepare("UPDATE login_attempts SET locked_until = ?")
      .bind(Date.now() - 1)
      .run();
    const client = await signInAs(EMAIL, PASSWORD);
    expect((await client.json("/v1/me")).status).toBe(200);
  });

  it("audits failures, locks and successes at instance level without secrets", async () => {
    const { userId } = await install();
    await failTimes(EMAIL, LOGIN_FREE_ATTEMPTS);
    await signIn(EMAIL, PASSWORD);
    const failed = await auditRows("auth.sign_in_failed");
    expect(failed).toHaveLength(LOGIN_FREE_ATTEMPTS + 1);
    for (const row of failed) {
      expect(row.workspace_id).toBeNull();
      expect(row.actor_id).toBeNull();
      expect(row.target_id).toBe(userId);
      expect(row.metadata).not.toContain("@");
      expect(row.metadata).not.toContain("wrong");
      expect(row.metadata).not.toContain(PASSWORD);
    }
    expect(failed.map((r) => JSON.parse(r.metadata!).reason)).toEqual([
      ...Array(LOGIN_FREE_ATTEMPTS).fill("invalid_credentials"),
      "account_locked",
    ]);
    expect(JSON.parse(failed[0]!.metadata!).email_hash).toBe(await loginKey(EMAIL));
    const locks = await auditRows("auth.account_locked");
    expect(locks).toHaveLength(1);
    expect(JSON.parse(locks[0]!.metadata!)).toMatchObject({ failures: LOGIN_FREE_ATTEMPTS });

    await env.DB.prepare("DELETE FROM login_attempts").run();
    await signInAs(EMAIL, PASSWORD);
    const ok = await auditRows("auth.sign_in_succeeded");
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ workspace_id: null, actor_id: userId });
    expect(JSON.parse(ok[0]!.metadata!)).toEqual({ method: "totp" });
  });

  it("audits unknown addresses without naming a user", async () => {
    await install();
    await failTimes("ghost@example.com", 1);
    const [row] = await auditRows("auth.sign_in_failed");
    expect(row).toMatchObject({ actor_id: null, target_id: null });
  });
});

describe("clearing a lockout", () => {
  it("lets an instance admin lift a lock early", async () => {
    const { owner, userId, workspaceId } = await install();
    await addMember(owner, workspaceId, "x@example.com", "member");
    await failTimes("x@example.com", LOGIN_FREE_ATTEMPTS);
    const res = await owner.json<{ cleared: boolean }>("/v1/instance/sign-in-lockouts/clear", {
      method: "POST",
      json: { email: "X@example.com" },
    });
    expect(res).toEqual({ status: 200, body: { cleared: true } });
    expect((await signIn("x@example.com", "a perfectly fine password")).status).toBe(200);
    const [audit] = await auditRows("auth.account_unlocked");
    expect(audit).toMatchObject({ workspace_id: null, actor_id: userId });
    expect(JSON.parse(audit!.metadata!)).toEqual({ email_hash: await loginKey("x@example.com") });

    const again = await owner.json("/v1/instance/sign-in-lockouts/clear", {
      method: "POST",
      json: { email: "x@example.com" },
    });
    expect(again.body).toEqual({ cleared: false });
  });

  it("is for instance admins only", async () => {
    const { owner, workspaceId } = await install();
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    const res = await member.request("/v1/instance/sign-in-lockouts/clear", {
      method: "POST",
      json: { email: EMAIL },
    });
    expect(res.status).toBe(403);
  });
});
