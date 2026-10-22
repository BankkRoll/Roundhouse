/**
 * Typed errors for the Hetzner client and the provisioning flow.
 *
 * - {@link HetznerApiError}: the API answered with an error object; `code` is
 *   Hetzner's machine-readable code.
 * - {@link HetznerTimeoutError} / {@link HetznerNetworkError}: no usable
 *   answer arrived.
 * - {@link HetznerActionError}: an asynchronous action finished in `error`.
 * - {@link ProvisionError}: a provisioning step failed or was refused.
 *
 * @module
 */

/**
 * Error codes documented in the "Errors" section of the Hetzner Cloud API
 * reference, plus the operation-specific codes this package handles.
 */
export const HETZNER_ERROR_CODES = [
  "json_error",
  "unauthorized",
  "forbidden",
  "maintenance",
  "resource_limit_exceeded",
  "not_found",
  "method_not_allowed",
  "uniqueness_error",
  "conflict",
  "deprecated_api_endpoint",
  "resource_unavailable",
  "invalid_input",
  "service_error",
  "unsupported_error",
  "locked",
  "protected",
  "rate_limit_exceeded",
  "server_error",
  "bad_gateway",
  "unavailable",
  "timeout",
  "placement_error",
  "firewall_already_applied",
  "firewall_resource_not_found",
  "server_already_added",
] as const;

/** A documented Hetzner error code. Unknown codes are passed through as strings. */
export type HetznerErrorCode = (typeof HETZNER_ERROR_CODES)[number];

/** One field-level problem from an `invalid_input` error. */
export interface HetznerFieldError {
  /** Request field name. */
  name: string;
  /** Human-readable problems with the field. */
  messages: string[];
}

/** Base class for every error this package throws. */
export class HetznerError extends Error {
  override name = "HetznerError";
}

/**
 * The Hetzner API returned an error response.
 *
 * @example
 * try {
 *   await client.createServer(body);
 * } catch (e) {
 *   if (e instanceof HetznerApiError && e.code === "resource_limit_exceeded") {
 *     // tell the user to raise their project limit
 *   }
 * }
 */
export class HetznerApiError extends HetznerError {
  override name = "HetznerApiError";

  /**
   * @param status - HTTP status.
   * @param code - Hetzner error code, or `http_<status>` if the body had none.
   * @param message - Hetzner's message.
   * @param details - Code-specific details object, if any.
   */
  constructor(
    readonly status: number,
    readonly code: HetznerErrorCode | (string & {}),
    message: string,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(`Hetzner API ${status} ${code}: ${message}`);
  }

  /** Field problems for `invalid_input` and `uniqueness_error`; empty otherwise. */
  get fields(): HetznerFieldError[] {
    const fields = this.details?.fields;
    if (!Array.isArray(fields)) return [];
    return fields.map((f: { name?: unknown; messages?: unknown }) => ({
      name: String(f?.name ?? ""),
      messages: Array.isArray(f?.messages) ? f.messages.map(String) : [],
    }));
  }

  /** `true` when the token is missing, malformed, or revoked. */
  get isUnauthorized(): boolean {
    return this.status === 401 || this.code === "unauthorized";
  }

  /** `true` when the token lacks permission, e.g. a read-only token on a write. */
  get isForbidden(): boolean {
    return this.code === "forbidden";
  }

  /** `true` for `not_found`. */
  get isNotFound(): boolean {
    return this.status === 404 || this.code === "not_found";
  }

  /**
   * `true` when Hetzner rejected the request without acting on it and says a
   * retry may succeed (rate limit or a concurrent change).
   */
  get isRejectedRetryable(): boolean {
    return this.isRateLimited || this.code === "conflict";
  }

  /** `true` for `429`, whether or not the body carried a code. */
  get isRateLimited(): boolean {
    return this.status === 429 || this.code === "rate_limit_exceeded";
  }

  /**
   * `true` for gateway failures where the request may or may not have been
   * processed. Only idempotent requests are retried on these.
   */
  get isAmbiguousTransient(): boolean {
    return (
      this.code === "bad_gateway" ||
      this.code === "timeout" ||
      this.status === 502 ||
      this.status === 504
    );
  }
}

/** A request did not complete within the client's timeout. */
export class HetznerTimeoutError extends HetznerError {
  override name = "HetznerTimeoutError";

  /**
   * @param method - HTTP method.
   * @param path - API path.
   * @param timeoutMs - Timeout that elapsed.
   */
  constructor(
    readonly method: string,
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(`Hetzner API ${method} ${path} timed out after ${timeoutMs} ms`);
  }
}

/** `fetch` itself failed (DNS, connection reset, TLS). */
export class HetznerNetworkError extends HetznerError {
  override name = "HetznerNetworkError";

  /**
   * @param method - HTTP method.
   * @param path - API path.
   * @param cause - The underlying error.
   */
  constructor(
    readonly method: string,
    readonly path: string,
    cause: unknown,
  ) {
    super(`Hetzner API ${method} ${path} failed: ${errorMessage(cause)}`, { cause });
  }
}

/** An asynchronous action ended in `error`, or did not finish in time. */
export class HetznerActionError extends HetznerError {
  override name = "HetznerActionError";

  /**
   * @param actionId - The action's ID.
   * @param command - The action's command, e.g. `create_server`.
   * @param code - Hetzner's action error code, or `action_timeout`.
   * @param message - Hetzner's action error message.
   */
  constructor(
    readonly actionId: number,
    readonly command: string,
    readonly code: string,
    message: string,
  ) {
    super(`Hetzner action ${actionId} (${command}) failed: ${code}: ${message}`);
  }
}

/** Reasons {@link ProvisionError} is thrown. */
export type ProvisionErrorReason =
  /** The token was rejected by Hetzner. */
  | "token_invalid"
  /** The token can read but not write. */
  | "token_read_only"
  /** An input failed validation before any API call. */
  | "invalid_input"
  /** The server type is unknown, deprecated, or sold out in the location. */
  | "server_type_unavailable"
  /** No supported image matches the server type's architecture. */
  | "image_unavailable"
  /** A server with this name exists but is not managed by us. */
  | "name_taken"
  /** A managed server with this name is being deleted; retry later. */
  | "server_deleting"
  /** A step after server creation failed; the server was deleted. */
  | "failed_cleaned_up"
  /** A step after server creation failed and deleting the server also failed. */
  | "failed_cleanup_failed"
  /** Refused to delete a server that lacks the managed label. */
  | "not_managed";

/**
 * A provisioning step failed or was refused. `cause` holds the underlying
 * error when there is one.
 */
export class ProvisionError extends HetznerError {
  override name = "ProvisionError";

  /**
   * @param reason - Machine-readable reason.
   * @param message - Human-readable description.
   * @param options - `cause`, and `serverId` when a server is involved.
   */
  constructor(
    readonly reason: ProvisionErrorReason,
    message: string,
    options: { cause?: unknown; serverId?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.serverId = options.serverId ?? null;
  }

  /**
   * The server involved. For `failed_cleanup_failed` this server may still
   * exist and bill; the caller must record it and retry deprovisioning.
   */
  readonly serverId: number | null;
}

/**
 * Extracts a printable message from any thrown value.
 *
 * @param e - Thrown value.
 * @returns Its message, or its string form.
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
