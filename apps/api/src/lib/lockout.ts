/**
 * Per-account sign-in lockout (ADR 0014 "Auth"), stored in D1's
 * `login_attempts`. The policy (5 free failures in 24 h, then 30 s doubling
 * to 1 h) is `loginLockoutMs` in `@roundhouse/shared`; this module keeps the
 * counters.
 *
 * Rows are keyed by {@link loginKey}, a hash of the normalised email, so an
 * unknown address locks exactly like a real one (no account enumeration)
 * and the table holds no addresses. Password sign-in, second-factor
 * verification, `POST /v1/auth/reauth` and Better Auth's password-checking
 * endpoints share one counter per account. The per-IP `AUTH_LIMITER` sits in
 * front of all of them.
 *
 * @module
 */
import { type Db, loginAttempts } from "@roundhouse/db";
import { LOGIN_FAILURE_WINDOW_MS, loginLockoutMs } from "@roundhouse/shared";
import { eq, sql } from "drizzle-orm";
import { ApiError } from "./errors";

const encoder = new TextEncoder();

/**
 * The lockout key of an email address: lowercase hex SHA-256 of
 * `email.trim().toLowerCase()`. Also the `email_hash` in sign-in audit
 * entries, so an admin can match entries to an address they already know.
 *
 * @param email - The address as typed.
 * @returns 64 hex characters.
 */
export async function loginKey(email: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(email.trim().toLowerCase()));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * How long sign-in stays refused for an account.
 *
 * @param db - Database client.
 * @param key - {@link loginKey} of the account's email.
 * @param now - Unix ms.
 * @returns Ms until the lock lifts; 0 when sign-in may proceed.
 */
export async function lockedForMs(db: Db, key: string, now = Date.now()): Promise<number> {
  const [row] = await db
    .select({ lockedUntil: loginAttempts.lockedUntil })
    .from(loginAttempts)
    .where(eq(loginAttempts.id, key))
    .limit(1);
  return row?.lockedUntil ? Math.max(0, +row.lockedUntil - now) : 0;
}

/** Outcome of {@link recordLoginFailure}. */
export interface LoginFailure {
  /** Consecutive failures within the window, this one included. */
  failures: number;
  /** Ms the account is now locked for; 0 when it isn't. */
  lockedForMs: number;
}

/**
 * Counts one failed sign-in (or second factor, or re-authentication) and
 * locks the account once the free attempts are spent.
 *
 * The increment is one upsert, so concurrent failures can't lose a count.
 * A lock never shortens an existing one.
 *
 * @param db - Database client.
 * @param key - {@link loginKey} of the account's email.
 * @param now - Unix ms.
 * @returns The failure count and the resulting lock.
 */
export async function recordLoginFailure(
  db: Db,
  key: string,
  now = Date.now(),
): Promise<LoginFailure> {
  const at = new Date(now);
  const windowStart = now - LOGIN_FAILURE_WINDOW_MS;
  const [row] = await db
    .insert(loginAttempts)
    .values({ id: key, failures: 1, lastFailureAt: at, createdAt: at, updatedAt: at })
    .onConflictDoUpdate({
      target: loginAttempts.id,
      set: {
        failures: sql`CASE WHEN ${loginAttempts.lastFailureAt} >= ${windowStart} THEN ${loginAttempts.failures} + 1 ELSE 1 END`,
        lastFailureAt: at,
        updatedAt: at,
      },
    })
    .returning({ failures: loginAttempts.failures });
  const failures = row?.failures ?? 1;
  const lock = loginLockoutMs(failures);
  if (!lock) return { failures, lockedForMs: 0 };
  const until = now + lock;
  await db
    .update(loginAttempts)
    .set({
      lockedUntil: sql`MAX(COALESCE(${loginAttempts.lockedUntil}, 0), ${until})`,
    })
    .where(eq(loginAttempts.id, key));
  return { failures, lockedForMs: lock };
}

/**
 * Forgets an account's failures after a complete sign-in, or when an
 * instance admin unlocks it.
 *
 * @param db - Database client.
 * @param key - {@link loginKey} of the account's email.
 * @returns Whether a row existed (the account had failures or a lock).
 */
export async function clearLoginFailures(db: Db, key: string): Promise<boolean> {
  const deleted = await db
    .delete(loginAttempts)
    .where(eq(loginAttempts.id, key))
    .returning({ id: loginAttempts.id });
  return deleted.length > 0;
}

/**
 * The message a locked account gets. It says nothing about whether the
 * account exists.
 *
 * @param ms - Remaining lock.
 * @returns E.g. "Too many failed attempts. Try again in 2 minutes."
 */
export function lockedMessage(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  const wait =
    seconds < 60
      ? `${seconds} second${seconds === 1 ? "" : "s"}`
      : `${Math.ceil(seconds / 60)} minute${Math.ceil(seconds / 60) === 1 ? "" : "s"}`;
  return `Too many failed attempts. Try again in ${wait}.`;
}

/**
 * The `retry-after` value for a lock.
 *
 * @param ms - Remaining lock.
 * @returns Whole seconds, at least 1.
 */
export function retryAfterSeconds(ms: number): string {
  return String(Math.max(1, Math.ceil(ms / 1000)));
}

/**
 * The 429 a `/v1` route answers for a locked account; set `retry-after`
 * from {@link retryAfterSeconds} alongside it.
 *
 * @param ms - Remaining lock.
 * @returns An {@link ApiError} with code `account_locked`.
 */
export function accountLocked(ms: number): ApiError {
  return new ApiError(429, "account_locked", lockedMessage(ms));
}
