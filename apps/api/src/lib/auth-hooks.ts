/**
 * The control plane's Better Auth plugin (ADR 0014 "Auth"): lockout,
 * sign-in audit and two-factor hardening around Better Auth's own
 * endpoints.
 *
 * - **Lockout.** `/sign-in/email` is refused with 429 `account_locked`
 *   (and `retry-after`) before the password is checked while the account is
 *   locked; failed passwords and failed second factors count toward it, and
 *   a complete sign-in clears it. Endpoints that check the password of a
 *   signed-in user (two-factor changes, password change) share the counter.
 * - **Audit.** `auth.sign_in_succeeded`, `auth.sign_in_failed`,
 *   `auth.account_locked`, `auth.two_factor_*`, `auth.backup_code_used`,
 *   `auth.backup_codes_regenerated` and `auth.signed_out`, all instance-level.
 *   Never a password or a code.
 * - **Two-factor.** Trusted devices are never issued; a TOTP code's time step
 *   is usable once ({@link claimTotpStep}); backup codes are compared by hash
 *   (`backupCodeStorage`); turning 2FA off or regenerating backup codes
 *   needs a current code as well as the password.
 *
 * It is registered after Better Auth's `twoFactor` plugin, so its after
 * hooks see the final outcome (a sign-in that still awaits a second factor
 * has no `newSession`).
 *
 * @module
 */
import { type Db, twoFactors, users } from "@roundhouse/db";
import type { AuditAction } from "@roundhouse/shared";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { recordAudit } from "./audit";
import type { KeyEnv } from "./keyring";
import {
  clearLoginFailures,
  lockedForMs,
  lockedMessage,
  loginKey,
  recordLoginFailure,
  retryAfterSeconds,
} from "./lockout";
import {
  backupCodesRemaining,
  claimTotpStep,
  hashBackupCode,
  totpStepFor,
  verifySecondFactor,
} from "./two-factor";

/** What the hooks need from the request's environment. */
export interface SecurityHookDeps {
  db: Db;
  keys: KeyEnv;
}

type HookContext = Parameters<typeof getSessionFromCtx>[0];

const SIGN_IN = "/sign-in/email";
const SIGN_OUT = "/sign-out";
const VERIFY_TOTP = "/two-factor/verify-totp";
const VERIFY_BACKUP = "/two-factor/verify-backup-code";
const ENABLE = "/two-factor/enable";
const DISABLE = "/two-factor/disable";
const REGENERATE = "/two-factor/generate-backup-codes";
const CHANGE_PASSWORD = "/change-password";

/** Endpoints that check a signed-in user's password. */
const PASSWORD_CHECKS = new Set([ENABLE, DISABLE, REGENERATE, CHANGE_PASSWORD]);

/** Endpoints that also need a current second factor. */
const CODE_CHECKS = new Set([DISABLE, REGENERATE]);

const HOOKED = new Set([SIGN_IN, SIGN_OUT, VERIFY_TOTP, VERIFY_BACKUP, ...PASSWORD_CHECKS]);

// A string that can never equal a 6-digit code, so Better Auth's verifier
// rejects a replayed one through its normal failure path (attempt counters
// included).
const REPLAYED_CODE = "replayed";

/** What a before hook learned, for the after hook of the same request. */
interface Pending {
  userId: string;
  email: string;
  /** A sign-in challenge (no session yet), not a signed-in user. */
  signIn: boolean;
  /** The user had 2FA off, so a valid TOTP code turns it on. */
  enrolling: boolean;
  replayed: boolean;
}

const pending = new WeakMap<object, Pending>();

const slot = (ctx: HookContext): object => ctx.request ?? ctx.context;

function ipOf(ctx: HookContext): string | null {
  return (
    ctx.request?.headers.get("cf-connecting-ip") ?? ctx.headers?.get("cf-connecting-ip") ?? null
  );
}

function locked(ms: number): APIError {
  return new APIError(
    "TOO_MANY_REQUESTS",
    { code: "account_locked", message: lockedMessage(ms) },
    { "retry-after": retryAfterSeconds(ms) },
  );
}

async function audit(
  deps: SecurityHookDeps,
  ctx: HookContext,
  action: AuditAction,
  entry: { userId?: string | null; actor?: boolean; metadata?: Record<string, unknown> },
): Promise<void> {
  const actorId = entry.actor === false ? null : (entry.userId ?? null);
  await recordAudit(deps.db, {
    workspaceId: null,
    actorType: "user",
    actorId,
    action,
    targetType: entry.userId ? "user" : undefined,
    targetId: entry.userId ?? undefined,
    metadata: entry.metadata,
    ip: ipOf(ctx),
  });
}

