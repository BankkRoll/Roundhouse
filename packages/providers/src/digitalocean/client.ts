/**
 * Typed DigitalOcean API v2 client, on the shared HTTP core.
 *
 * Responsibilities:
 * - Bearer authentication and error mapping (`{id, message}`, plus the
 *   `{error, root_causes}` shape some endpoints use).
 * - Pagination with `page`/`per_page` (max 200), following `links.pages.next`.
 * - Rate limiting from `ratelimit-*` headers (5 000/h per token, a sliding
 *   window, so the budget refills continuously) and `retry-after` on the
 *   250/min burst limit.
 * - Token validation with scope probes, since custom-scoped tokens exist and
 *   no endpoint reports a token's scopes.
 *
 * @module
 */
import { type ApiErrorCode, ProviderActionError, ProviderApiError } from "../errors";
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
  DoAccount,
  DoAction,
  DoCreateDropletBody,
  DoCreateDropletResponse,
  DoCreateFirewallBody,
  DoDroplet,
  DoFirewall,
  DoImage,
  DoLinks,
  DoRegion,
  DoSize,
  DoSshKey,
} from "./types";

/** Default API base URL. */
export const DIGITALOCEAN_API_URL = "https://api.digitalocean.com/v2";

/** Largest page size the API accepts. */
export const DIGITALOCEAN_MAX_PER_PAGE = 200;

/**
 * Write scopes probed by `validateToken`, with the request that exercises
 * each. Every body is invalid, so a token holding the scope gets a
 * validation error and nothing is created.
 */
const WRITE_PROBES: { scope: string; path: string; body: unknown }[] = [
  { scope: "droplet:create", path: "/droplets", body: {} },
  { scope: "firewall:create", path: "/firewalls", body: {} },
  { scope: "tag:create", path: "/tags", body: { name: "" } },
];

/** Options for {@link DigitalOceanClient}. */
export interface DigitalOceanClientOptions extends TransportOptions {
  /** Personal access token (`dop_v1_…`). */
  token: string;
  /** API base URL. Defaults to {@link DIGITALOCEAN_API_URL}. */
  baseUrl?: string;
}

const CODES: Record<string, ApiErrorCode> = {
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  not_found: "not_found",
  too_many_requests: "rate_limited",
  bad_request: "invalid_input",
  unprocessable_entity: "invalid_input",
  conflict: "conflict",
  server_error: "unavailable",
  service_unavailable: "unavailable",
};

function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 400 || status === 422) return "invalid_input";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "unknown";
}

/**
 * Maps a DigitalOcean error response to a {@link ProviderApiError}.
 *
 * DigitalOcean reports quota and duplicate problems as
 * `422 unprocessable_entity` with only a message to tell them apart, so the
 * message refines the code: droplet or resource limits become
 * `quota_exceeded`, and "already in use/exists" becomes `conflict`.
 *
 * @param status - HTTP status.
 * @param text - Raw body.
 * @returns The error.
 */
export function parseDigitalOceanError(status: number, text: string): ProviderApiError {
  let providerCode = `http_${status}`;
  let message = text.slice(0, 200) || "empty response";
  try {
    const body = JSON.parse(text) as { id?: unknown; message?: unknown; error?: unknown };
    if (typeof body.id === "string") {
      providerCode = body.id;
      message = String(body.message ?? "");
    } else if (typeof body.error === "string") {
      message = body.error;
    }
  } catch {
    // Non-JSON bodies keep http_<status>.
  }
  let code = CODES[providerCode] ?? codeForStatus(status);
  if (code === "invalid_input" && /\blimit\b/i.test(message)) code = "quota_exceeded";
  else if (code === "invalid_input" && /already (in use|exists)/i.test(message)) code = "conflict";
  return new ProviderApiError({ provider: "digitalocean", status, code, providerCode, message });
}

/**
 * DigitalOcean API v2 client.
 *
 * @example
 * const doc = new DigitalOceanClient({ token });
 * const sizes = await doc.listSizes();
 */
export class DigitalOceanClient {
  /** The shared HTTP core; exposes `rateLimit`, `sleep`, and `now`. */
  readonly http: HttpClient;

