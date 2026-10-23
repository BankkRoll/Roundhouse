/**
 * Sign-in hardening shared by the API (which enforces it) and the dashboard
 * (which explains it): per-account lockout after repeated failures, the
 * re-authentication window for dangerous actions, and the security error
 * codes both sides switch on. See ADR 0014.
 *
 * @module
 */

/** Failed sign-ins allowed before an account starts locking. */
export const LOGIN_FREE_ATTEMPTS = 5;

/** First lockout, after {@link LOGIN_FREE_ATTEMPTS} failures. Doubles with each further failure. */
export const LOGIN_LOCKOUT_BASE_MS = 30_000;

/** Longest single lockout. */
export const LOGIN_LOCKOUT_MAX_MS = 60 * 60 * 1000;

/** Failures older than this are forgotten, so a typo a week ago doesn't count. */
export const LOGIN_FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How long after a failed sign-in an account stays locked.
 *
 * Exponential backoff: no lock for the first {@link LOGIN_FREE_ATTEMPTS}
 * failures, then 30 s, 1 min, 2 min, … capped at one hour.
 *
 * @param failures - Consecutive failures within the window, counting the one just recorded.
 * @returns Lock duration in ms; 0 when not locked.
 * @example
 * loginLockoutMs(5); // 30_000
 * loginLockoutMs(7); // 120_000
 */
export function loginLockoutMs(failures: number): number {
  if (failures < LOGIN_FREE_ATTEMPTS) return 0;
  const exponent = Math.min(failures - LOGIN_FREE_ATTEMPTS, 30);
  return Math.min(LOGIN_LOCKOUT_BASE_MS * 2 ** exponent, LOGIN_LOCKOUT_MAX_MS);
}

/** Stored lockout state of one account (one `login_attempts` row). */
export interface LoginAttemptState {
  failures: number;
  /** Unix ms of the last failure. */
  lastFailureAt: number;
  /** Unix ms until which sign-in is refused; `null` when not locked. */
  lockedUntil: number | null;
}

/**
 * State after recording one more failed sign-in.
 *
 * @param prior - Current state, or `null` when the account has none.
 * @param now - Unix ms.
 * @returns The state to store.
 */
export function recordLoginFailure(
  prior: LoginAttemptState | null,
  now: number,
): LoginAttemptState {
  const recent = prior && now - prior.lastFailureAt <= LOGIN_FAILURE_WINDOW_MS;
  const failures = (recent ? prior.failures : 0) + 1;
  const lock = loginLockoutMs(failures);
  return { failures, lastFailureAt: now, lockedUntil: lock ? now + lock : null };
}

/**
 * Whether a sign-in attempt must be refused without checking the password.
 *
 * @param state - Stored state, or `null`.
 * @param now - Unix ms.
 * @returns Ms until the lock lifts, or 0 when the attempt may proceed.
 */
export function loginLockedForMs(state: LoginAttemptState | null, now: number): number {
  if (!state?.lockedUntil) return 0;
  return Math.max(0, state.lockedUntil - now);
}

/**
 * How recently a session must have signed in or re-authenticated for a
 * dangerous action (rotating keys, deleting a workspace, changing access or
 * protection, adding nodes).
 */
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

/**
 * Whether a session is fresh enough for a dangerous action.
 *
 * @param authenticatedAt - Unix ms of sign-in or the last re-authentication.
 * @param now - Unix ms.
 * @returns `true` within {@link REAUTH_WINDOW_MS}.
 */
export function isFreshSession(authenticatedAt: number, now: number): boolean {
  return now - authenticatedAt <= REAUTH_WINDOW_MS && authenticatedAt <= now;
}

/**
 * Error codes introduced by the security hardening, returned in
 * `{ error: { code } }`. The dashboard and CLI switch on them:
 * - `two_factor_required`: enroll a second factor before any mutation;
 * - `reauth_required`: re-enter credentials, then retry;
 * - `account_locked`: too many failed sign-ins; `retry-after` says when;
 * - `confirmation_required`: the write makes variables write-only;
 *   resend with `confirm_write_only: true` (details list the keys);
 * - `public_prefix_secret_value`: a public variable looks like a credential;
 *   resend with the key in `acknowledge_public`;
 * - `tier_locked`: the requested tier contradicts a locked classification;
 * - `value_required`: making a secret plain needs the value re-entered;
 * - `build_arg_secret`: a build arg is or references a secret; use a
 *   BuildKit secret mount instead;
 * - `installation_not_in_workspace`: a GitHub installation isn't claimed by
 *   this workspace;
 * - `repository_not_in_installation`: the repository isn't accessible
 *   through the chosen installation;
 * - `node_encryption_key_missing`: the node can't receive sealed variables
 *   until its agent registers an encryption key;
 * - `host_conflict`: a hostname and path prefix is already routed by another project.
 */
export const SECURITY_ERROR_CODES = [
  "two_factor_required",
  "reauth_required",
  "account_locked",
  "confirmation_required",
  "public_prefix_secret_value",
  "tier_locked",
  "value_required",
  "build_arg_secret",
  "installation_not_in_workspace",
  "repository_not_in_installation",
  "node_encryption_key_missing",
  "host_conflict",
] as const;

/** A security error code; see {@link SECURITY_ERROR_CODES}. */
export type SecurityErrorCode = (typeof SECURITY_ERROR_CODES)[number];
