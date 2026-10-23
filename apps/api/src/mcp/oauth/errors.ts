/**
 * OAuth error responses (RFC 6749 section 5.2, RFC 8707, RFC 7009): the
 * `{ error, error_description }` body and status every OAuth endpoint uses,
 * as opposed to the REST API's `{ error: { code, message } }`.
 *
 * @module
 */

/** Error codes the authorization server returns. */
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "unsupported_response_type"
  | "invalid_scope"
  | "invalid_target"
  | "access_denied"
  | "temporarily_unavailable"
  | "server_error";

/** An OAuth refusal; endpoints turn it into the standard error body. */
export class OAuthFailure extends Error {
  /**
   * @param code - The OAuth error code.
   * @param description - Human-readable detail; never includes secrets.
   * @param status - HTTP status for direct (non-redirect) responses.
   */
  constructor(
    readonly code: OAuthErrorCode,
    readonly description: string,
    readonly status: 400 | 401 | 403 | 404 | 429 | 503 = code === "invalid_client" ? 401 : 400,
  ) {
    super(description);
    this.name = "OAuthFailure";
  }
}

/**
 * The JSON body for an OAuth error.
 *
 * @param failure - The refusal.
 * @returns `{ error, error_description }`.
 */
export function oauthErrorBody(failure: OAuthFailure) {
  return { error: failure.code, error_description: failure.description };
}
