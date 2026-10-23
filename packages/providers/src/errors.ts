/**
 * Typed errors shared by every provider adapter.
 *
 * - {@link ProviderApiError}: the provider answered with an error. `code` is
 *   normalised across providers; `providerCode` keeps the provider's own.
 * - {@link ProviderTimeoutError} / {@link ProviderNetworkError}: no usable
 *   answer arrived.
 * - {@link ProviderActionError}: an asynchronous provider task failed or did
 *   not finish in time.
 * - {@link ProvisionError}: a provisioning step failed or was refused.
 *
 * Callers branch on `code` and `reason`, never on a provider's raw codes, so
 * the API and dashboard stay provider-neutral.
 *
 * @module
 */

/** Identifier of a supported cloud provider. */
export type ProviderId = "hetzner" | "digitalocean" | "vultr" | "linode";

/** Provider-neutral classification of an API error. */
export const API_ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "rate_limited",
  "not_found",
  "quota_exceeded",
  "invalid_input",
  "unavailable",
  "conflict",
  "unknown",
] as const;

/** A normalised API error code. */
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * When the HTTP core may resend a request that failed with this error.
 * - `always`: the provider rejected it without acting (rate limit, a
 *   transient lock), so even a create is safe to resend.
 * - `idempotent`: the request may or may not have been applied (gateway
 *   errors), so only idempotent methods are resent.
 * - `never`: retrying cannot help.
 */
export type RetryPolicy = "always" | "idempotent" | "never";

/** Base class for every error this package throws. */
export class ProviderError extends Error {
  override name = "ProviderError";
}

/** Fields for {@link ProviderApiError}. */
export interface ProviderApiErrorInit {
  /** Provider that answered. */
  provider: ProviderId;
  /** HTTP status. */
  status: number;
  /** Normalised code. */
  code: ApiErrorCode;
  /** The provider's own code, or `http_<status>` when the body had none. */
  providerCode: string;
  /** The provider's message. */
  message: string;
  /** Provider-specific details (field errors, limits), if any. */
  details?: unknown;
  /** Retry policy; defaults from `code` and `status`. */
  retry?: RetryPolicy;
  /** Seconds the provider asked to wait, from `Retry-After`. */
  retryAfterSeconds?: number | null;
}

/**
 * The default retry policy for a normalised code and status.
 *
 * @param code - Normalised code.
 * @param status - HTTP status.
 * @returns `always` for rate limits, `idempotent` for gateway errors, else `never`.
 */
export function defaultRetryPolicy(code: ApiErrorCode, status: number): RetryPolicy {
  if (code === "rate_limited" || status === 429) return "always";
  if (status === 502 || status === 503 || status === 504) return "idempotent";
  return "never";
}

/**
 * A provider API returned an error response.
 *
 * @example
 * try {
 *   await provider.provision(input);
 * } catch (e) {
 *   if (e instanceof ProviderApiError && e.code === "quota_exceeded") {
 *     // ask the user to raise their account limit
 *   }
 * }
 */
export class ProviderApiError extends ProviderError {
  override name = "ProviderApiError";
  /** Provider that answered. */
  readonly provider: ProviderId;
  /** HTTP status. */
  readonly status: number;
  /** Normalised code. */
  readonly code: ApiErrorCode;
  /** The provider's own error code or id. */
  readonly providerCode: string;
  /** Provider-specific details, if any. */
  readonly details: unknown;
  /** Whether the HTTP core may resend the request. */
  readonly retry: RetryPolicy;
  /** Seconds from `Retry-After`, when the response carried one. */
  readonly retryAfterSeconds: number | null;

  /** @param init - Error fields. */
  constructor(init: ProviderApiErrorInit) {
    super(`${init.provider} API ${init.status} ${init.providerCode}: ${init.message}`);
    this.provider = init.provider;
    this.status = init.status;
    this.code = init.code;
    this.providerCode = init.providerCode;
    this.details = init.details ?? null;
    this.retry = init.retry ?? defaultRetryPolicy(init.code, init.status);
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
  }
}

/** A request did not complete within the client's timeout. */
export class ProviderTimeoutError extends ProviderError {
  override name = "ProviderTimeoutError";

