/**
 * Two-factor authentication end to end (ADR 0014 "Auth"): the gate in
 * front of admins' mutations, enrollment through Better Auth's endpoints,
 * sign-in with TOTP and backup codes, replay and lockout protection, hashed
 * backup codes, changing 2FA only with a current code, the admin reset, and
 * `verifySecondFactor` for other callers.
 */
import { env } from "cloudflare:test";
import { createDb } from "@roundhouse/db";
import { LOGIN_FREE_ATTEMPTS } from "@roundhouse/shared";
import { symmetricDecrypt } from "better-auth/crypto";
import { describe, expect, it } from "vitest";
import { authSecretsFor } from "../src/lib/auth-secrets";
import { hotp, totpStep } from "../src/lib/totp";
import { verifySecondFactor } from "../src/lib/two-factor";
import { addMember, type Client, call, client, install } from "./helpers";

const EMAIL = "mara@example.com";
const PASSWORD = "correct horse battery";

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .filter((c) => !c.endsWith("="))
    .join("; ");
}

function base32Decode(input: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of input.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return new TextDecoder().decode(new Uint8Array(bytes));
}

interface Enrolled {
  secret: string;
  backupCodes: string[];
  /** A code for a step nobody has used yet. */
  code(): Promise<string>;
}

/** Enrolls the signed-in user through `/api/auth/two-factor/*`. */
async function enroll(user: Client, password = PASSWORD): Promise<Enrolled> {
  const enabled = await user.json<{ totpURI: string; backupCodes: string[] }>(
    "/api/auth/two-factor/enable",
    { method: "POST", json: { password } },
  );
  expect(enabled.status).toBe(200);
  const uri = new URL(enabled.body.totpURI);
  expect(uri.protocol).toBe("otpauth:");
  expect(decodeURIComponent(uri.pathname)).toContain("Roundhouse");
  const secret = base32Decode(uri.searchParams.get("secret")!);
  let last = totpStep(Date.now()) - 2;
  const code = async () => {
    last = Math.max(last + 1, totpStep(Date.now()) - 1);
    return hotp(secret, last);
  };
  const verified = await user.request("/api/auth/two-factor/verify-totp", {
    method: "POST",
    json: { code: await code() },
  });
  expect(verified.status).toBe(200);
  // Enabling re-issues the session cookie.
  const fresh = cookiesOf(verified);
  if (fresh) Object.assign(user, client(fresh));
  return { secret, backupCodes: enabled.body.backupCodes, code };
}

function startSignIn(email = EMAIL, password = PASSWORD) {
  return call("/api/auth/sign-in/email", { method: "POST", json: { email, password } });
}

async function challenge(email = EMAIL, password = PASSWORD): Promise<string> {
  const res = await startSignIn(email, password);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ twoFactorRedirect: true });
  const cookies = cookiesOf(res);
  expect(cookies).toContain("two_factor");
  expect(cookies).not.toContain("session_token=");
  return cookies;
}

function verifyTotp(cookie: string, code: string, extra: Record<string, unknown> = {}) {
  return call(
    "/api/auth/two-factor/verify-totp",
    { method: "POST", json: { code, ...extra } },
    cookie,
  );
}

function verifyBackup(cookie: string, code: string) {
  return call(
    "/api/auth/two-factor/verify-backup-code",
    { method: "POST", json: { code } },
    cookie,
  );
}

async function actions(prefix = "auth.") {
  const { results } = await env.DB.prepare(
    "SELECT action, workspace_id, metadata FROM audit_logs WHERE action LIKE ? ORDER BY seq",
  )
    .bind(`${prefix}%`)
    .all<{ action: string; workspace_id: string | null; metadata: string | null }>();
  return results;
}