async function userIdByEmail(db: Db, email: string): Promise<string | null> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Who a two-factor verification is for: the signed-in user (enrollment, or
 * a check while signed in), else the user of the pending sign-in challenge
 * named by Better Auth's signed `two_factor` cookie.
 */
async function verificationSubject(
  deps: SecurityHookDeps,
  ctx: HookContext,
): Promise<Omit<Pending, "replayed"> | null> {
  const session = await getSessionFromCtx(ctx);
  if (session) {
    return {
      userId: session.user.id,
      email: session.user.email,
      signIn: false,
      enrolling: !session.user.twoFactorEnabled,
    };
  }
  const cookie = ctx.context.createAuthCookie("two_factor");
  const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!identifier) return null;
  const challenge = await ctx.context.internalAdapter.findVerificationValue(identifier);
  if (!challenge || +new Date(challenge.expiresAt) <= Date.now()) return null;
  const [user] = await deps.db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, challenge.value))
    .limit(1);
  return user ? { userId: user.id, email: user.email, signIn: true, enrolling: false } : null;
}

async function refuseIfLocked(deps: SecurityHookDeps, email: string): Promise<void> {
  const ms = await lockedForMs(deps.db, await loginKey(email));
  if (ms) throw locked(ms);
}

async function countFailure(
  deps: SecurityHookDeps,
  ctx: HookContext,
  email: string,
  userId: string | null,
): Promise<void> {
  const key = await loginKey(email);
  const failure = await recordLoginFailure(deps.db, key);
  if (failure.lockedForMs) {
    await audit(deps, ctx, "auth.account_locked", {
      userId,
      actor: false,
      metadata: { email_hash: key, failures: failure.failures, locked_for_ms: failure.lockedForMs },
    });
  }
}

const isInvalidPassword = (value: unknown) =>
  isAPIError(value) && (value.body as { code?: string } | undefined)?.code === "INVALID_PASSWORD";

// -----------------------------------------------------------------------------
// Before
// -----------------------------------------------------------------------------

async function before(deps: SecurityHookDeps, ctx: HookContext) {
  const body = (ctx.body ?? {}) as Record<string, unknown>;

  if (ctx.path === SIGN_IN) {
    if (typeof body.email !== "string") return;
    const key = await loginKey(body.email);
    const ms = await lockedForMs(deps.db, key);
    if (ms) {
      await audit(deps, ctx, "auth.sign_in_failed", {
        userId: await userIdByEmail(deps.db, body.email),
        actor: false,
        metadata: { email_hash: key, reason: "account_locked" },
      });
      throw locked(ms);
    }
    return;
  }

  if (ctx.path === SIGN_OUT) {
    const session = await getSessionFromCtx(ctx);
    if (session) {
      pending.set(slot(ctx), {
        userId: session.user.id,
        email: session.user.email,
        signIn: false,
        enrolling: false,
        replayed: false,
      });
    }
    return;
  }

  if (ctx.path === VERIFY_TOTP || ctx.path === VERIFY_BACKUP) {
    const subject = await verificationSubject(deps, ctx);
    // SECURITY: Trusted devices would let a stolen browser skip the second
    // factor for 30 days; the dashboard never offers them (ADR 0014).
    const next: Record<string, unknown> = { ...body, trustDevice: false };
    if (!subject) return { context: { body: next } };
    if (subject.signIn) await refuseIfLocked(deps, subject.email);
    const code = typeof body.code === "string" ? body.code : "";
    let replayed = false;
    if (ctx.path === VERIFY_TOTP) {
      const step = await totpStepFor(deps.db, deps.keys, subject.userId, code);
      if (step !== null && !(await claimTotpStep(deps.db, subject.userId, step))) {
        next.code = REPLAYED_CODE;
        replayed = true;
      }
    } else {
      next.code = await hashBackupCode(code);
    }
    pending.set(slot(ctx), { ...subject, replayed });
    return { context: { body: next } };
  }

  if (PASSWORD_CHECKS.has(ctx.path)) {
    const session = await getSessionFromCtx(ctx);
    if (!session) return;
    const { id: userId, email } = session.user;
    await refuseIfLocked(deps, email);
    if (CODE_CHECKS.has(ctx.path)) {
      const code = typeof body.code === "string" ? body.code : "";
      if (!code) {
        throw new APIError("BAD_REQUEST", {
          code: "CODE_REQUIRED",
          message: "Enter a code from your authenticator app or a backup code",
        });
      }
      const factor = await verifySecondFactor(deps.db, deps.keys, userId, code);
      if (!factor) {
        await audit(deps, ctx, "auth.two_factor_failed", {
          userId,
          metadata: { reason: "invalid_code", during: ctx.path.slice("/two-factor/".length) },
        });
        await countFailure(deps, ctx, email, userId);
        throw new APIError("UNAUTHORIZED", { code: "INVALID_CODE", message: "Invalid code" });
      }
      if (factor.method === "backup_code") {
        await audit(deps, ctx, "auth.backup_code_used", {
          userId,
          metadata: { remaining: factor.backupCodesRemaining },
        });
      }
    }
    pending.set(slot(ctx), { userId, email, signIn: false, enrolling: false, replayed: false });
  }
}

