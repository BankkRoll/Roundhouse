/**
 * Typed Hetzner Cloud API client for provisioning.
 *
 * Responsibilities:
 * - Bearer authentication, JSON encoding, and error mapping to
 *   {@link HetznerApiError}.
 * - Pagination via `meta.pagination` (the `Link` header is deprecated).
 * - Rate limiting: tracks the `RateLimit-*` headers, waits before sending
 *   when the budget is spent, and retries `429` with backoff.
 * - Per-request timeouts combined with the caller's `AbortSignal`.
 * - Polling asynchronous actions until they finish.
 * - Token validation that distinguishes invalid from read-only tokens.
 *
 * Uses only `fetch`, `AbortController`, and timers, so it runs in Workers,
 * browsers, and Node alike.
 *
 * @module
 */
import {
  HetznerActionError,
  HetznerApiError,
  HetznerError,
  HetznerNetworkError,
  HetznerTimeoutError,
} from "./errors";
import type {
  Action,
  CreateFirewallBody,
  CreateFirewallResponse,
  CreateServerBody,
  CreateServerResponse,
  CreateSshKeyBody,
  Firewall,
  FirewallResource,
  HetznerArchitecture,
  Image,
  Location,
  Pagination,
  Pricing,
  Server,
  ServerStatus,
  ServerType,
  SshKey,
} from "./types";

/** Default API base URL. */
export const HETZNER_API_URL = "https://api.hetzner.cloud/v1";

/** Largest page size the API accepts. */
export const MAX_PER_PAGE = 50;

/** Upper bound on pages fetched by one listing, as a guard against a looping API. */
const MAX_PAGES = 200;

/** Minimal `fetch` signature, so tests and Workers can inject their own. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Options for {@link HetznerClient}. */
export interface HetznerClientOptions {
  /** Hetzner Cloud API token (project scoped, read or read/write). */
  token: string;
  /** API base URL. Defaults to {@link HETZNER_API_URL}. */
  baseUrl?: string;
  /** `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Per-attempt timeout in ms. Default 30 000. */
  timeoutMs?: number;
  /** Retries for rate-limited or transient failures. Default 4. */
  maxRetries?: number;
  /** First backoff delay in ms; doubles per retry. Default 1 000. */
  baseBackoffMs?: number;
  /** Longest single backoff in ms. Default 30 000. */
  maxBackoffMs?: number;
  /** Abortable sleep. Injected by tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Clock in unix ms. Injected by tests. */
  now?: () => number;
  /** Uniform random in `[0, 1)`, used for jitter. Injected by tests. */
  random?: () => number;
  /** `User-Agent` header value. */
  userAgent?: string;
}

/** Per-call options. */
export interface RequestOptions {
  /** Cancels the call, including any backoff wait. */
  signal?: AbortSignal;
  /** Overrides the client's per-attempt timeout. */
  timeoutMs?: number;
}

/** Last seen rate-limit headers. `null` until a response carried them. */
export interface RateLimitState {
  /** `RateLimit-Limit`: requests per hour. */
  limit: number | null;
  /** `RateLimit-Remaining`: requests left in the window. */
  remaining: number | null;
  /** `RateLimit-Reset` in unix ms: when the budget is fully restored. */
  resetAt: number | null;
}

/** Query parameter values; arrays repeat the key. */
export type Query = Record<string, string | number | boolean | (string | number)[] | undefined>;

/** Internal request description. */
interface Call extends RequestOptions {
  query?: Query;
  body?: unknown;
}

/** Result of {@link HetznerClient.validateToken}. */
export type TokenCheck =
  /** Hetzner rejected the token (`401 unauthorized`). */
  | { valid: false }
  /** The token authenticates; `canWrite` is `false` for read-only tokens. */
  | { valid: true; canWrite: boolean };

/** Options for {@link HetznerClient.waitForActions}. */
export interface WaitOptions extends RequestOptions {
  /** First poll delay in ms; grows 1.5x per poll up to 5 s. Default 1 000. */
  pollIntervalMs?: number;
  /** Give up after this long, in ms. Default 600 000. */
  timeoutMs?: number;
}

