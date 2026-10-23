/**
 * Wire types for the ADR 0014 routes the dashboard calls (GitHub installation claims,
 * the instance audit log and its chain verification, re-authentication, two-factor and
 * sessions), derived from the API's route definitions so the dashboard cannot drift
 * from them. Better Auth's two-factor responses are typed by hand.
 *
 * Type-only: nothing from the API source reaches the bundle.
 *
 * @module
 */
import type {
  getSecurityStatus,
  listInstanceAuditLogs,
  listSessions,
  QueryOf,
  ResponseOf,
  reauthenticate,
  startGithubClaim,
  verifyAuditChain,
} from "../../../../api/src/contracts";

/** `POST /v1/github/claims` response: where to send the browser to install the App. */
export type GithubClaimStarted = ResponseOf<typeof startGithubClaim, 200>;
/** A page of the instance audit log, newest first. */
export type InstanceAuditPage = ResponseOf<typeof listInstanceAuditLogs, 200>;
/** One instance-level audit entry with its chain fields. */
export type InstanceAuditEntry = InstanceAuditPage["entries"][number];
/** Filters and paging of the instance audit log. */
export type InstanceAuditQuery = QueryOf<typeof listInstanceAuditLogs>;
/** Result of verifying the audit chain. */
export type AuditChainVerification = ResponseOf<typeof verifyAuditChain, 200>;
/** `POST /v1/auth/reauth` response. */
export type ReauthResult = ResponseOf<typeof reauthenticate, 200>;

/** `GET /v1/auth/security`: two-factor state and session freshness. */
export type SecurityStatus = ResponseOf<typeof getSecurityStatus, 200>;
/** One of the caller's sessions (`GET /v1/auth/sessions`). Never carries its token. */
export type AccountSession = ResponseOf<typeof listSessions, 200>["sessions"][number];

/** `POST /api/auth/two-factor/enable` response: shown once, never stored by the dashboard. */
export interface TwoFactorEnrollment {
  /** `otpauth://totp/…` URI for the authenticator app (rendered as a QR code locally). */
  totpURI: string;
  /** Ten single-use backup codes in plain text; the server keeps only hashes. */
  backupCodes: string[];
}
