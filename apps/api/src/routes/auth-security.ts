/**
 * ADR 0014 account security routes (`AUTH_ROUTES` in `../contracts/auth`):
 * security status, re-authentication, the caller's sessions, and the
 * instance admin's lockout and two-factor recovery tools.
 *
 * `POST /v1/auth/reauth` re-checks the password and, when the account has
 * two-factor on, a TOTP or backup code (`verifySecondFactor`), and stamps
 * `sessions.reauthenticated_at`, which makes the session fresh for
 * `REAUTH_WINDOW_MS` (`lib/fresh-session.ts`; routes with `reauth: true`
 * are guarded by their router). Failures count toward the sign-in lockout.
 * Wrong credentials answer 400, not 401, so the dashboard doesn't take them
 * for an ended session; a missing or wrong code names the `code` field.
 *
 * Owned by the api-auth stream; mounted in `index.ts` already, so adding handlers
 * here needs no change there.
 *
 * @module
 */
import { accounts, sessions, twoFactors, users } from "@roundhouse/db";
import { REAUTH_WINDOW_MS } from "@roundhouse/shared";
import { verifyPassword } from "better-auth/crypto";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import {
  type AppContext,
  actorOf,
  clientIp,
  createRouter,
  requireInstanceAction,
  requirePrincipal,
} from "../context";
import {
  clearSignInLockout,
  getSecurityStatus,
  listSessions,
  reauthenticate,
  resetUserTwoFactor,
  revokeOtherSessions,
  revokeSession,
} from "../contracts/auth";
import { auditInsert, recordAudit } from "../lib/audit";
import { ApiError, notFound } from "../lib/errors";
import { freshUntil } from "../lib/fresh-session";
import {
  accountLocked,
  clearLoginFailures,
  lockedForMs,
  loginKey,
  recordLoginFailure,
  retryAfterSeconds,
} from "../lib/lockout";
import { revalidateShellSessions } from "../lib/shell";
import { twoFactorState, verifySecondFactor } from "../lib/two-factor";
import { twoFactorRequirement } from "../lib/two-factor-gate";

const tokensRefused = () =>
  new ApiError(403, "forbidden", "API tokens can't manage account security; sign in instead");

/** The signed-in browser session, refusing API tokens. */
async function requireSession(c: AppContext) {
  const principal = await requirePrincipal(c);
  if (principal.token || !principal.session) throw tokensRefused();
  return { user: principal.user, sessionId: principal.session.id, principal };
}

async function passwordMatches(c: AppContext, userId: string, password: string) {
  const [row] = await c
    .get("db")
    .select({ hash: accounts.password })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")))
    .limit(1);
  // SECURITY: Without a credential account there is nothing to compare, but
  // the hash still runs so the response time doesn't say so.
  const hash =
    row?.hash ??
    "0000000000000000000000000000000000000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000";
  const ok = await verifyPassword({ hash, password }).catch(() => false);
  return ok && Boolean(row?.hash);
}

async function countReauthFailure(c: AppContext, userId: string, email: string) {
  const db = c.get("db");
  const key = await loginKey(email);
  const failure = await recordLoginFailure(db, key);
  if (failure.lockedForMs) {
    await recordAudit(db, {
      workspaceId: null,
      actorType: "user",
      actorId: null,
      action: "auth.account_locked",
      targetType: "user",
      targetId: userId,
      metadata: { email_hash: key, failures: failure.failures, locked_for_ms: failure.lockedForMs },
      ip: clientIp(c),
    });
  }
}

