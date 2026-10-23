/**
 * Typed Hetzner Cloud API client, on the shared HTTP core.
 *
 * Responsibilities:
 * - Bearer authentication and error mapping to {@link ProviderApiError}
 *   with Hetzner's code kept as `providerCode`.
 * - Pagination via `meta.pagination` (the `Link` header is deprecated).
 * - Rate limiting from `RateLimit-*` headers (3600/h, refilled linearly).
 * - Polling asynchronous actions until they finish.
 * - Token validation that distinguishes invalid from read-only tokens.
 *
 * @module
 */
import {
  type ApiErrorCode,
  ProviderActionError,
  ProviderApiError,
  type RetryPolicy,
} from "../errors";
import {
  collect,
  HttpClient,
  type PollOptions,
  pollUntil,
  type Query,
  type RequestOptions,
  type TransportOptions,
} from "../http";
import type { TokenCheck } from "../provider";
import type {
  Action,
  CreateFirewallBody,
  CreateFirewallResponse,
  CreateServerBody,
  CreateServerResponse,
  CreateSshKeyBody,
  Firewall,
  HetznerArchitecture,
  Image,
  Location,
  Pagination,
  Pricing,
  Server,
  ServerType,
  SshKey,
} from "./types";

/** Default API base URL. */
export const HETZNER_API_URL = "https://api.hetzner.cloud/v1";

/** Largest page size the API accepts. */
export const HETZNER_MAX_PER_PAGE = 50;

/** Options for {@link HetznerClient}. */
export interface HetznerClientOptions extends TransportOptions {
  /** Hetzner Cloud API token (project scoped, read or read/write). */
  token: string;
  /** API base URL. Defaults to {@link HETZNER_API_URL}. */
  baseUrl?: string;
}

const CODES: Record<string, ApiErrorCode> = {
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  protected: "forbidden",
  rate_limit_exceeded: "rate_limited",
  not_found: "not_found",
  resource_limit_exceeded: "quota_exceeded",
  invalid_input: "invalid_input",
  json_error: "invalid_input",
  unsupported_error: "invalid_input",
  uniqueness_error: "conflict",
  conflict: "conflict",
  locked: "conflict",
  maintenance: "unavailable",
  resource_unavailable: "unavailable",
  unavailable: "unavailable",
  server_error: "unavailable",
  service_error: "unavailable",
  bad_gateway: "unavailable",
  timeout: "unavailable",
  placement_error: "unavailable",
};

function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 422 || status === 400) return "invalid_input";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "unknown";
}

/**
 * Maps a Hetzner error response (`{error:{code,message,details}}`) to a
 * {@link ProviderApiError}.
 *
 * Retry policy: `conflict` ("the resource changed during the request") and
 * rate limits were rejected without acting, so any method is resent;
 * `bad_gateway`, `timeout`, and 502/503/504 only for idempotent methods.
 *
 * @param status - HTTP status.
 * @param text - Raw body.
 * @returns The error.
 */
export function parseHetznerError(status: number, text: string): ProviderApiError {
  let providerCode = `http_${status}`;
  let message = text.slice(0, 200) || "empty response";
  let details: unknown = null;
  try {
    const e = (
      JSON.parse(text) as { error?: { code?: unknown; message?: unknown; details?: unknown } }
    ).error;
    if (e && typeof e.code === "string") {
      providerCode = e.code;
      message = String(e.message ?? "");
      details = e.details ?? null;
    }
  } catch {
    // Non-JSON bodies (e.g. a proxy's HTML error page) keep http_<status>.
  }
  const code = CODES[providerCode] ?? codeForStatus(status);
  let retry: RetryPolicy | undefined;
  if (providerCode === "conflict") retry = "always";
  else if (providerCode === "bad_gateway" || providerCode === "timeout") retry = "idempotent";
  return new ProviderApiError({
    provider: "hetzner",
    status,
    code,
    providerCode,
    message,
    details,
    retry,
  });
}

