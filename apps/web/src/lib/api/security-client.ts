/**
 * Typed endpoint functions for the ADR 0014 routes the dashboard calls: claiming and
 * releasing GitHub installations, the instance audit log and its chain verification,
 * re-authentication, the caller's two-factor and sessions (including Better Auth's
 * `/api/auth/two-factor/*` endpoints), and the instance admin's recovery tools. Every
 * call goes through {@link request}, like `api`.
 *
 * SECURITY: Passwords, codes, TOTP URIs and backup codes pass through these functions
 * only; callers keep them in component state and never in the query cache.
 *
 * @module
 */
import { request } from "./client";
import type {
  AccountSession,
  AuditChainVerification,
  GithubClaimStarted,
  InstanceAuditPage,
  InstanceAuditQuery,
  ReauthResult,
  SecurityStatus,
  TwoFactorEnrollment,
} from "./security-types";

const seg = encodeURIComponent;

/**
 * Security endpoints.
 *
 * @example
 * const { install_url } = await securityApi.startGithubClaim("ws_123");
 */
export const securityApi = {
  /**
   * Starts claiming a GitHub installation for a workspace (single use, 10 minutes).
   *
   * @param workspaceId - Workspace the installation will belong to.
   * @returns The App's install URL carrying the claim.
   */
  startGithubClaim: (workspaceId: string) =>
    request<GithubClaimStarted>("POST", "/v1/github/claims", {
      body: { workspace_id: workspaceId },
    }),
  /**
   * Releases an installation from a workspace. Needs a fresh session.
   *
   * @param workspaceId - Workspace that holds the claim.
   * @param installationId - Our `ghi_…` ID.
   * @returns Resolves once released.
   */
  releaseGithubInstallation: (workspaceId: string, installationId: string) =>
    request<void>("DELETE", `/v1/github/installations/${seg(installationId)}`, {
      query: { workspace_id: workspaceId },
    }),
  /**
   * Lists instance-level audit entries, newest first. Instance admins only.
   *
   * @param query - Filters, cursor and page size.
   * @param signal - Abort signal.
   * @returns One page.
   */
  listInstanceAuditLogs: (query: InstanceAuditQuery, signal?: AbortSignal) =>
    request<InstanceAuditPage>("GET", "/v1/instance/audit-logs", {
      query: query as Record<string, string | number | undefined>,
      signal,
    }),
  /**
   * Seals pending entries and verifies the whole audit chain. Instance admins only.
   *
   * @returns The verification report.
   */
  verifyAuditChain: () => request<AuditChainVerification>("GET", "/v1/instance/audit-logs/verify"),
  /**
   * Confirms the password (and a second-factor code when enrolled) so the session is
   * fresh for dangerous actions.
   *
   * @param password - The account password.
   * @param code - TOTP or backup code, when 2FA is on.
   * @returns Until when the session is fresh.
   */
  reauthenticate: (password: string, code?: string) =>
    request<ReauthResult>("POST", "/v1/auth/reauth", {
      body: code ? { password, code } : { password },
    }),
  /**
   * Reads the caller's two-factor and freshness state.
   *
   * @param signal - Abort signal.
   * @returns The security status.
   */
  getStatus: (signal?: AbortSignal) =>
    request<SecurityStatus>("GET", "/v1/auth/security", { signal }),
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
