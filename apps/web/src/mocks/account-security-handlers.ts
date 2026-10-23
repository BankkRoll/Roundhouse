/**
 * MSW handlers for account security (`apps/api/src/routes/auth-security.ts`: status,
 * sessions, the instance admin's lockout and two-factor tools) and Better Auth's
 * two-factor endpoints, against {@link db}.security. Re-authentication is in
 * `./security-handlers`, which checks codes with {@link spendCode}. Better Auth answers in its
 * own flat `{ code, message }` shape; the `/v1` routes use the API's envelope.
 *
 * @module
 */
import { REAUTH_WINDOW_MS, TWO_FACTOR_REQUIRED_ROLES } from "@roundhouse/shared";
import { HttpResponse, http } from "msw";
import type { AccountSession, SecurityStatus } from "../lib/api/security-types";
import {
  apiError,
  currentUser,
  invalid,
  notFound,
  requireFreshSession,
  unauthorized,
} from "./common";
import { db, PASSWORD } from "./db";
import {
  CURRENT_SESSION_ID,
  MOCK_BACKUP_CODES,
  MOCK_TOTP_CODE,
  MOCK_TOTP_URI,
} from "./security-db";

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const betterAuthError = (status: number, code: string, message: string) =>
  HttpResponse.json({ code, message }, { status });

const invalidPassword = () => betterAuthError(400, "INVALID_PASSWORD", "Invalid password");
const invalidCode = () => betterAuthError(401, "INVALID_CODE", "Invalid code");

function passwordOf(userId: string): string {
  return db.users.find((user) => user.id === userId)?.password ?? PASSWORD;
}

/**
 * Checks a code the way the API's `verifySecondFactor` does: TOTP, else a backup code
 * (which is then used up).
 *
 * @param userId - The user.
 * @param code - The code entered.
 * @returns Whether it was accepted.
 */
export function spendCode(userId: string, code: unknown): boolean {
  if (typeof code !== "string") return false;
  const entered = code.trim();
  if (entered === MOCK_TOTP_CODE) return true;
  const enrolled = db.security.twoFactor[userId];
  const normalized = /^[A-Za-z0-9]{10}$/.test(entered)
    ? `${entered.slice(0, 5)}-${entered.slice(5)}`
    : entered;
  const index = enrolled?.backupCodes.indexOf(normalized) ?? -1;
  if (!enrolled || index < 0) return false;
  enrolled.backupCodes.splice(index, 1);
  return true;
}

function sessionsOf(userId: string): AccountSession[] {
  const now = Date.now();
  const current: AccountSession = {
    id: CURRENT_SESSION_ID,
    current: true,
    ip_address: "203.0.113.5",
    user_agent: navigator.userAgent,
    created_at: now - 3_600_000,
    expires_at: now + 7 * 86_400_000,
  };
  const others = db.security.otherSessions
    .filter((session) => session.user_id === userId)
    .map(({ user_id: _user, ...session }) => session);
  return [current, ...others].sort((a, b) => b.created_at - a.created_at);
}