  /**
   * @param provider - Provider called.
   * @param method - HTTP method.
   * @param path - API path.
   * @param timeoutMs - Timeout that elapsed.
   */
  constructor(
    readonly provider: ProviderId,
    readonly method: string,
    readonly path: string,
    readonly timeoutMs: number,
  ) {
    super(`${provider} API ${method} ${path} timed out after ${timeoutMs} ms`);
  }
}

/** `fetch` itself failed (DNS, connection reset, TLS). */
export class ProviderNetworkError extends ProviderError {
  override name = "ProviderNetworkError";

  /**
   * @param provider - Provider called.
   * @param method - HTTP method.
   * @param path - API path.
   * @param cause - The underlying error.
   */
  constructor(
    readonly provider: ProviderId,
    readonly method: string,
    readonly path: string,
    cause: unknown,
  ) {
    super(`${provider} API ${method} ${path} failed: ${errorMessage(cause)}`, { cause });
  }
}

/** An asynchronous provider task ended in error, or did not finish in time. */
export class ProviderActionError extends ProviderError {
  override name = "ProviderActionError";

  /**
   * @param provider - Provider.
   * @param actionId - The task's ID, or the server ID when the provider has no task objects.
   * @param command - What the task does, e.g. `create_server`.
   * @param code - Provider error code, or `action_timeout`.
   * @param message - Provider message.
   */
  constructor(
    readonly provider: ProviderId,
    readonly actionId: string,
    readonly command: string,
    readonly code: string,
    message: string,
  ) {
    super(`${provider} action ${actionId} (${command}) failed: ${code}: ${message}`);
  }
}

/** Reasons {@link ProvisionError} is thrown. */
export type ProvisionErrorReason =
  /** The provider rejected the token. */
  | "token_invalid"
  /** The token can read but not create servers, firewalls, or keys. */
  | "token_read_only"
  /** An input failed validation before any API call. */
  | "invalid_input"
  /** The plan is unknown, deprecated past removal, or sold out in the region. */
  | "offer_unavailable"
  /** No supported image exists for the plan's architecture in the region. */
  | "image_unavailable"
  /** A server, firewall, or key with this name exists but is not managed by Roundhouse. */
  | "name_taken"
  /** A managed server with this name is being deleted; retry later. */
  | "server_deleting"
  /** A step after server creation failed; the server was deleted. */
  | "failed_cleaned_up"
  /** A step after server creation failed and deleting the server also failed. */
  | "failed_cleanup_failed"
  /** Refused to delete a server that lacks the managed marker or belongs to another node. */
  | "not_managed";

/**
 * A provisioning step failed or was refused. `cause` holds the underlying
 * error when there is one.
 */
export class ProvisionError extends ProviderError {
  override name = "ProvisionError";

  /**
   * The server involved. For `failed_cleanup_failed` this server may still
   * exist and bill; the caller must record it and retry deprovisioning.
   */
  readonly serverId: string | null;

  /**
   * @param reason - Machine-readable reason.
   * @param message - Human-readable description.
   * @param options - `cause`, and `serverId` when a server is involved.
   */
  constructor(
    readonly reason: ProvisionErrorReason,
    message: string,
    options: { cause?: unknown; serverId?: string | null } = {},
  ) {
    super(message, { cause: options.cause });
    this.serverId = options.serverId ?? null;
  }
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

/**
 * Whether an error leaves it unknown if a request was applied: a timeout, a
 * network failure, or a gateway error.
 *
 * @param e - Thrown value.
 * @returns `true` when the request may or may not have taken effect.
 */
export function isAmbiguous(e: unknown): boolean {
  return (
    e instanceof ProviderTimeoutError ||
    e instanceof ProviderNetworkError ||
    (e instanceof ProviderApiError && e.retry === "idempotent")
  );
}

/**
 * Whether an error is a provider `conflict` (a name or key already exists,
 * or a concurrent change).
 *
 * @param e - Thrown value.
 * @returns `true` for a {@link ProviderApiError} with code `conflict`.
 */
export function isConflict(e: unknown): boolean {
  return e instanceof ProviderApiError && e.code === "conflict";
}

/**
 * Whether an error is a provider `not_found`.
 *
 * @param e - Thrown value.
 * @returns `true` for a {@link ProviderApiError} with code `not_found`.
 */
export function isNotFound(e: unknown): boolean {
  return e instanceof ProviderApiError && e.code === "not_found";
}