/** Handlers for `AUTH_ROUTES`. */
export const authSecurityRoutes = createRouter()
  .openapi(getSecurityStatus, async (c) => {
    const { user } = await requireSession(c);
    const db = c.get("db");
    const [requirement, state, fresh] = await Promise.all([
      twoFactorRequirement(db, user.id),
      twoFactorState(db, c.env, user.id),
      freshUntil(c),
    ]);
    return c.json(
      {
        two_factor_enabled: state.enabled,
        two_factor_required: requirement.required,
        backup_codes_remaining: state.backupCodesRemaining,
        instance_admin: requirement.instanceAdmin,
        fresh_until: fresh !== null && fresh > Date.now() ? fresh : null,
      },
      200,
    );
  })
  .openapi(reauthenticate, async (c) => {
    const { user, sessionId } = await requireSession(c);
    const { password, code } = c.req.valid("json");
    const db = c.get("db");
    const key = await loginKey(user.email);
    const ms = await lockedForMs(db, key);
    if (ms) {
      c.header("retry-after", retryAfterSeconds(ms));
      throw accountLocked(ms);
    }

    if (!(await passwordMatches(c, user.id, password))) {
      await recordAudit(db, {
        workspaceId: null,
        actorType: "user",
        actorId: user.id,
        action: "auth.sign_in_failed",
        targetType: "user",
        targetId: user.id,
        metadata: { email_hash: key, reason: "reauth_password" },
        ip: clientIp(c),
      });
      await countReauthFailure(c, user.id, user.email);
      throw new ApiError(400, "invalid_request", "Incorrect password");
    }

    const [account] = await db
      .select({ twoFactorEnabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    if (account?.twoFactorEnabled) {
      if (!code) {
        throw new ApiError(400, "invalid_request", "Enter a code from your authenticator app", [
          { field: "code", code: "required", message: "A TOTP or backup code is required" },
        ]);
      }
      const factor = await verifySecondFactor(db, c.env, user.id, code);
      if (!factor) {
        await recordAudit(db, {
          workspaceId: null,
          actorType: "user",
          actorId: user.id,
          action: "auth.two_factor_failed",
          targetType: "user",
          targetId: user.id,
          metadata: { reason: "invalid_code", during: "reauth" },
          ip: clientIp(c),
        });
        await countReauthFailure(c, user.id, user.email);
        throw new ApiError(400, "invalid_request", "Incorrect code", [
          { field: "code", code: "invalid", message: "The code is wrong or was already used" },
        ]);
      }
      if (factor.method === "backup_code") {
        await recordAudit(db, {
          workspaceId: null,
          actorType: "user",
          actorId: user.id,
          action: "auth.backup_code_used",
          targetType: "user",
          targetId: user.id,
          metadata: { remaining: factor.backupCodesRemaining },
          ip: clientIp(c),
        });
      }
    }

    const now = Date.now();
    await db.batch([
      db
        .update(sessions)
        .set({ reauthenticatedAt: new Date(now) })
        .where(eq(sessions.id, sessionId)),
      auditInsert(db, {
        workspaceId: null,
        actorType: "user",
        actorId: user.id,
        action: "auth.reauthenticated",
        targetType: "session",
        targetId: sessionId,
        ip: clientIp(c),
      }),
    ]);
    await clearLoginFailures(db, key);
    return c.json({ fresh_until: now + REAUTH_WINDOW_MS }, 200);
  })
  .openapi(listSessions, async (c) => {
    const { user, sessionId } = await requireSession(c);
    const rows = await c
      .get("db")
      .select({
        id: sessions.id,
        ipAddress: sessions.ipAddress,
        userAgent: sessions.userAgent,
        createdAt: sessions.createdAt,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .where(and(eq(sessions.userId, user.id), gt(sessions.expiresAt, new Date())))
      .orderBy(desc(sessions.createdAt));
    return c.json(
      {
        sessions: rows.map((s) => ({
          id: s.id,
          current: s.id === sessionId,
          ip_address: s.ipAddress,
          user_agent: s.userAgent,
          created_at: +s.createdAt,
          expires_at: +s.expiresAt,
        })),
      },
      200,
    );
  })
  .openapi(revokeSession, async (c) => {
    const { user, sessionId } = await requireSession(c);
    const { sessionId: target } = c.req.valid("param");
    const db = c.get("db");
    const deleted = await db
      .delete(sessions)
      .where(and(eq(sessions.id, target), eq(sessions.userId, user.id)))
      .returning({ id: sessions.id });
    if (deleted.length === 0) throw notFound("Session");
    await recordAudit(db, {
      workspaceId: null,
      actorType: "user",
      actorId: user.id,
      action: "auth.session_revoked",
      targetType: "session",
      targetId: target,
      metadata: { scope: "one", current: target === sessionId },
      ip: clientIp(c),
    });
    await revalidateShellSessions(c.env, { authSessionIds: [target] });
    return c.body(null, 204);
  })
  .openapi(revokeOtherSessions, async (c) => {
    const { user, sessionId } = await requireSession(c);
    const db = c.get("db");
    const deleted = await db
      .delete(sessions)
      .where(and(eq(sessions.userId, user.id), ne(sessions.id, sessionId)))
      .returning({ id: sessions.id });
    if (deleted.length > 0) {
      await recordAudit(db, {
        workspaceId: null,
        actorType: "user",
        actorId: user.id,
        action: "auth.session_revoked",
        targetType: "user",
        targetId: user.id,
        metadata: { scope: "others", count: deleted.length },
        ip: clientIp(c),
      });
      await revalidateShellSessions(c.env, { authSessionIds: deleted.map((d) => d.id) });
    }
    return c.json({ revoked: deleted.length }, 200);
  })
  .openapi(clearSignInLockout, async (c) => {
    const admin = await requireInstanceAction(c, "instance:manage");
    const { email } = c.req.valid("json");
    const db = c.get("db");
    const key = await loginKey(email);
    const cleared = await clearLoginFailures(db, key);
    if (cleared) {
      const [target] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email.trim().toLowerCase()))
        .limit(1);
      await recordAudit(db, {
        workspaceId: null,
        actorType: "user",
        actorId: admin.id,
        action: "auth.account_unlocked",
        targetType: target ? "user" : undefined,
        targetId: target?.id,
        metadata: { email_hash: key },
        ip: clientIp(c),
      });
    }
    return c.json({ cleared }, 200);
  })
  .openapi(resetUserTwoFactor, async (c) => {
    const admin = await requireInstanceAction(c, "instance:manage");
    const { userId } = c.req.valid("param");
    if (userId === admin.id) {
      throw new ApiError(
        403,
        "forbidden",
        "Turn off your own two-factor authentication under Settings → Security",
      );
    }
    const db = c.get("db");
    const [target] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!target) throw notFound("User");
    const principal = await requirePrincipal(c);
    await db.batch([
      db.update(users).set({ twoFactorEnabled: false }).where(eq(users.id, userId)),
      db.delete(twoFactors).where(eq(twoFactors.userId, userId)),
      // SECURITY: Whoever lost the device may not be the only one holding
      // the account; resetting the factor also ends every session.
      db.delete(sessions).where(eq(sessions.userId, userId)),
      auditInsert(db, {
        workspaceId: null,
        ...actorOf(principal),
        action: "auth.two_factor_reset",
        targetType: "user",
        targetId: userId,
        ip: clientIp(c),
      }),
    ]);
    await revalidateShellSessions(c.env, { userIds: [userId] });
    return c.body(null, 204);
  });
