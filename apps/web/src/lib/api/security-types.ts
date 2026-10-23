/**
 * Wire types for the ADR 0014 routes the dashboard calls (GitHub installation claims,
 * the instance audit log and its chain verification, re-authentication), derived from
 * the API's route definitions so the dashboard cannot drift from them.
 *
 * Type-only: nothing from the API source reaches the bundle.
 *
 * @module
 */
import type {
  listInstanceAuditLogs,
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
