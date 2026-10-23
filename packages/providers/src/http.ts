/**
 * The HTTP core every adapter's client is built on.
 *
 * Responsibilities:
 * - JSON encoding, per-attempt timeouts combined with the caller's
 *   `AbortSignal`, and mapping failures to {@link ProviderTimeoutError},
 *   {@link ProviderNetworkError}, or the adapter's {@link ProviderApiError}.
 * - Retries with capped, jittered exponential backoff that honours
 *   `Retry-After`, and waits that end early when the caller aborts.
 * - Idempotency rules: a create is resent only when the provider rejected
 *   it without acting (`retry: "always"`, e.g. `429`). Timeouts, network
 *   failures, and gateway errors are retried only for idempotent methods,
 *   because a `POST` may have been applied.
 * - Optional client-side throttling from `RateLimit`-style headers.
 * - Cursor-agnostic pagination with a runaway guard.
 *
 * Each adapter supplies the base URL, auth headers, error mapping, and the
 * names of its rate-limit headers. Uses only `fetch`, `AbortController`, and
 * timers, so it runs in Workers, browsers, and Node.
 *
 * @module
 */
import {
  type ProviderApiError,
  ProviderError,
  type ProviderId,
  ProviderNetworkError,
  ProviderTimeoutError,
} from "./errors";

/** Minimal `fetch` signature, so tests and Workers can inject their own. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Abortable sleep signature. */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

