/**
 * The API's error vocabulary: stable machine-readable codes, the exception
 * handlers throw, and the JSON body every non-2xx response carries.
 *
 * @module
 */
import type { SecurityErrorCode } from "@roundhouse/shared";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Machine-readable error codes returned in `{ error: { code } }`. The ADR
 * 0014 codes live in `@roundhouse/shared` so the dashboard and CLI share them.
 */
export type ErrorCode =
  | SecurityErrorCode
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "already_setup"
  | "setup_incomplete"
  | "master_key_missing"
  | "public_origin_missing"
  | "invalid_token"
  | "account_exists"
  | "email_mismatch"
  | "last_owner"
  | "upgrade_required"
  | "payload_too_large"
  | "rate_limited"
  | "invalid_reference"
  | "invalid_signature"
  | "github_not_configured"
  | "installation_not_in_workspace"
  | "repository_not_in_installation"
  | "upstream_error"
  | "provider_not_connected"
  | "provider_token_invalid"
  | "provider_read_only"
  | "domain_taken"
  | "hostname_not_allowed"
  | "invalid_hsts"
  | "preload_confirmation_required"
  | "cloudflare_dns_invalid"
  | "acme_mode_single_ingress_only"
  | "managed_tls_unavailable"
  | "mesh_supernet_locked"
  | "mesh_not_joined"
  | "mesh_rotation_in_progress"
  | "mcp_disabled"
  | "change_set_changed"
  | "change_set_conflict"
  | "change_set_rejected"
  | "approval_required"
  | "self_review"
  | "invalid_references"
  | "backup_storage_not_configured"
  | "backup_storage_unreachable"
  | "restore_mode_unsupported"
  | "volume_requires_single_replica"
  | "volume_shrink_unsupported"
  | "migration_target_ineligible"
  | "tcp_proxy_ports_exhausted"
  | "tcp_proxy_unsupported"
  | "agent_outdated"
  | "credential_rotation_failed"
  | "node_offline"
  | "query_timeout"
  | "invalid_schedule"
  | "cron_schedule_required"
  | "cron_has_no_endpoint"
  | "run_in_progress"
  | "registry_requires_s3"
  | "registry_storage_unreachable"
  | "drain_in_progress"
  | "node_not_drainable"
  | "node_not_draining"
  | "saas_requires_mesh"
  | "saas_requires_managed_tls"
  | "saas_in_use"
  | "cloudflare_saas_invalid"
  | "cloudflare_unavailable"
  | "wildcard_requires_enterprise"
  | "build_node_selector_required"
  | "head_moved"
  | "provider_ineligible"
  | "cloudflare_account_invalid"
  | "internal";

/**
 * One problem inside a request, for errors that report several at once (e.g.
 * every malformed `${{…}}` reference in a variables update).
 */
export interface ErrorDetail {
  /** Where the problem is: a variable key, a body path, … */
  field: string;
  code: string;
  message: string;
  /** Span within the field's value, in UTF-16 code units. */
  start?: number;
  end?: number;
}

/**
 * An error that maps directly onto an HTTP response. Throw it from any
 * handler; the app's error handler serialises it.
 */
export class ApiError extends Error {
  /**
   * @param status - HTTP status to respond with.
   * @param code - Stable machine-readable code.
   * @param message - Human-readable explanation, safe to show to the caller.
   * @param details - Per-field problems, when there are several.
   */
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
    readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Wire shape of every error response. */
export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: ErrorDetail[] };
}

/**
 * Builds the JSON body for an error response.
 *
 * @param code - Error code.
 * @param message - Human-readable message.
 * @param details - Optional per-field problems.
 * @returns The serialisable body.
 */
export function errorBody(code: ErrorCode, message: string, details?: ErrorDetail[]): ErrorBody {
  return { error: details ? { code, message, details } : { code, message } };
}

/**
 * Builds a 404 that doesn't reveal whether the resource exists in another
 * workspace.
 *
 * @param what - Resource name for the message, e.g. `"Member"`.
 * @returns An {@link ApiError} to throw.
 */
export const notFound = (what = "Resource") => new ApiError(404, "not_found", `${what} not found`);

/**
 * Builds a 409 for a state or uniqueness conflict.
 *
 * @param message - What conflicts.
 * @returns An {@link ApiError} to throw.
 */
export const conflict = (message: string) => new ApiError(409, "conflict", message);

const STATUS_CODES: Partial<Record<number, ErrorCode>> = {
  400: "invalid_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  426: "upgrade_required",
  429: "rate_limited",
};

/**
 * The error code for a bare HTTP status, used when middleware or the framework
 * throws an `HTTPException` rather than an {@link ApiError}.
 *
 * @param status - HTTP status of the failed response.
 * @returns The matching code; other 4xx map to `invalid_request` and 5xx to `internal`.
 */
export function errorCodeForStatus(status: number): ErrorCode {
  return STATUS_CODES[status] ?? (status >= 500 ? "internal" : "invalid_request");
}

/**
 * Whether a D1 error is a UNIQUE violation on `column` (e.g. `projects.slug`).
 * D1 wraps the SQLite message in one or more `cause`s.
 *
 * @param err - Anything thrown by a query.
 * @param column - `table.column` as SQLite names it.
 * @returns `true` for a matching violation.
 */
export function isUniqueViolation(err: unknown, column: string): boolean {
  for (let e = err; e instanceof Error; e = e.cause) {
    if (e.message.includes("UNIQUE constraint failed") && e.message.includes(column)) return true;
  }
  return false;
}