/** Account security and two-factor handlers. */
export const accountSecurityHandlers = [
  // ---------------------------------------------------------------------------
  // /v1/auth (routes/auth-security.ts)
  // ---------------------------------------------------------------------------
  http.get("*/v1/auth/security", () => {
    const user = currentUser();
    if (!user) return unauthorized();
    const roles = db.memberships.filter((row) => row.user_id === user.id).map((row) => row.role);
    const enrolled = db.security.twoFactor[user.id];
    const status: SecurityStatus = {
      two_factor_enabled: Boolean(enrolled),
      two_factor_required:
        Boolean(user.instance_admin) ||
        roles.some((role) => (TWO_FACTOR_REQUIRED_ROLES as readonly string[]).includes(role)),
      backup_codes_remaining: enrolled ? enrolled.backupCodes.length : null,
      instance_admin: Boolean(user.instance_admin),
      fresh_until: db.sessionStale ? null : Date.now() + REAUTH_WINDOW_MS / 2,
    };
    return HttpResponse.json(status);
  }),

  http.get("*/v1/auth/sessions", () => {
    const user = currentUser();
    if (!user) return unauthorized();
    return HttpResponse.json({ sessions: sessionsOf(user.id) });
  }),

  http.delete("*/v1/auth/sessions/:sessionId", ({ params }) => {
    const user = currentUser();
    if (!user) return unauthorized();
    const id = String(params.sessionId);
    if (id === CURRENT_SESSION_ID) {
      db.sessionUserId = null;
      return new HttpResponse(null, { status: 204 });
    }
    const index = db.security.otherSessions.findIndex(
      (session) => session.id === id && session.user_id === user.id,
    );
    if (index < 0) return notFound("Session");
    db.security.otherSessions.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  http.delete("*/v1/auth/sessions", () => {
    const user = currentUser();
    if (!user) return unauthorized();
    const before = db.security.otherSessions.length;
    db.security.otherSessions = db.security.otherSessions.filter(
      (session) => session.user_id !== user.id,
    );
    return HttpResponse.json({ revoked: before - db.security.otherSessions.length });
  }),

  http.post("*/v1/instance/sign-in-lockouts/clear", async ({ request }) => {
    const body = await readJson(request);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (email.length < 3) return invalid("email: Too small");
    const user = currentUser();
    if (!user) return unauthorized();
    if (!user.instance_admin) {
      return apiError(403, "forbidden", "Only instance admins can perform instance:manage");
    }
    const cleared = email in db.security.locked;
    delete db.security.locked[email];
    return HttpResponse.json({ cleared });
  }),

  http.delete("*/v1/instance/users/:userId/two-factor", ({ params }) => {
    const user = currentUser();
    if (!user) return unauthorized();
    const stale = requireFreshSession();
    if (stale) return stale;
    if (!user.instance_admin) {
      return apiError(403, "forbidden", "Only instance admins can perform instance:manage");
    }
    const target = String(params.userId);
    if (target === user.id) {
      return apiError(
        403,
        "forbidden",
        "Turn off your own two-factor authentication under Settings → Security",
      );
    }
    if (!db.users.some((candidate) => candidate.id === target)) return notFound("User");
    delete db.security.twoFactor[target];
    db.security.otherSessions = db.security.otherSessions.filter(
      (session) => session.user_id !== target,
    );
    return new HttpResponse(null, { status: 204 });
  }),

  // ---------------------------------------------------------------------------
  // Better Auth's two-factor plugin
  // ---------------------------------------------------------------------------
  http.post("*/api/auth/two-factor/enable", async ({ request }) => {
    const user = currentUser();
    if (!user) return betterAuthError(401, "UNAUTHORIZED", "Unauthorized");
    const body = await readJson(request);
    if (body.password !== passwordOf(user.id)) return invalidPassword();
    if (db.security.twoFactor[user.id]) {
      return betterAuthError(400, "TOTP_ALREADY_ENABLED", "TOTP already enabled");
    }
    db.security.pending[user.id] = { backupCodes: [...MOCK_BACKUP_CODES] };
    return HttpResponse.json({
      method: "totp",
      totpURI: MOCK_TOTP_URI,
      backupCodes: [...MOCK_BACKUP_CODES],
    });
  }),

  http.post("*/api/auth/two-factor/verify-totp", async ({ request }) => {
    const body = await readJson(request);
    const user = currentUser();
    if (user) {
      const pending = db.security.pending[user.id];
      if (!pending && !db.security.twoFactor[user.id]) {
        return betterAuthError(400, "TOTP_NOT_ENABLED", "TOTP not enabled");
      }
      if (body.code !== MOCK_TOTP_CODE) return invalidCode();
      if (pending) {
        db.security.twoFactor[user.id] = pending;
        delete db.security.pending[user.id];
      }
      const { password: _password, ...publicUser } = user;
      return HttpResponse.json({ token: "session-token", user: publicUser });
    }
    const challenged = db.users.find((candidate) => candidate.id === db.security.challengeUserId);
    if (!challenged) {
      return betterAuthError(401, "INVALID_TWO_FACTOR_COOKIE", "Invalid two factor cookie");
    }
    if (body.code !== MOCK_TOTP_CODE) return invalidCode();
    db.security.challengeUserId = null;
    db.sessionUserId = challenged.id;
    const { password: _password, ...publicUser } = challenged;
    return HttpResponse.json({ token: "session-token", user: publicUser });
  }),

  http.post("*/api/auth/two-factor/verify-backup-code", async ({ request }) => {
    const body = await readJson(request);
    const userId = currentUser()?.id ?? db.security.challengeUserId;
    const user = db.users.find((candidate) => candidate.id === userId);
    if (!user) {
      return betterAuthError(401, "INVALID_TWO_FACTOR_COOKIE", "Invalid two factor cookie");
    }
    if (body.code === MOCK_TOTP_CODE || !spendCode(user.id, body.code)) {
      return betterAuthError(401, "INVALID_BACKUP_CODE", "Invalid backup code");
    }
    db.security.challengeUserId = null;
    db.sessionUserId = user.id;
    const { password: _password, ...publicUser } = user;
    return HttpResponse.json({ token: "session-token", user: publicUser });
  }),

  http.post("*/api/auth/two-factor/disable", async ({ request }) => {
    const user = currentUser();
    if (!user) return betterAuthError(401, "UNAUTHORIZED", "Unauthorized");
    const body = await readJson(request);
    if (typeof body.code !== "string" || !body.code) {
      return betterAuthError(
        400,
        "CODE_REQUIRED",
        "Enter a code from your authenticator app or a backup code",
      );
    }
    if (!spendCode(user.id, body.code)) return invalidCode();
    if (body.password !== passwordOf(user.id)) return invalidPassword();
    delete db.security.twoFactor[user.id];
    return HttpResponse.json({ status: true });
  }),

  http.post("*/api/auth/two-factor/generate-backup-codes", async ({ request }) => {
    const user = currentUser();
    if (!user) return betterAuthError(401, "UNAUTHORIZED", "Unauthorized");
    const body = await readJson(request);
    if (typeof body.code !== "string" || !body.code) {
      return betterAuthError(
        400,
        "CODE_REQUIRED",
        "Enter a code from your authenticator app or a backup code",
      );
    }
    if (!spendCode(user.id, body.code)) return invalidCode();
    if (body.password !== passwordOf(user.id)) return invalidPassword();
    const fresh = MOCK_BACKUP_CODES.map((code) => code.split("").reverse().join(""));
    db.security.twoFactor[user.id] = { backupCodes: [...fresh] };
    return HttpResponse.json({ status: true, backupCodes: fresh });
  }),
];