/** Transport tuning shared by every adapter. */
export interface TransportOptions {
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
  sleep?: SleepFn;
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

/** Query parameter values; arrays repeat the key. */
export type Query = Record<string, string | number | boolean | (string | number)[] | undefined>;

/** One request. */
export interface Call extends RequestOptions {
  /** Query parameters. */
  query?: Query;
  /** JSON body. */
  body?: unknown;
  /** Extra headers, e.g. Linode's `X-Filter`. */
  headers?: Record<string, string>;
}

/** A successful response. */
export interface HttpResponse<T> {
  /** HTTP status. */
  status: number;
  /** Response headers. */
  headers: Headers;
  /** Parsed JSON body, or `undefined` when empty. */
  body: T;
}

/** How a provider reports its rate limit in response headers. */
export interface RateLimitSpec {
  /** Header with the request budget per window. */
  limitHeader: string;
  /** Header with the requests left in the window. */
  remainingHeader: string;
  /** Header with the reset time. */
  resetHeader: string;
  /** Whether the reset header is a unix time or seconds from now. */
  resetUnit: "epoch-seconds" | "delta-seconds";
  /** Window length in ms, e.g. 3 600 000 for an hourly budget. */
  windowMs: number;
  /**
   * `linear`: the budget refills continuously (one request every
   * `windowMs / limit`). `window`: it refills all at once at the reset time.
   */
  refill: "linear" | "window";
}

/** Last seen rate-limit headers. `null` until a response carried them. */
export interface RateLimitState {
  /** Requests per window. */
  limit: number | null;
  /** Requests left in the window. */
  remaining: number | null;
  /** Unix ms when the budget is fully restored. */
  resetAt: number | null;
}

/** Adapter-specific configuration of {@link HttpClient}. */
export interface HttpClientConfig extends TransportOptions {
  /** Provider, for error messages. */
  provider: ProviderId;
  /** API base URL without a trailing slash, e.g. `https://api.hetzner.cloud/v1`. */
  baseUrl: string;
  /** Headers added to every request, typically `authorization`. */
  headers: Record<string, string>;
  /**
   * Maps a non-2xx response to an error.
   *
   * @param status - HTTP status.
   * @param text - Raw body.
   * @param headers - Response headers.
   */
  parseError: (status: number, text: string, headers: Headers) => ProviderApiError;
  /** Rate-limit headers, when the provider sends them. */
  rateLimit?: RateLimitSpec;
}

/** Upper bound on pages fetched by one listing, as a guard against a looping API. */
export const MAX_PAGES = 200;

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
 * Encodes query parameters, skipping `undefined` and repeating array keys.
 *
 * @param query - Parameters.
 * @returns `?a=1&b=2`, or `""` when empty.
 */
export function encodeQuery(query: Query | undefined): string {
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

/**
 * Reads an integer header.
 *
 * @param headers - Response headers.
 * @param name - Header name.
 * @returns The value, or `null` when absent or not a number.
 */
export function intHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parses `Retry-After`, which is either delay seconds or an HTTP date.
 *
 * @param headers - Response headers.
 * @param now - Current unix ms.
 * @returns Seconds to wait, or `null`.
 */
export function retryAfterSeconds(headers: Headers, now: number): number | null {
  const raw = headers.get("retry-after");
  if (raw === null) return null;
  if (/^\d+$/.test(raw.trim())) return Number(raw.trim());
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}

/**
 * JSON-over-HTTPS client with retries, backoff, throttling, and timeouts.
 * Adapters wrap it with typed methods.
 *
 * @example
 * const http = new HttpClient({
 *   provider: "hetzner",
 *   baseUrl: "https://api.hetzner.cloud/v1",
 *   headers: { authorization: `Bearer ${token}` },
 *   parseError: parseHetznerError,
 * });
 * const res = await http.request<{ servers: unknown[] }>("GET", "/servers");
 */
export class HttpClient {
  /** Rate-limit state from the most recent response that carried it. */
  readonly rateLimit: RateLimitState = { limit: null, remaining: null, resetAt: null };

  /** The provider this client talks to. */
  readonly provider: ProviderId;
  /** Abortable sleep, shared with adapters' polling loops. */
  readonly sleep: SleepFn;
  /** Clock in unix ms, shared with adapters' polling loops. */
  readonly now: () => number;

  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly parseError: HttpClientConfig["parseError"];
  private readonly rateLimitSpec: RateLimitSpec | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly random: () => number;
  private readonly userAgent: string;

  /** @param config - Adapter configuration and transport tuning. */
  constructor(config: HttpClientConfig) {
    this.provider = config.provider;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.headers = config.headers;
    this.parseError = config.parseError;
    this.rateLimitSpec = config.rateLimit;
    // COMPAT: Workers throws "Illegal invocation" when the global fetch is
    // called as a method of another object, so it is wrapped, not stored.
    this.fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.maxRetries = config.maxRetries ?? 4;
    this.baseBackoffMs = config.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = config.maxBackoffMs ?? 30_000;
    this.sleep = config.sleep ?? abortableSleep;
    this.now = config.now ?? Date.now;
    this.random = config.random ?? Math.random;
    this.userAgent = config.userAgent ?? "roundhouse-providers/0.0.0";
  }

  /**
   * Sends a request and returns the parsed body.
   *
   * @param method - HTTP method.
   * @param path - Path below the base URL, starting with `/`.
   * @param call - Query, body, headers, signal, timeout.
   * @returns The parsed JSON body, or `undefined` for empty responses.
   * @throws ProviderApiError, ProviderTimeoutError, ProviderNetworkError, or
   *   the signal's abort reason.
   */
  async request<T>(method: string, path: string, call: Call = {}): Promise<T> {
    return (await this.send<T>(method, path, call)).body;
  }

  /**
   * Sends a request with retries and returns status, headers, and body.
   *
   * @param method - HTTP method.
   * @param path - Path below the base URL, starting with `/`.
   * @param call - Query, body, headers, signal, timeout.
   * @returns The response.
   * @throws See {@link HttpClient.request}.
   */
  async send<T>(method: string, path: string, call: Call = {}): Promise<HttpResponse<T>> {
    const idempotent = IDEMPOTENT.has(method);
    for (let attempt = 0; ; attempt++) {
      call.signal?.throwIfAborted();
      await this.waitForBudget(call.signal);
      let res: { status: number; headers: Headers; text: string };
      try {
        res = await this.once(method, path, call);
      } catch (e) {
        const transient = e instanceof ProviderTimeoutError || e instanceof ProviderNetworkError;
        if (transient && idempotent && attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt), call.signal);
          continue;
        }
        throw e;
      }
      this.recordRateLimit(res.headers);
      if (res.status >= 200 && res.status < 300) {
        return {
          status: res.status,
          headers: res.headers,
          body: (res.text ? JSON.parse(res.text) : undefined) as T,
        };
      }
      const err = this.parseError(res.status, res.text, res.headers);
      const retry = err.retry === "always" || (idempotent && err.retry === "idempotent");
      if (retry && attempt < this.maxRetries) {
        await this.sleep(this.retryDelay(err, res.headers, attempt), call.signal);
        continue;
      }
      throw err;
    }
  }

  private async once(
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
      accept: "application/json",
      "user-agent": this.userAgent,
      ...this.headers,
      ...call.headers,
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
      if (timedOut) throw new ProviderTimeoutError(this.provider, method, path, timeoutMs);
      throw new ProviderNetworkError(this.provider, method, path, e);
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  }

  private recordRateLimit(headers: Headers): void {
    const spec = this.rateLimitSpec;
    if (!spec) return;
    const limit = intHeader(headers, spec.limitHeader);
    const remaining = intHeader(headers, spec.remainingHeader);
    const reset = intHeader(headers, spec.resetHeader);
    if (limit !== null) this.rateLimit.limit = limit;
    if (remaining !== null) this.rateLimit.remaining = remaining;
    if (reset !== null) {
      this.rateLimit.resetAt =
        spec.resetUnit === "epoch-seconds" ? reset * 1000 : this.now() + reset * 1000;
    }
  }

