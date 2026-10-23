/**
 * Typed endpoint functions for account security: the `/v1/auth/*` routes and Better
 * Auth's `/api/auth/two-factor/*` endpoints, plus the instance admin's recovery tools.
 * Every call goes through {@link request}, like `api`.
 *
 * SECURITY: Passwords, codes, TOTP URIs and backup codes pass through these functions
 * only; callers keep them in component state and never in the query cache.
 *
 * @module
 */
import { request } from "./client";
import type {
  AccountSession,
  ReauthRequest,
  SecurityStatus,
  TwoFactorEnrollment,
} from "./security-types";

const seg = encodeURIComponent;

/**
 * Account security endpoints.
 *
 * @example
 * const { totpURI, backupCodes } = await securityApi.enableTwoFactor(password);
 */
export const securityApi = {
  /**
   * Reads the caller's two-factor and freshness state.
   *
   * @param signal - Abort signal.
   * @returns The security status.
   */
  getStatus: (signal?: AbortSignal) =>
    request<SecurityStatus>("GET", "/v1/auth/security", { signal }),
  /**
   * Re-enters the password (and a code while two-factor is on) so dangerous actions are
   * allowed for the next few minutes.
   *
   * @param body - Password and code.
   * @returns Until when the session is fresh.
   */
  reauthenticate: (body: ReauthRequest) =>
    request<{ fresh_until: number }>("POST", "/v1/auth/reauth", { body }),
  /**
   * Lists the caller's live sessions, newest first.
   *
   * @param signal - Abort signal.
   * @returns The sessions envelope.
   */
  listSessions: (signal?: AbortSignal) =>
    request<{ sessions: AccountSession[] }>("GET", "/v1/auth/sessions", { signal }),
  /**
   * Ends one session; that device is signed out on its next request.
   *
   * @param sessionId - Session id.
   */
  revokeSession: (sessionId: string) =>
    request<void>("DELETE", `/v1/auth/sessions/${seg(sessionId)}`),
  /**
   * Ends every session except this one.
   *
   * @returns How many were ended.
   */
  revokeOtherSessions: () => request<{ revoked: number }>("DELETE", "/v1/auth/sessions"),

  /**
   * Starts enrollment: a new secret and backup codes. Two-factor turns on only after
   * {@link securityApi.verifyTotp} accepts a code from the app.
   *
   * @param password - The account password.
   * @returns The TOTP URI and the backup codes.
   */
  enableTwoFactor: (password: string) =>
    request<TwoFactorEnrollment>("POST", "/api/auth/two-factor/enable", { body: { password } }),
  /**
   * Checks an authenticator code: finishes enrollment when signed in, or the second step
   * of a sign-in (which then sets the session cookie).
   *
   * @param code - Six digits from the app.
   * @returns Resolves once accepted.
   */
  verifyTotp: (code: string) =>
    request<unknown>("POST", "/api/auth/two-factor/verify-totp", { body: { code } }),
  /**
   * Signs in with a backup code instead of the app; each code works once.
   *
   * @param code - A backup code, with or without its dash.
   * @returns Resolves once accepted.
   */
  verifyBackupCode: (code: string) =>
    request<unknown>("POST", "/api/auth/two-factor/verify-backup-code", { body: { code } }),
  /**
   * Turns two-factor off.
   *
   * @param password - The account password.
   * @param code - A current authenticator or backup code.
   * @returns Resolves once off.
   */
  disableTwoFactor: (password: string, code: string) =>
    request<{ status: boolean }>("POST", "/api/auth/two-factor/disable", {
      body: { password, code },
    }),
  /**
   * Replaces every backup code with ten new ones.
   *
   * @param password - The account password.
   * @param code - A current authenticator or backup code.
   * @returns The new codes, shown once.
   */
  regenerateBackupCodes: (password: string, code: string) =>
    request<{ backupCodes: string[] }>("POST", "/api/auth/two-factor/generate-backup-codes", {
      body: { password, code },
    }),

  /**
   * Instance admins: lifts the sign-in lockout of an email address early.
   *
   * @param email - The locked address.
   * @returns Whether there was anything to clear.
   */
  clearSignInLockout: (email: string) =>
    request<{ cleared: boolean }>("POST", "/v1/instance/sign-in-lockouts/clear", {
      body: { email },
    }),
  /**
   * Instance admins: turns off another user's two-factor (lost device) and signs them out
   * everywhere. Needs a recent sign-in.
   *
   * @param userId - The user.
   */
  resetUserTwoFactor: (userId: string) =>
    request<void>("DELETE", `/v1/instance/users/${seg(userId)}/two-factor`),
};