/**
 * Hetzner Cloud API client.
 *
 * @example
 * const hz = new HetznerClient({ token });
 * const types = await hz.listServerTypes();
 */
export class HetznerClient {
  /** The shared HTTP core; exposes `rateLimit`, `sleep`, and `now`. */
  readonly http: HttpClient;

  /**
   * @param options - Token and tuning.
   * @throws TypeError when the token is empty or contains whitespace.
   */
  constructor(options: HetznerClientOptions) {
    const token = options.token?.trim() ?? "";
    if (!token || /\s/.test(token)) throw new TypeError("Hetzner API token is empty or malformed");
    this.http = new HttpClient({
      ...options,
      provider: "hetzner",
      baseUrl: options.baseUrl ?? HETZNER_API_URL,
      headers: { authorization: `Bearer ${token}` },
      parseError: parseHetznerError,
      rateLimit: {
        limitHeader: "ratelimit-limit",
        remainingHeader: "ratelimit-remaining",
        resetHeader: "ratelimit-reset",
        resetUnit: "epoch-seconds",
        windowMs: 3_600_000,
        refill: "linear",
      },
    });
  }

  /**
   * Collects every item of a list endpoint, 50 per page, following
   * `meta.pagination.next_page`.
   *
   * @param path - List endpoint, e.g. `/servers`.
   * @param key - Array property in the response, e.g. `servers`.
   * @param query - Filters.
   * @param options - Signal and timeout.
   * @returns All items.
   */
  listAll<T>(
    path: string,
    key: string,
    query: Query = {},
    options: RequestOptions = {},
  ): Promise<T[]> {
    return collect<T, number>(path, 1, async (page) => {
      const res = await this.http.request<
        Record<string, unknown> & { meta?: { pagination?: Pagination } }
      >("GET", path, { ...options, query: { ...query, page, per_page: HETZNER_MAX_PER_PAGE } });
      const items = Array.isArray(res[key]) ? (res[key] as T[]) : [];
      const next = res.meta?.pagination?.next_page ?? null;
      return { items, next: next !== null && next > page ? next : null };
    });
  }