  /** Milliseconds for one request to regain budget, or `null` without a spec. */
  private refillMs(): number | null {
    const spec = this.rateLimitSpec;
    if (!spec) return null;
    const limit = this.rateLimit.limit;
    if (spec.refill === "window") {
      const reset = this.rateLimit.resetAt;
      return reset === null ? null : Math.max(0, reset - this.now());
    }
    return limit && limit > 0 ? Math.ceil(spec.windowMs / limit) : 1_000;
  }

  private async waitForBudget(signal?: AbortSignal): Promise<void> {
    const { remaining, resetAt } = this.rateLimit;
    if (remaining === null || remaining > 0 || resetAt === null || resetAt <= this.now()) return;
    const refill = this.refillMs() ?? resetAt - this.now();
    await this.sleep(Math.min(refill, resetAt - this.now(), this.maxBackoffMs), signal);
    // Assume one request's worth of budget came back; the next response
    // corrects this from the headers.
    this.rateLimit.remaining = 1;
  }

  private backoff(attempt: number): number {
    const exp = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** attempt);
    // Equal jitter: at least half the delay, so retries never collapse to zero.
    return Math.round(exp / 2 + (this.random() * exp) / 2);
  }

  private retryDelay(err: ProviderApiError, headers: Headers, attempt: number): number {
    const after = err.retryAfterSeconds ?? retryAfterSeconds(headers, this.now());
    if (after !== null) return Math.min(this.maxBackoffMs, after * 1000);
    const delay = this.backoff(attempt);
    if (err.code === "rate_limited") {
      const refill = this.refillMs();
      if (refill !== null) return Math.min(this.maxBackoffMs, Math.max(delay, refill));
    }
    return delay;
  }
}

/** One page of a listing: its items and the cursor of the next page. */
export interface Page<T, C> {
  /** Items on this page. */
  items: T[];
  /** Cursor for the next page, or `null` on the last page. */
  next: C | null;
}

/**
 * Iterates a paginated listing whatever its cursor style (page numbers,
 * opaque cursors, or next links).
 *
 * @param label - Listing name for the runaway error.
 * @param first - Cursor of the first page.
 * @param fetchPage - Fetches one page.
 * @returns An async iterator over all items.
 * @throws ProviderError when the listing exceeds {@link MAX_PAGES}.
 */
export async function* paginate<T, C>(
  label: string,
  first: C,
  fetchPage: (cursor: C) => Promise<Page<T, C>>,
): AsyncGenerator<T> {
  let cursor = first;
  const seen = new Set<string>();
  for (let i = 0; i < MAX_PAGES; i++) {
    seen.add(JSON.stringify(cursor));
    const page = await fetchPage(cursor);
    yield* page.items;
    // A missing or repeated cursor ends the listing, so an API that keeps
    // pointing at the same page cannot loop forever.
    if (page.next === null || seen.has(JSON.stringify(page.next))) return;
    cursor = page.next;
  }
  throw new ProviderError(`${label}: more than ${MAX_PAGES} pages`);
}

/**
 * Collects every item of a paginated listing.
 *
 * @param label - Listing name for the runaway error.
 * @param first - Cursor of the first page.
 * @param fetchPage - Fetches one page.
 * @returns All items.
 */
export async function collect<T, C>(
  label: string,
  first: C,
  fetchPage: (cursor: C) => Promise<Page<T, C>>,
): Promise<T[]> {
  const out: T[] = [];
  for await (const item of paginate(label, first, fetchPage)) out.push(item);
  return out;
}

/** Options for {@link pollUntil}. */
export interface PollOptions {
  /** Cancels the wait. */
  signal?: AbortSignal;
  /** First poll delay in ms; grows 1.5x per poll up to 5 s. Default 1 000. */
  pollIntervalMs?: number;
  /** Give up after this long, in ms. Default 600 000. */
  timeoutMs?: number;
}

/**
 * Polls until `check` returns a value, sleeping with growing intervals.
 *
 * @param clock - `sleep` and `now`, normally the client's.
 * @param check - Returns a value when done, or `undefined` to keep waiting.
 * @param options - Interval, overall timeout, and signal.
 * @returns The first value `check` returned.
 * @throws The `onTimeout` error when the deadline passes.
 */
export async function pollUntil<T>(
  clock: { sleep: SleepFn; now: () => number },
  check: () => Promise<T | undefined>,
  options: PollOptions & { onTimeout: () => Error },
): Promise<T> {
  const deadline = clock.now() + (options.timeoutMs ?? 600_000);
  let interval = options.pollIntervalMs ?? 1_000;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (clock.now() >= deadline) throw options.onTimeout();
    await clock.sleep(interval, options.signal);
    interval = Math.min(5_000, Math.round(interval * 1.5));
  }
}
