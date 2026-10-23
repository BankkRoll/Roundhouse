/**
 * Typed endpoint functions for the ADR 0014 routes the dashboard calls: claiming and
 * releasing GitHub installations, the instance audit log and its chain verification,
 * and re-authentication. Every call goes through {@link request}, like `api`.
 *
 * @module
 */
import { request } from "./client";
import type {
  AuditChainVerification,
  GithubClaimStarted,
  InstanceAuditPage,
  InstanceAuditQuery,
  ReauthResult,
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
};