// -----------------------------------------------------------------------------
// After
// -----------------------------------------------------------------------------

async function after(deps: SecurityHookDeps, ctx: HookContext) {
  const returned = (ctx.context as { returned?: unknown }).returned;
  const failed = isAPIError(returned);
  const body = (ctx.body ?? {}) as Record<string, unknown>;

  if (ctx.path === SIGN_IN) {
    if (typeof body.email !== "string") return;
    const email = body.email;
    if (failed) {
      if (returned.statusCode !== 401) return;
      const userId = await userIdByEmail(deps.db, email);
      await audit(deps, ctx, "auth.sign_in_failed", {
        userId,
        actor: false,
        metadata: { email_hash: await loginKey(email), reason: "invalid_credentials" },
      });
      await countFailure(deps, ctx, email, userId);
      return;
    }
    const session = ctx.context.newSession;
    // A null session here means the two-factor plugin turned the sign-in
    // into a challenge; it counts once the second factor checks out.
    if (!session) return;
    await clearLoginFailures(deps.db, await loginKey(email));
    await audit(deps, ctx, "auth.sign_in_succeeded", {
      userId: session.user.id,
      metadata: { method: "password" },
    });
    return;
  }

  const p = pending.get(slot(ctx));
  if (!p) return;
  pending.delete(slot(ctx));

  if (ctx.path === VERIFY_TOTP || ctx.path === VERIFY_BACKUP) {
    const method = ctx.path === VERIFY_TOTP ? "totp" : "backup_code";
    if (failed) {
      if (!p.signIn) return;
      await audit(deps, ctx, "auth.two_factor_failed", {
        userId: p.userId,
        actor: false,
        metadata: { method, reason: p.replayed ? "replayed" : "invalid_code" },
      });
      await countFailure(deps, ctx, p.email, p.userId);
      return;
    }
    if (method === "backup_code") {
      await audit(deps, ctx, "auth.backup_code_used", {
        userId: p.userId,
        metadata: { remaining: await backupCodesRemaining(deps.db, deps.keys, p.userId) },
      });
    }
    if (p.signIn) {
      await clearLoginFailures(deps.db, await loginKey(p.email));
      await audit(deps, ctx, "auth.sign_in_succeeded", { userId: p.userId, metadata: { method } });
    } else if (p.enrolling && method === "totp") {
      await audit(deps, ctx, "auth.two_factor_enabled", { userId: p.userId });
    }
    return;
  }

  if (ctx.path === SIGN_OUT) {
    if (!failed) await audit(deps, ctx, "auth.signed_out", { userId: p.userId });
    return;
  }

  if (PASSWORD_CHECKS.has(ctx.path)) {
    if (isInvalidPassword(returned)) {
      await countFailure(deps, ctx, p.email, p.userId);
      return;
    }
    if (failed) return;
    if (ctx.path === ENABLE) {
      // A new secret starts with no used steps; a stale claim from the old
      // one would refuse the first code of a quick re-enrollment.
      await deps.db
        .update(twoFactors)
        .set({ lastTotpStep: null })
        .where(eq(twoFactors.userId, p.userId));
    } else if (ctx.path === DISABLE) {
      await audit(deps, ctx, "auth.two_factor_disabled", { userId: p.userId });
    } else if (ctx.path === REGENERATE) {
      await audit(deps, ctx, "auth.backup_codes_regenerated", { userId: p.userId });
    }
  }
}

/**
 * Creates the plugin for one request's Better Auth instance.
 *
 * @param deps - The request's database client and keyring bindings.
 * @returns A Better Auth plugin; list it after `twoFactor(...)`.
 */
export function securityHooks(deps: SecurityHookDeps): BetterAuthPlugin {
  return {
    id: "roundhouse-security",
    hooks: {
      before: [
        {
          matcher: (ctx) => HOOKED.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => before(deps, ctx)),
        },
      ],
      after: [
        {
          matcher: (ctx) => HOOKED.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => after(deps, ctx)),
        },
      ],
    },
  };
}