/** Power actions available on a server. */
export type PowerAction = "poweron" | "poweroff" | "shutdown" | "reboot" | "reset";

const IDEMPOTENT = new Set(["GET", "PUT", "DELETE", "HEAD"]);

/**
 * Sleeps for `ms`, rejecting early with the signal's reason if it aborts.
 *
 * @param ms - Delay.
 * @param signal - Optional abort signal.
 * @returns Resolves after the delay.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Hetzner Cloud API client.
 *
 * @example
 * const hz = new HetznerClient({ token });
 * const check = await hz.validateToken();
 * if (!check.valid) throw new Error("bad token");
 * const types = await hz.listServerTypes();
 */
export class HetznerClient {
  /** Rate-limit state from the most recent response. */
  readonly rateLimit: RateLimitState = { limit: null, remaining: null, resetAt: null };

  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly userAgent: string;

  /**
   * @param options - Token and tuning; see {@link HetznerClientOptions}.
   * @throws TypeError when the token is empty or contains whitespace.
   */
  constructor(options: HetznerClientOptions) {
    const token = options.token?.trim() ?? "";
    if (!token || /\s/.test(token)) throw new TypeError("Hetzner API token is empty or malformed");
    this.token = token;
    this.baseUrl = (options.baseUrl ?? HETZNER_API_URL).replace(/\/+$/, "");
    // COMPAT: Workers throws "Illegal invocation" when the global fetch is
    // called as a method of another object, so it is wrapped, not stored.
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 4;
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.sleep = options.sleep ?? abortableSleep;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.userAgent = options.userAgent ?? "roundhouse-hetzner/0.0.0";
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  /**
   * Sends one API request with rate limiting, retries, and error mapping.
   *
   * Retries: `429` and `409 conflict` are retried for every method, since
   * Hetzner rejected them without acting. Gateway errors, timeouts, and
   * network failures are retried only for idempotent methods, because a
   * `POST` may have been applied.
   *
   * @param method - HTTP method.
   * @param path - Path below the base URL, starting with `/`.
   * @param call - Query, JSON body, signal, and timeout.
   * @returns The parsed JSON body, or `undefined` for empty responses.
   * @throws HetznerApiError, HetznerTimeoutError, HetznerNetworkError, or the
   *   signal's abort reason.
   */
  async request<T>(method: string, path: string, call: Call = {}): Promise<T> {
    const idempotent = IDEMPOTENT.has(method);
    for (let attempt = 0; ; attempt++) {
      call.signal?.throwIfAborted();
      await this.waitForBudget(call.signal);
      let res: { status: number; headers: Headers; text: string };
      try {
        res = await this.send(method, path, call);
      } catch (e) {
        const transient = e instanceof HetznerTimeoutError || e instanceof HetznerNetworkError;
        if (transient && idempotent && attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt), call.signal);
          continue;
        }
        throw e;
      }
      this.recordRateLimit(res.headers);
      if (res.status >= 200 && res.status < 300) {
        return (res.text ? JSON.parse(res.text) : undefined) as T;
      }
      const err = parseError(res.status, res.text);
      const retry = err.isRejectedRetryable || (idempotent && err.isAmbiguousTransient);
      if (retry && attempt < this.maxRetries) {
        await this.sleep(this.retryDelay(err, res.headers, attempt), call.signal);
        continue;
      }
      throw err;
    }
  }

  private async send(
    method: string,
    path: string,
    call: Call,
  ): Promise<{ status: number; headers: Headers; text: string }> {
    const url = this.baseUrl + path + encodeQuery(call.query);
    const timeoutMs = call.timeoutMs ?? this.timeoutMs;
    const ctrl = new AbortController();
    const outer = call.signal;
    const onAbort = () => ctrl.abort(outer?.reason);
    outer?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
      "user-agent": this.userAgent,
    };
    if (call.body !== undefined) headers["content-type"] = "application/json";
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
        signal: ctrl.signal,
      });
      // The body is read inside the timeout so a stalled stream also times out.
      const text = await res.text();
      return { status: res.status, headers: res.headers, text };
    } catch (e) {
      if (outer?.aborted) throw outer.reason;
      if (timedOut) throw new HetznerTimeoutError(method, path, timeoutMs);
      throw new HetznerNetworkError(method, path, e);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  }

  private recordRateLimit(headers: Headers): void {
    const limit = intHeader(headers, "ratelimit-limit");
    const remaining = intHeader(headers, "ratelimit-remaining");
    const reset = intHeader(headers, "ratelimit-reset");
    if (limit !== null) this.rateLimit.limit = limit;
    if (remaining !== null) this.rateLimit.remaining = remaining;
    if (reset !== null) this.rateLimit.resetAt = reset * 1000;
  }

  /**
   * Milliseconds for one request to regain budget. The bucket refills
   * linearly over an hour (3600/h restores one request per second).
   */
  private refillMs(): number {
    const limit = this.rateLimit.limit;
    return limit && limit > 0 ? Math.ceil(3_600_000 / limit) : 1_000;
  }

  private async waitForBudget(signal?: AbortSignal): Promise<void> {
    const { remaining, resetAt } = this.rateLimit;
    if (remaining !== null && remaining <= 0 && resetAt !== null && resetAt > this.now()) {
      await this.sleep(Math.min(this.refillMs(), resetAt - this.now()), signal);
      // Assume one request's worth of budget came back; the next response
      // corrects this from the headers.
      this.rateLimit.remaining = 1;
    }
  }

  private backoff(attempt: number): number {
    const exp = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** attempt);
    // Equal jitter: at least half the delay, so retries never collapse to zero.
    return Math.round(exp / 2 + (this.random() * exp) / 2);
  }

  private retryDelay(err: HetznerApiError, headers: Headers, attempt: number): number {
    const retryAfter = intHeader(headers, "retry-after");
    if (retryAfter !== null) return Math.min(this.maxBackoffMs, retryAfter * 1000);
    const delay = this.backoff(attempt);
    if (err.isRateLimited) {
      return Math.min(this.maxBackoffMs, Math.max(delay, this.refillMs()));
    }
    return delay;
  }

  /**
   * Iterates every item of a paginated list endpoint, 50 per page.
   *
   * @param path - List endpoint, e.g. `/servers`.
   * @param key - Array property in the response, e.g. `servers`.
   * @param query - Filters.
   * @param options - Signal and timeout.
   * @returns An async iterator over items.
   */
  async *paginate<T>(
    path: string,
    key: string,
    query: Query = {},
    options: RequestOptions = {},
  ): AsyncGenerator<T> {
    let page = 1;
    for (let i = 0; i < MAX_PAGES; i++) {
      const res = await this.request<
        Record<string, unknown> & { meta?: { pagination?: Pagination } }
      >("GET", path, { ...options, query: { ...query, page, per_page: MAX_PER_PAGE } });
      const items = res[key];
      if (Array.isArray(items)) yield* items as T[];
      const next = res.meta?.pagination?.next_page;
      if (!next || next <= page) return;
      page = next;
    }
    throw new HetznerError(`${path}: more than ${MAX_PAGES} pages`);
  }

  /**
   * Collects every item of a paginated list endpoint.
   *
   * @param path - List endpoint.
   * @param key - Array property in the response.
   * @param query - Filters.
   * @param options - Signal and timeout.
   * @returns All items.
   */
  async listAll<T>(
    path: string,
    key: string,
    query: Query = {},
    options: RequestOptions = {},
  ): Promise<T[]> {
    const out: T[] = [];
    for await (const item of this.paginate<T>(path, key, query, options)) out.push(item);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Token
  // ---------------------------------------------------------------------------

  /**
   * Checks a token with two cheap calls and no side effects:
   * 1. `GET /locations?per_page=1`: `401` means the token is invalid.
   * 2. `POST /ssh_keys` with an empty name and key: a read-only token gets
   *    `403 forbidden`; a read/write token gets a validation error, since the
   *    body can never create a key.
   *
   * @param options - Signal and timeout.
   * @returns Whether the token is valid and can write.
   * @throws HetznerApiError for other failures (e.g. `5xx`), and transport errors.
   */
  async validateToken(options: RequestOptions = {}): Promise<TokenCheck> {
    try {
      await this.request("GET", "/locations", { ...options, query: { per_page: 1 } });
    } catch (e) {
      if (e instanceof HetznerApiError && e.isUnauthorized) return { valid: false };
      throw e;
    }
    try {
      const res = await this.request<{ ssh_key?: { id?: number } }>("POST", "/ssh_keys", {
        ...options,
        body: { name: "", public_key: "" },
      });
      // NOTE: unreachable against the real API (an empty key is invalid), but
      // if it ever succeeded the probe must not leave a key behind.
      if (res?.ssh_key?.id) await this.deleteSshKey(res.ssh_key.id, options).catch(() => {});
      return { valid: true, canWrite: true };
    } catch (e) {
      if (!(e instanceof HetznerApiError)) throw e;
      if (e.isUnauthorized) return { valid: false };
      if (e.isForbidden) return { valid: true, canWrite: false };
      if (e.status >= 400 && e.status < 500) return { valid: true, canWrite: true };
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Catalogue: server types, locations, images, pricing
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
   * @param filter - Type, status, architecture, exact name, and whether to
   *   include deprecated images.
   * @param options - Signal and timeout.
   * @returns Matching images.
   */
  listImages(
    filter: {
      type?: Image["type"];
      status?: Image["status"];
      architecture?: HetznerArchitecture;
      name?: string;
      includeDeprecated?: boolean;
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
        include_deprecated: filter.includeDeprecated,
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
    const res = await this.request<{ pricing: Pricing }>("GET", "/pricing", options);
    return { currency: res.pricing.currency, vat_rate: res.pricing.vat_rate };
  }

  // ---------------------------------------------------------------------------
  // SSH keys
  // ---------------------------------------------------------------------------

  /**
   * Lists SSH keys.
   *
   * @param filter - Exact name, MD5 fingerprint, or label selector.
   * @param options - Signal and timeout.
   * @returns Matching keys.
   */
  listSshKeys(
    filter: { name?: string; fingerprint?: string; labelSelector?: string } = {},
    options: RequestOptions = {},
  ): Promise<SshKey[]> {
    return this.listAll(
      "/ssh_keys",
      "ssh_keys",
      { name: filter.name, fingerprint: filter.fingerprint, label_selector: filter.labelSelector },
      options,
    );
  }

  /**
   * Uploads an SSH public key.
   *
   * @param body - Name, public key, and labels.
   * @param options - Signal and timeout.
   * @returns The created key.
   * @throws HetznerApiError `uniqueness_error` when the name or fingerprint exists.
   */
  async createSshKey(body: CreateSshKeyBody, options: RequestOptions = {}): Promise<SshKey> {
    const res = await this.request<{ ssh_key: SshKey }>("POST", "/ssh_keys", { ...options, body });
    return res.ssh_key;
  }

  /**
   * Deletes an SSH key.
   *
   * @param id - Key ID.
   * @param options - Signal and timeout.
   */
  async deleteSshKey(id: number, options: RequestOptions = {}): Promise<void> {
    await this.request("DELETE", `/ssh_keys/${id}`, options);
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
   * @param body - Name, labels, rules, and optional targets.
   * @param options - Signal and timeout.
   * @returns The firewall and any `apply_firewall` actions.
   */
  createFirewall(
    body: CreateFirewallBody,
    options: RequestOptions = {},
  ): Promise<CreateFirewallResponse> {
    return this.request("POST", "/firewalls", { ...options, body });
  }

  /**
   * Applies a firewall to servers or label selectors.
   *
   * @param id - Firewall ID.
   * @param resources - Targets.
   * @param options - Signal and timeout.
   * @returns The `apply_firewall` actions to wait for.
   */
  async applyFirewall(
    id: number,
    resources: FirewallResource[],
    options: RequestOptions = {},
  ): Promise<Action[]> {
    const res = await this.request<{ actions: Action[] }>(
      "POST",
      `/firewalls/${id}/actions/apply_to_resources`,
      { ...options, body: { apply_to: resources } },
    );
    return res.actions;
  }

  // ---------------------------------------------------------------------------
  // Servers
  // ---------------------------------------------------------------------------

  /**
   * Lists servers.
   *
   * @param filter - Exact name, label selector, or status.
   * @param options - Signal and timeout.
   * @returns Matching servers.
   */
  listServers(
    filter: { name?: string; labelSelector?: string; status?: ServerStatus } = {},
    options: RequestOptions = {},
  ): Promise<Server[]> {
    return this.listAll(
      "/servers",
      "servers",
      { name: filter.name, label_selector: filter.labelSelector, status: filter.status },
      options,
    );
  }

  /**
   * Gets a server.
   *
   * @param id - Server ID.
   * @param options - Signal and timeout.
   * @returns The server.
   * @throws HetznerApiError `not_found`.
   */
  async getServer(id: number, options: RequestOptions = {}): Promise<Server> {
    const res = await this.request<{ server: Server }>("GET", `/servers/${id}`, options);
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
    return this.request("POST", "/servers", { ...options, body });
  }

  /**
   * Deletes a server immediately.
   *
   * @param id - Server ID.
   * @param options - Signal and timeout.
   * @returns The `delete_server` action.
   */
  async deleteServer(id: number, options: RequestOptions = {}): Promise<Action> {
    const res = await this.request<{ action: Action }>("DELETE", `/servers/${id}`, options);
    return res.action;
  }

  /**
   * Runs a power action on a server.
   *
   * @param id - Server ID.
   * @param action - `poweron`, `poweroff` (hard), `shutdown` (ACPI),
   *   `reboot` (ACPI), or `reset` (hard).
   * @param options - Signal and timeout.
   * @returns The action to wait for.
   */
  async power(id: number, action: PowerAction, options: RequestOptions = {}): Promise<Action> {
    const res = await this.request<{ action: Action }>(
      "POST",
      `/servers/${id}/actions/${action}`,
      options,
    );
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
    const res = await this.request<{ actions: Action[] }>("GET", "/actions", {
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
   * @throws HetznerActionError when one ends in `error` or the timeout passes.
   */
  async waitForActions(actions: (Action | number)[], options: WaitOptions = {}): Promise<Action[]> {
    let current = actions.filter((a): a is Action => typeof a !== "number");
    let pending = actions.map((a) => (typeof a === "number" ? a : a.id));
    const done = new Map<number, Action>();
    for (const a of current) if (a.status !== "running") done.set(a.id, a);
    pending = pending.filter((id) => !done.has(id));

    const deadline = this.now() + (options.timeoutMs ?? 600_000);
    let interval = options.pollIntervalMs ?? 1_000;
    const req = { signal: options.signal };
    while (pending.length > 0) {
      if (this.now() >= deadline) {
        const a = current.find((x) => x.id === pending[0]);
        throw new HetznerActionError(
          pending[0]!,
          a?.command ?? "unknown",
          "action_timeout",
          "did not finish in time",
        );
      }
      await this.sleep(interval, options.signal);
      interval = Math.min(5_000, Math.round(interval * 1.5));
      current = await this.getActions(pending, req);
      for (const a of current) if (a.status !== "running") done.set(a.id, a);
      pending = pending.filter((id) => !done.has(id));
    }
    const result = actions.map((a) => done.get(typeof a === "number" ? a : a.id)!);
    const failed = result.find((a) => a.status === "error");
    if (failed) {
      throw new HetznerActionError(
        failed.id,
        failed.command,
        failed.error?.code ?? "action_failed",
        failed.error?.message ?? "action failed",
      );
    }
    return result;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function encodeQuery(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) params.append(key, String(v));
    else params.append(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

function intHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function parseError(status: number, text: string): HetznerApiError {
  try {
    const body = JSON.parse(text) as {
      error?: { code?: unknown; message?: unknown; details?: unknown };
    };
    const e = body.error;
    if (e && typeof e.code === "string") {
      const details =
        e.details && typeof e.details === "object" ? (e.details as Record<string, unknown>) : null;
      return new HetznerApiError(status, e.code, String(e.message ?? ""), details);
    }
  } catch {
    // Non-JSON bodies (e.g. a proxy's HTML error page) fall through.
  }
  return new HetznerApiError(status, `http_${status}`, text.slice(0, 200) || "empty response");
}