  /**
   * Checks a token with two cheap calls and no side effects:
   * 1. `GET /locations?per_page=1`: `401` means the token is invalid.
   * 2. `POST /ssh_keys` with an empty name and key: a read-only token gets
   *    `403 forbidden`; a read/write token gets a validation error, since the
   *    body can never create a key.
   *
   * @param options - Signal and timeout.
   * @returns Whether the token is valid and can write.
   * @throws ProviderApiError for other failures (e.g. `5xx`), and transport errors.
   */
  async validateToken(options: RequestOptions = {}): Promise<TokenCheck> {
    try {
      await this.http.request("GET", "/locations", { ...options, query: { per_page: 1 } });
    } catch (e) {
      if (e instanceof ProviderApiError && e.code === "unauthorized") {
        return { valid: false, canWrite: false };
      }
      throw e;
    }
    try {
      const res = await this.http.request<{ ssh_key?: { id?: number } }>("POST", "/ssh_keys", {
        ...options,
        body: { name: "", public_key: "" },
      });
      // NOTE: unreachable against the real API (an empty key is invalid), but
      // if it ever succeeded the probe must not leave a key behind.
      if (res?.ssh_key?.id) await this.deleteSshKey(res.ssh_key.id, options).catch(() => {});
      return { valid: true, canWrite: true };
    } catch (e) {
      if (!(e instanceof ProviderApiError)) throw e;
      if (e.code === "unauthorized") return { valid: false, canWrite: false };
      if (e.code === "forbidden") return { valid: true, canWrite: false };
      if (e.status >= 400 && e.status < 500) return { valid: true, canWrite: true };
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Catalogue
  // ---------------------------------------------------------------------------

  /**
   * Lists server types with per-location prices and availability.
   *
   * @param filter - Optional exact `name`.
   * @param options - Signal and timeout.
   * @returns Every server type, including deprecated ones.
   */
  listServerTypes(
    filter: { name?: string } = {},
    options: RequestOptions = {},
  ): Promise<ServerType[]> {
    return this.listAll("/server_types", "server_types", { name: filter.name }, options);
  }

  /**
   * Lists locations.
   *
   * @param options - Signal and timeout.
   * @returns Every location.
   */
  listLocations(options: RequestOptions = {}): Promise<Location[]> {
    return this.listAll("/locations", "locations", {}, options);
  }

  /**
   * Lists images.
   *
   * @param filter - Type, status, architecture, and exact name.
   * @param options - Signal and timeout.
   * @returns Matching images.
   */
  listImages(
    filter: {
      type?: Image["type"];
      status?: Image["status"];
      architecture?: HetznerArchitecture;
      name?: string;
    } = {},
    options: RequestOptions = {},
  ): Promise<Image[]> {
    return this.listAll(
      "/images",
      "images",
      {
        type: filter.type,
        status: filter.status,
        architecture: filter.architecture,
        name: filter.name,
      },
      options,
    );
  }

  /**
   * Reads the project's pricing currency and VAT rate.
   *
   * @param options - Signal and timeout.
   * @returns Currency and VAT rate.
   */
  async getPricing(options: RequestOptions = {}): Promise<Pricing> {
    const res = await this.http.request<{ pricing: Pricing }>("GET", "/pricing", options);
    return { currency: res.pricing.currency, vat_rate: res.pricing.vat_rate };
  }

  // ---------------------------------------------------------------------------
  // SSH keys
  // ---------------------------------------------------------------------------

  /**
   * Lists SSH keys.
   *
   * @param options - Signal and timeout.
   * @returns Every key in the project.
   */
  listSshKeys(options: RequestOptions = {}): Promise<SshKey[]> {
    return this.listAll("/ssh_keys", "ssh_keys", {}, options);
  }

  /**
   * Uploads an SSH public key.
   *
   * @param body - Name, public key, and labels.
   * @param options - Signal and timeout.
   * @returns The created key.
   * @throws ProviderApiError `conflict` (`uniqueness_error`) when the name or fingerprint exists.
   */
  async createSshKey(body: CreateSshKeyBody, options: RequestOptions = {}): Promise<SshKey> {
    const res = await this.http.request<{ ssh_key: SshKey }>("POST", "/ssh_keys", {
      ...options,
      body,
    });
    return res.ssh_key;
  }

  /**
   * Deletes an SSH key.
   *
   * @param id - Key ID.
   * @param options - Signal and timeout.
   */
  async deleteSshKey(id: number, options: RequestOptions = {}): Promise<void> {
    await this.http.request("DELETE", `/ssh_keys/${id}`, options);
  }

  // ---------------------------------------------------------------------------
  // Firewalls
  // ---------------------------------------------------------------------------

  /**
   * Lists firewalls.
   *
   * @param filter - Exact name or label selector.
   * @param options - Signal and timeout.
   * @returns Matching firewalls.
   */
  listFirewalls(
    filter: { name?: string; labelSelector?: string } = {},
    options: RequestOptions = {},
  ): Promise<Firewall[]> {
    return this.listAll(
      "/firewalls",
      "firewalls",
      { name: filter.name, label_selector: filter.labelSelector },
      options,
    );
  }

  /**
   * Creates a firewall.
   *
   * @param body - Name, labels, and rules.
   * @param options - Signal and timeout.
   * @returns The firewall and any `apply_firewall` actions.
   */
  createFirewall(
    body: CreateFirewallBody,
    options: RequestOptions = {},
  ): Promise<CreateFirewallResponse> {
    return this.http.request("POST", "/firewalls", { ...options, body });
  }

  // ---------------------------------------------------------------------------
  // Servers
  // ---------------------------------------------------------------------------

  /**
   * Lists servers.
   *
   * @param filter - Exact name or label selector.
   * @param options - Signal and timeout.
   * @returns Matching servers.
   */
  listServers(
    filter: { name?: string; labelSelector?: string } = {},
    options: RequestOptions = {},
  ): Promise<Server[]> {
    return this.listAll(
      "/servers",
      "servers",
      { name: filter.name, label_selector: filter.labelSelector },
      options,
    );
  }

  /**
   * Gets a server.
   *
   * @param id - Server ID.
   * @param options - Signal and timeout.
   * @returns The server.
   * @throws ProviderApiError `not_found`.
   */
  async getServer(id: number, options: RequestOptions = {}): Promise<Server> {
    const res = await this.http.request<{ server: Server }>("GET", `/servers/${id}`, options);
    return res.server;
  }

  /**
   * Creates a server. Never retried on ambiguous failures; callers recover by
   * looking the server up by label.
   *
   * @param body - Server spec.
   * @param options - Signal and timeout.
   * @returns The server, its `create_server` action, and follow-up actions.
   */
  createServer(
    body: CreateServerBody,
    options: RequestOptions = {},
  ): Promise<CreateServerResponse> {
    return this.http.request("POST", "/servers", { ...options, body });
  }

  /**
   * Deletes a server immediately.
   *
   * @param id - Server ID.
   * @param options - Signal and timeout.
   * @returns The `delete_server` action.
   */
  async deleteServer(id: number, options: RequestOptions = {}): Promise<Action> {
    const res = await this.http.request<{ action: Action }>("DELETE", `/servers/${id}`, options);
    return res.action;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /**
   * Gets actions by ID in one request (`GET /actions?id=…`).
   *
   * @param ids - Action IDs.
   * @param options - Signal and timeout.
   * @returns The actions.
   */
  async getActions(ids: number[], options: RequestOptions = {}): Promise<Action[]> {
    if (ids.length === 0) return [];
    const res = await this.http.request<{ actions: Action[] }>("GET", "/actions", {
      ...options,
      query: { id: ids },
    });
    return res.actions;
  }

  /**
   * Polls actions until none is `running`.
   *
   * @param actions - Actions or action IDs.
   * @param options - Poll interval, overall timeout, and signal.
   * @returns The finished actions.
   * @throws ProviderActionError when one ends in `error` or the timeout passes.
   */
  async waitForActions(actions: (Action | number)[], options: PollOptions = {}): Promise<Action[]> {
    const done = new Map<number, Action>();
    for (const a of actions) if (typeof a !== "number" && a.status !== "running") done.set(a.id, a);
    const ids = actions.map((a) => (typeof a === "number" ? a : a.id));
    const commands = new Map(
      actions.filter((a): a is Action => typeof a !== "number").map((a) => [a.id, a.command]),
    );
    let first = true;
    await pollUntil(
      this.http,
      async () => {
        const pending = ids.filter((id) => !done.has(id));
        if (pending.length === 0) return true;
        if (first) {
          // Known actions are not re-read before the first interval.
          first = false;
          return undefined;
        }
        for (const a of await this.getActions(pending, { signal: options.signal })) {
          if (a.status !== "running") done.set(a.id, a);
        }
        return ids.every((id) => done.has(id)) ? true : undefined;
      },
      {
        ...options,
        onTimeout: () => {
          const id = ids.find((x) => !done.has(x))!;
          return new ProviderActionError(
            "hetzner",
            String(id),
            commands.get(id) ?? "unknown",
            "action_timeout",
            "did not finish in time",
          );
        },
      },
    );
    const result = ids.map((id) => done.get(id)!);
    const failed = result.find((a) => a.status === "error");
    if (failed) {
      throw new ProviderActionError(
        "hetzner",
        String(failed.id),
        failed.command,
        failed.error?.code ?? "action_failed",
        failed.error?.message ?? "action failed",
      );
    }
    return result;
  }
}
