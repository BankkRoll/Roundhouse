/**
 * The API's error vocabulary: stable machine-readable codes, the exception
 * handlers throw, and the JSON body every non-2xx response carries.
 *
 * @module
 */
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Machine-readable error codes returned in `{ error: { code } }`. */
export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "already_setup"
  | "setup_incomplete"
  | "master_key_missing"
  | "invalid_token"
  | "account_exists"
  | "email_mismatch"
  | "last_owner"
  | "upgrade_required"
  | "payload_too_large"
  | "rate_limited"
  | "internal";

/**
 * An error that maps directly onto an HTTP response. Throw it from any
 * handler; the app's error handler serialises it.
 */
export class ApiError extends Error {
  /**
   * @param status - HTTP status to respond with.
   * @param code - Stable machine-readable code.
   * @param message - Human-readable explanation, safe to show to the caller.
   */
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Wire shape of every error response. */
export interface ErrorBody {
  error: { code: ErrorCode; message: string };
}

/**
 * Builds the JSON body for an error response.
 *
 * @param code - Error code.
 * @param message - Human-readable message.
 * @returns The serialisable body.
 */
export function errorBody(code: ErrorCode, message: string): ErrorBody {
  return { error: { code, message } };
}

/**
 * Builds a 404 that doesn't reveal whether the resource exists in another
 * workspace.
 *
 * @param what - Resource name for the message, e.g. `"Member"`.
 * @returns An {@link ApiError} to throw.
 */
export const notFound = (what = "Resource") => new ApiError(404, "not_found", `${what} not found`);

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