describe("the two-factor gate", () => {
  it("stops an admin without 2FA from changing anything, but lets them read", async () => {
    const { owner, workspaceId } = await install({ twoFactor: false });
    expect((await owner.request("/v1/me")).status).toBe(200);
    const res = await owner.request(`/v1/workspaces/${workspaceId}/invites`, {
      method: "POST",
      json: { email: "a@example.com", role: "member" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: "two_factor_required", message: expect.stringContaining("two-factor") },
    });
    const status = await owner.json("/v1/auth/security");
    expect(status.body).toMatchObject({
      two_factor_enabled: false,
      two_factor_required: true,
      backup_codes_remaining: null,
      instance_admin: true,
    });
  });

  it("lets members without 2FA work, and gates them once promoted", async () => {
    const { owner, workspaceId } = await install();
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    const me = await member.json<{ workspaces: { member_id: string }[] }>("/v1/me");
    const memberId = me.body.workspaces[0]!.member_id;
    const promote = await owner.request(`/v1/workspaces/${workspaceId}/members/${memberId}`, {
      method: "PATCH",
      json: { role: "admin" },
    });
    expect(promote.status).toBe(200);
    const gated = await member.request(`/v1/workspaces/${workspaceId}/invites`, {
      method: "POST",
      json: { email: "b@example.com", role: "viewer" },
    });
    expect(gated.status).toBe(403);
    expect(await gated.json()).toMatchObject({ error: { code: "two_factor_required" } });

    const demote = await owner.request(`/v1/workspaces/${workspaceId}/members/${memberId}`, {
      method: "PATCH",
      json: { role: "member" },
    });
    expect(demote.status).toBe(200);
    // Leaving is a mutation too; a member without 2FA may do it.
    const leave = await member.request(`/v1/workspaces/${workspaceId}/members/${memberId}`, {
      method: "DELETE",
    });
    expect(leave.status).toBe(204);
  });

  it("applies to API tokens acting for an unenrolled admin", async () => {
    const { owner, workspaceId, userId } = await install();
    const token = await owner.json<{ secret: string }>(`/v1/workspaces/${workspaceId}/tokens`, {
      method: "POST",
      json: { name: "ci", scopes: ["projects:create", "projects:read"], expires_in_days: 1 },
    });
    expect(token.status).toBe(201);
    await env.DB.prepare("UPDATE users SET two_factor_enabled = 0 WHERE id = ?").bind(userId).run();
    const res = await call(`/v1/workspaces/${workspaceId}/projects`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.body.secret}` },
      json: { name: "api" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "two_factor_required" } });
  });

  it("opens once the admin enrolls", async () => {
    const { owner, workspaceId } = await install({ twoFactor: false });
    await enroll(owner);
    const res = await owner.request(`/v1/workspaces/${workspaceId}/invites`, {
      method: "POST",
      json: { email: "a@example.com", role: "member" },
    });
    expect(res.status).toBe(201);
  });
});

describe("enrollment", () => {
  it("turns 2FA on only after a code checks out, and audits it", async () => {
    const { owner, userId } = await install({ twoFactor: false });
    const enabled = await owner.json<{ backupCodes: string[] }>("/api/auth/two-factor/enable", {
      method: "POST",
      json: { password: PASSWORD },
    });
    expect(enabled.body.backupCodes).toHaveLength(10);
    const before = await env.DB.prepare("SELECT two_factor_enabled AS on_ FROM users").first<{
      on_: number;
    }>();
    expect(before?.on_).toBe(0);

    const bad = await owner.request("/api/auth/two-factor/verify-totp", {
      method: "POST",
      json: { code: "000000" },
    });
    expect(bad.status).toBe(401);
    await env.DB.prepare("DELETE FROM two_factors").run();
    await enroll(owner);
    const status = await owner.json("/v1/auth/security");
    expect(status.body).toMatchObject({ two_factor_enabled: true, backup_codes_remaining: 10 });
    const audit = (await actions()).filter((a) => a.action === "auth.two_factor_enabled");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.workspace_id).toBeNull();
    expect(userId).toBeTruthy();
  });

  it("stores backup codes hashed and the secret encrypted under the current key", async () => {
    const { owner } = await install({ twoFactor: false });
    const { secret, backupCodes } = await enroll(owner);
    const row = (await env.DB.prepare("SELECT secret, backup_codes FROM two_factors").first<{
      secret: string;
      backup_codes: string;
    }>())!;
    const { config } = await authSecretsFor(env);
    expect(row.secret.startsWith(`$ba$${config.currentVersion}$`)).toBe(true);
    expect(row.secret).not.toContain(secret);
    const stored = JSON.parse(
      await symmetricDecrypt({ key: config, data: row.backup_codes }),
    ) as string[];
    expect(stored).toHaveLength(10);
    for (const entry of stored) expect(entry).toMatch(/^sha256:[0-9a-f]{64}$/);
    for (const code of backupCodes) expect(row.backup_codes + stored.join()).not.toContain(code);
  });

  it("never hands the secret back", async () => {
    const { owner } = await install({ twoFactor: false });
    await enroll(owner);
    const res = await owner.request("/api/auth/two-factor/get-totp-uri", {
      method: "POST",
      json: { password: PASSWORD },
    });
    expect(res.status).toBe(404);
  });
});

describe("signing in with a second factor", () => {
  it("issues no session until the code checks out", async () => {
    const { owner, userId } = await install({ twoFactor: false });
    const { code } = await enroll(owner);
    const cookie = await challenge();
    expect((await call("/v1/me", {}, cookie)).status).toBe(401);
    const res = await verifyTotp(cookie, await code());
    expect(res.status).toBe(200);
    const session = cookiesOf(res);
    expect(session).toContain("session_token=");
    expect((await client(session).json("/v1/me")).status).toBe(200);
    const succeeded = (await actions()).filter((a) => a.action === "auth.sign_in_succeeded");
    expect(succeeded.map((a) => JSON.parse(a.metadata!))).toEqual([{ method: "totp" }]);
    expect(userId).toBeTruthy();
  });

  it("refuses a code that was already used", async () => {
    const { owner } = await install({ twoFactor: false });
    const { secret } = await enroll(owner);
    const step = totpStep(Date.now()) + 1;
    const code = await hotp(secret, step);
    const first = await verifyTotp(await challenge(), code);
    expect(first.status).toBe(200);
    const replay = await verifyTotp(await challenge(), code);
    expect(replay.status).toBe(401);
    // An earlier step is refused too once a later one was used.
    const older = await verifyTotp(await challenge(), await hotp(secret, step - 1));
    expect(older.status).toBe(401);
    const failed = (await actions()).filter((a) => a.action === "auth.two_factor_failed");
    expect(failed.map((a) => JSON.parse(a.metadata!).reason)).toEqual(["replayed", "replayed"]);
  });

  it("never trusts the device", async () => {
    const { owner } = await install({ twoFactor: false });
    const { code } = await enroll(owner);
    const res = await verifyTotp(await challenge(), await code(), { trustDevice: true });
    expect(res.status).toBe(200);
    expect(cookiesOf(res)).not.toContain("trust_device");
  });

  it("accepts each backup code once", async () => {
    const { owner } = await install({ twoFactor: false });
    const { backupCodes } = await enroll(owner);
    const used = backupCodes[3]!;
    const ok = await verifyBackup(await challenge(), used);
    expect(ok.status).toBe(200);
    expect(cookiesOf(ok)).toContain("session_token=");
    const again = await verifyBackup(await challenge(), used);
    expect(again.status).toBe(401);
    const status = await client(cookiesOf(ok)).json("/v1/auth/security");
    expect(status.body).toMatchObject({ backup_codes_remaining: 9 });
    const audit = (await actions()).filter((a) => a.action === "auth.backup_code_used");
    expect(audit.map((a) => JSON.parse(a.metadata!))).toEqual([{ remaining: 9 }]);
    for (const row of await actions()) expect(row.metadata ?? "").not.toContain(used);
  });

  it("accepts a backup code typed without its dash", async () => {
    const { owner } = await install({ twoFactor: false });
    const { backupCodes } = await enroll(owner);
    const res = await verifyBackup(await challenge(), backupCodes[0]!.replace("-", ""));
    expect(res.status).toBe(200);
  });

  it("counts wrong codes toward the account lockout", async () => {
    const { owner } = await install({ twoFactor: false });
    const { code } = await enroll(owner);
    for (let i = 0; i < LOGIN_FREE_ATTEMPTS; i++) {
      const res = await verifyTotp(await challenge(), "000000");
      expect(res.status).toBe(401);
    }
    const locked = await verifyTotp(await challenge().catch(() => ""), await code());
    expect(locked.status).toBeGreaterThanOrEqual(400);
    const password = await startSignIn();
    expect(password.status).toBe(429);
    expect(await password.json()).toMatchObject({ code: "account_locked" });
    const failed = (await actions()).filter((a) => a.action === "auth.two_factor_failed");
    expect(failed).toHaveLength(LOGIN_FREE_ATTEMPTS);
  });
});

describe("changing two-factor settings", () => {
  it("needs a current code as well as the password to turn 2FA off", async () => {
    const { owner } = await install({ twoFactor: false });
    const { code } = await enroll(owner);
    const noCode = await owner.request("/api/auth/two-factor/disable", {
      method: "POST",
      json: { password: PASSWORD },
    });
    expect(noCode.status).toBe(400);
    const wrong = await owner.request("/api/auth/two-factor/disable", {
      method: "POST",
      json: { password: PASSWORD, code: "000000" },
    });
    expect(wrong.status).toBe(401);
    const ok = await owner.request("/api/auth/two-factor/disable", {
      method: "POST",
      json: { password: PASSWORD, code: await code() },
    });
    expect(ok.status).toBe(200);
    expect(
      (await env.DB.prepare("SELECT two_factor_enabled AS on_ FROM users").first<{ on_: number }>())
        ?.on_,
    ).toBe(0);
    const names = (await actions()).map((a) => a.action);
    expect(names).toContain("auth.two_factor_disabled");
    expect(names.filter((n) => n === "auth.two_factor_failed")).toHaveLength(1);
  });

  it("needs a current code to regenerate backup codes", async () => {
    const { owner } = await install({ twoFactor: false });
    const { code, backupCodes } = await enroll(owner);
    const noCode = await owner.request("/api/auth/two-factor/generate-backup-codes", {
      method: "POST",
      json: { password: PASSWORD },
    });
    expect(noCode.status).toBe(400);
    const ok = await owner.json<{ backupCodes: string[] }>(
      "/api/auth/two-factor/generate-backup-codes",
      { method: "POST", json: { password: PASSWORD, code: await code() } },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.backupCodes).toHaveLength(10);
    const old = await verifyBackup(await challenge(), backupCodes[0]!);
    expect(old.status).toBe(401);
    const fresh = await verifyBackup(await challenge(), ok.body.backupCodes[0]!);
    expect(fresh.status).toBe(200);
    expect((await actions()).map((a) => a.action)).toContain("auth.backup_codes_regenerated");
  });

  it("counts wrong passwords on these endpoints toward the lockout", async () => {
    const { owner } = await install({ twoFactor: false });
    for (let i = 0; i < LOGIN_FREE_ATTEMPTS; i++) {
      const res = await owner.request("/api/auth/two-factor/enable", {
        method: "POST",
        json: { password: "not my password" },
      });
      expect(res.status).toBe(400);
    }
    const locked = await owner.request("/api/auth/two-factor/enable", {
      method: "POST",
      json: { password: PASSWORD },
    });
    expect(locked.status).toBe(429);
  });
});

describe("admin reset", () => {
  it("turns off another user's 2FA and ends their sessions", async () => {
    const { owner, workspaceId } = await install();
    const admin = await addMember(owner, workspaceId, "lost@example.com", "admin");
    const target = (await admin.json<{ user: { id: string } }>("/v1/me")).body.user.id;
    const res = await owner.request(`/v1/instance/users/${target}/two-factor`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect((await admin.request("/v1/me")).status).toBe(401);
    const row = await env.DB.prepare(
      "SELECT two_factor_enabled AS on_, (SELECT count(*) FROM two_factors WHERE user_id = users.id) AS n FROM users WHERE id = ?",
    )
      .bind(target)
      .first<{ on_: number; n: number }>();
    expect(row).toEqual({ on_: 0, n: 0 });
    expect((await actions()).map((a) => a.action)).toContain("auth.two_factor_reset");
  });

  it("refuses an admin resetting their own 2FA, and non-admins", async () => {
    const { owner, userId, workspaceId } = await install();
    const self = await owner.request(`/v1/instance/users/${userId}/two-factor`, {
      method: "DELETE",
    });
    expect(self.status).toBe(403);
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    const res = await member.request(`/v1/instance/users/${userId}/two-factor`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });
});

describe("verifySecondFactor", () => {
  it("accepts a TOTP code once and a backup code once", async () => {
    const { owner, userId } = await install({ twoFactor: false });
    const { secret, backupCodes } = await enroll(owner);
    const db = createDb(env.DB);
    const code = await hotp(secret, totpStep(Date.now()) + 1);
    expect(await verifySecondFactor(db, env, userId, code)).toEqual({ method: "totp" });
    expect(await verifySecondFactor(db, env, userId, code)).toBeNull();
    expect(await verifySecondFactor(db, env, userId, backupCodes[1]!)).toEqual({
      method: "backup_code",
      backupCodesRemaining: 9,
    });
    expect(await verifySecondFactor(db, env, userId, backupCodes[1]!)).toBeNull();
    expect(await verifySecondFactor(db, env, userId, "nonsense")).toBeNull();
  });

  it("refuses users without 2FA", async () => {
    const { userId } = await install({ twoFactor: false });
    expect(await verifySecondFactor(createDb(env.DB), env, userId, "123456")).toBeNull();
  });
});