  /**
   * @param options - Token and tuning.
   * @throws TypeError when the token is empty or contains whitespace.
   */
  constructor(options: DigitalOceanClientOptions) {
    const token = options.token?.trim() ?? "";
    if (!token || /\s/.test(token)) {
      throw new TypeError("DigitalOcean API token is empty or malformed");
    }
    this.http = new HttpClient({
      ...options,
      provider: "digitalocean",
      baseUrl: options.baseUrl ?? DIGITALOCEAN_API_URL,
      headers: { authorization: `Bearer ${token}` },
      parseError: parseDigitalOceanError,
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
   * Collects every item of a list endpoint, 200 per page.
   *
   * @param path - List endpoint, e.g. `/droplets`.
   * @param key - Array property, e.g. `droplets`.
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
      const res = await this.http.request<Record<string, unknown> & { links?: DoLinks }>(
        "GET",
        path,
        {
          ...options,
          query: { ...query, page, per_page: DIGITALOCEAN_MAX_PER_PAGE },
        },
      );
      const items = Array.isArray(res[key]) ? (res[key] as T[]) : [];
      return { items, next: res.links?.pages?.next ? nextPage(res.links.pages.next, page) : null };
    });
  }

  /**
   * Checks a token without side effects:
   * 1. `GET /account`: `401` means invalid; `403` means valid without
   *    `account:read`.
   * 2. One invalid `POST` per write scope provisioning needs. A token
   *    without the scope gets `403`; one with it gets a validation error.
   *
   * @param options - Signal and timeout.
   * @returns Validity, write access, missing scopes, and the account.
   * @throws ProviderApiError for unexpected failures.
   */
  async validateToken(options: RequestOptions = {}): Promise<TokenCheck> {
    let account: DoAccount | undefined;
    try {
      account = (await this.http.request<{ account: DoAccount }>("GET", "/account", options))
        .account;
    } catch (e) {
      if (!(e instanceof ProviderApiError)) throw e;
      if (e.code === "unauthorized") return { valid: false, canWrite: false };
      if (e.code !== "forbidden") throw e;
    }
    const missing: string[] = [];
    for (const probe of WRITE_PROBES) {
      try {
        await this.http.request("POST", probe.path, { ...options, body: probe.body });
      } catch (e) {
        if (!(e instanceof ProviderApiError)) throw e;
        if (e.code === "unauthorized") return { valid: false, canWrite: false };
        if (e.code === "forbidden") missing.push(probe.scope);
        else if (e.status < 400 || e.status >= 500) throw e;
      }
    }
    return {
      valid: true,
      canWrite: missing.length === 0,
      ...(missing.length ? { missing } : {}),
      ...(account
        ? {
            account: {
              id: account.uuid,
              email: account.email,
              name: account.team?.name ?? account.name,
            },
          }
        : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Catalogue
  // ---------------------------------------------------------------------------

  /** @returns Every size, including unavailable ones. */
  listSizes(options: RequestOptions = {}): Promise<DoSize[]> {
    return this.listAll("/sizes", "sizes", {}, options);
  }

  /** @returns Every region. */
  listRegions(options: RequestOptions = {}): Promise<DoRegion[]> {
    return this.listAll("/regions", "regions", {}, options);
  }

  /** @returns Public distribution images. */
  listDistributionImages(options: RequestOptions = {}): Promise<DoImage[]> {
    return this.listAll("/images", "images", { type: "distribution" }, options);
  }

  // ---------------------------------------------------------------------------
  // Tags, SSH keys, firewalls
  // ---------------------------------------------------------------------------

  /**
   * Creates a tag if it does not exist. Firewalls can only target existing
   * tags.
   *
   * @param name - Tag name.
   * @param options - Signal and timeout.
   */
  async ensureTag(name: string, options: RequestOptions = {}): Promise<void> {
    try {
      await this.http.request("POST", "/tags", { ...options, body: { name } });
    } catch (e) {
      if (!(e instanceof ProviderApiError && e.code === "conflict")) throw e;
    }
  }

  /**
   * Lists SSH keys. The endpoint is limited to 10 requests per minute.
   *
   * @param options - Signal and timeout.
   * @returns Every key on the account.
   */
  listSshKeys(options: RequestOptions = {}): Promise<DoSshKey[]> {
    return this.listAll("/account/keys", "ssh_keys", {}, options);
  }

  /**
   * Uploads a public key.
   *
   * @param body - Name and key.
   * @param options - Signal and timeout.
   * @returns The key.
   */
  async createSshKey(
    body: { name: string; public_key: string },
    options: RequestOptions = {},
  ): Promise<DoSshKey> {
    return (
      await this.http.request<{ ssh_key: DoSshKey }>("POST", "/account/keys", { ...options, body })
    ).ssh_key;
  }

  /** @returns Every firewall. */
  listFirewalls(options: RequestOptions = {}): Promise<DoFirewall[]> {
    return this.listAll("/firewalls", "firewalls", {}, options);
  }

  /**
   * Gets a firewall.
   *
   * @param id - Firewall UUID.
   * @param options - Signal and timeout.
   * @returns The firewall.
   */
  async getFirewall(id: string, options: RequestOptions = {}): Promise<DoFirewall> {
    return (
      await this.http.request<{ firewall: DoFirewall }>(
        "GET",
        `/firewalls/${encodeURIComponent(id)}`,
        options,
      )
    ).firewall;
  }

  /**
   * Creates a firewall.
   *
   * @param body - Name, rules, and tags.
   * @param options - Signal and timeout.
   * @returns The firewall.
   */
  async createFirewall(
    body: DoCreateFirewallBody,
    options: RequestOptions = {},
  ): Promise<DoFirewall> {
    return (
      await this.http.request<{ firewall: DoFirewall }>("POST", "/firewalls", { ...options, body })
    ).firewall;
  }

  // ---------------------------------------------------------------------------
  // Droplets
  // ---------------------------------------------------------------------------

  /**
   * Lists droplets by one tag or one exact (case-insensitive) name. The API
   * cannot combine the two filters.
   *
   * @param filter - `tag` or `name`.
   * @param options - Signal and timeout.
   * @returns Matching droplets.
   */
  listDroplets(
    filter: { tag?: string; name?: string } = {},
    options: RequestOptions = {},
  ): Promise<DoDroplet[]> {
    return this.listAll(
      "/droplets",
      "droplets",
      { tag_name: filter.tag, name: filter.name },
      options,
    );
  }

  /**
   * Gets a droplet.
   *
   * @param id - Droplet ID.
   * @param options - Signal and timeout.
   * @returns The droplet.
   * @throws ProviderApiError `not_found`.
   */
  async getDroplet(id: number, options: RequestOptions = {}): Promise<DoDroplet> {
    return (await this.http.request<{ droplet: DoDroplet }>("GET", `/droplets/${id}`, options))
      .droplet;
  }

  /**
   * Creates a droplet. Answers `202`; track it with the returned action.
   *
   * @param body - Droplet spec.
   * @param options - Signal and timeout.
   * @returns The droplet and its create action.
   */
  createDroplet(
    body: DoCreateDropletBody,
    options: RequestOptions = {},
  ): Promise<DoCreateDropletResponse> {
    return this.http.request("POST", "/droplets", { ...options, body });
  }

  /**
   * Deletes one droplet by ID.
   *
   * WARNING: `DELETE /droplets?tag_name=` deletes every droplet with the tag;
   * this client never sends it.
   *
   * @param id - Droplet ID.
   * @param options - Signal and timeout.
   */
  async deleteDroplet(id: number, options: RequestOptions = {}): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new RangeError(`invalid droplet ID ${id}`);
    await this.http.request("DELETE", `/droplets/${id}`, options);
  }

  /**
   * Polls an action until it completes.
   *
   * @param id - Action ID.
   * @param options - Interval, timeout, and signal.
   * @returns The completed action.
   * @throws ProviderActionError when it errors or times out.
   */
  async waitForAction(id: number, options: PollOptions = {}): Promise<DoAction> {
    const action = await pollUntil(
      this.http,
      async () => {
        const a = (
          await this.http.request<{ action: DoAction }>("GET", `/actions/${id}`, {
            signal: options.signal,
          })
        ).action;
        return a.status === "in-progress" ? undefined : a;
      },
      {
        ...options,
        onTimeout: () =>
          new ProviderActionError(
            "digitalocean",
            String(id),
            "create",
            "action_timeout",
            "did not finish in time",
          ),
      },
    );
    if (action.status === "errored") {
      throw new ProviderActionError(
        "digitalocean",
        String(id),
        action.type,
        "errored",
        "action errored",
      );
    }
    return action;
  }
}

/** Page number of a `links.pages.next` URL, or `current + 1` if it has none. */
function nextPage(next: string, current: number): number | null {
  let page = current + 1;
  try {
    const n = Number(new URL(next).searchParams.get("page"));
    if (Number.isSafeInteger(n) && n > 0) page = n;
  } catch {
    // A relative or malformed link still means "there is a next page".
  }
  return page > current ? page : null;
}
