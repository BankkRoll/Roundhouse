/**
 * Typed Linode (Akamai) API v4 client, on the shared HTTP core.
 *
 * Responsibilities:
 * - Bearer authentication and error mapping (`{errors:[{field,reason}]}`).
 * - Page-based pagination (`page`, `page_size` 25-500) and `X-Filter`
 *   filtering.
 * - Rate limiting from `X-RateLimit-*` headers, which describe a fixed
 *   per-operation window (`X-RateLimit-Reset` in epoch seconds); limits
 *   differ per endpoint, so they are read, not hard-coded.
 * - Token validation from the `X-OAuth-Scopes` response header.
 *
 * @module
 */
import { type ApiErrorCode, ProviderApiError } from "../errors";
import { collect, HttpClient, type RequestOptions, type TransportOptions } from "../http";
import type { TokenCheck } from "../provider";
import type {
  Linode,
  LinodeCreateBody,
  LinodeCreateFirewallBody,
  LinodeFirewall,
  LinodeImage,
  LinodePage,
  LinodeProfile,
  LinodeRegion,
  LinodeType,
} from "./types";

/** Default API base URL. */
export const LINODE_API_URL = "https://api.linode.com/v4";

/** Largest page size the API accepts. */
export const LINODE_MAX_PAGE_SIZE = 500;

/**
 * OAuth scopes provisioning needs: create and delete Linodes, create
 * firewalls, and list images (public images are listed with the token).
 */
export const LINODE_REQUIRED_SCOPES = [
  "linodes:read_write",
  "firewall:read_write",
  "images:read_only",
] as const;

/** Options for {@link LinodeClient}. */
export interface LinodeClientOptions extends TransportOptions {
  /** Personal access token. */
  token: string;
  /** API base URL. Defaults to {@link LINODE_API_URL}. */
  baseUrl?: string;
}

function codeForStatus(status: number, reason: string): ApiErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  if (status === 400 || status === 422) {
    if (/\b(limit|quota|exceed)/i.test(reason)) return "quota_exceeded";
    if (/unique|already (in use|exists)/i.test(reason)) return "conflict";
    return "invalid_input";
  }
  return "unknown";
}

/**
 * Maps a Linode error response to a {@link ProviderApiError}. Linode has no
 * error codes, so `providerCode` is the first error's `field` (or
 * `http_<status>`) and the reason refines `invalid_input`.
 *
 * @param status - HTTP status.
 * @param text - Raw body.
 * @returns The error.
 */
export function parseLinodeError(status: number, text: string): ProviderApiError {
  let reason = text.slice(0, 200) || "empty response";
  let field: string | null = null;
  let details: unknown = null;
  try {
    const body = JSON.parse(text) as { errors?: { field?: string | null; reason?: unknown }[] };
    if (Array.isArray(body.errors) && body.errors[0]) {
      reason = body.errors.map((e) => String(e.reason ?? "")).join("; ");
      field = body.errors[0].field ?? null;
      details = body.errors;
    }
  } catch {
    // Non-JSON bodies keep the raw text.
  }
  return new ProviderApiError({
    provider: "linode",
    status,
    code: codeForStatus(status, reason),
    providerCode: field ?? `http_${status}`,
    message: reason,
    details,
  });
}

/**
 * Parses an `X-OAuth-Scopes` value.
 *
 * @param header - Space-separated scopes, `*`, or `null`.
 * @returns The scopes, `["*"]` for every scope, or `null` when absent or `unknown`.
 */
export function parseScopes(header: string | null): string[] | null {
  if (header === null) return null;
  const scopes = header.split(/[\s,]+/).filter(Boolean);
  if (scopes.length === 0 || scopes.includes("unknown")) return null;
  return scopes;
}

/**
 * Whether granted scopes cover a required one. `read_write` implies
 * `read_only`, and `*` grants everything.
 *
 * @param granted - Token scopes.
 * @param required - E.g. `images:read_only`.
 * @returns `true` when covered.
 */
export function hasScope(granted: readonly string[], required: string): boolean {
  if (granted.includes("*") || granted.includes(required)) return true;
  const [area, level] = required.split(":");
  return level === "read_only" && granted.includes(`${area}:read_write`);
}

/**
 * Linode API v4 client.
 *
 * @example
 * const linode = new LinodeClient({ token });
 * const types = await linode.listTypes();
 */
export class LinodeClient {
  /** The shared HTTP core; exposes `rateLimit`, `sleep`, and `now`. */
  readonly http: HttpClient;

  /**
   * @param options - Token and tuning.
   * @throws TypeError when the token is empty or contains whitespace.
   */
  constructor(options: LinodeClientOptions) {
    const token = options.token?.trim() ?? "";
    if (!token || /\s/.test(token)) throw new TypeError("Linode API token is empty or malformed");
    this.http = new HttpClient({
      ...options,
      provider: "linode",
      baseUrl: options.baseUrl ?? LINODE_API_URL,
      headers: { authorization: `Bearer ${token}` },
      parseError: parseLinodeError,
      rateLimit: {
        limitHeader: "x-ratelimit-limit",
        remainingHeader: "x-ratelimit-remaining",
        resetHeader: "x-ratelimit-reset",
        resetUnit: "epoch-seconds",
        windowMs: 60_000,
        refill: "window",
      },
    });
  }

  /**
   * Collects every item of a list endpoint, 500 per page.
   *
   * @param path - List endpoint, e.g. `/linode/instances`.
   * @param filter - `X-Filter` object, e.g. `{ tags: "x" }`.
   * @param options - Signal and timeout.
   * @returns All items.
   */
  listAll<T>(
    path: string,
    filter: Record<string, unknown> | null = null,
    options: RequestOptions = {},
  ): Promise<T[]> {
    return collect<T, number>(path, 1, async (page) => {
      const res = await this.http.request<LinodePage<T>>("GET", path, {
        ...options,
        query: { page, page_size: LINODE_MAX_PAGE_SIZE },
        headers: filter ? { "x-filter": JSON.stringify(filter) } : undefined,
      });
      return { items: res.data ?? [], next: res.page < res.pages ? res.page + 1 : null };
    });
  }

  /**
   * Checks a token with `GET /profile`, which every token can call:
   * - `401` means invalid.
   * - `X-OAuth-Scopes` lists the token's scopes; any of
   *   {@link LINODE_REQUIRED_SCOPES} missing means it cannot provision.
   * - A restricted user cannot tag Linodes, and tags carry the managed
   *   labels, so a restricted user cannot provision either.
   * Without the header, an invalid `POST /linode/instances` probes the
   * create scope: `403` without it, a validation error with it.
   *
   * @param options - Signal and timeout.
   * @returns Validity, write access, missing scopes, and the account.
   */
  async validateToken(options: RequestOptions = {}): Promise<TokenCheck> {
    let res: { body: LinodeProfile; headers: Headers };
    try {
      res = await this.http.send<LinodeProfile>("GET", "/profile", options);
    } catch (e) {
      if (e instanceof ProviderApiError && e.code === "unauthorized") {
        return { valid: false, canWrite: false };
      }
      throw e;
    }
    const profile = res.body;
    const account = { id: String(profile.uid), email: profile.email, name: profile.username };
    const missing: string[] = [];
    const scopes = parseScopes(res.headers.get("x-oauth-scopes"));
    if (scopes) {
      missing.push(...LINODE_REQUIRED_SCOPES.filter((s) => !hasScope(scopes, s)));
    } else {
      try {
        await this.http.request("POST", "/linode/instances", { ...options, body: {} });
      } catch (e) {
        if (!(e instanceof ProviderApiError)) throw e;
        if (e.code === "forbidden") missing.push("linodes:read_write");
        else if (e.status < 400 || e.status >= 500) throw e;
      }
    }
    if (profile.restricted) missing.push("unrestricted user (restricted users cannot tag Linodes)");
    return {
      valid: true,
      canWrite: missing.length === 0,
      ...(missing.length ? { missing } : {}),
      account,
    };
  }

  // ---------------------------------------------------------------------------
  // Catalogue
  // ---------------------------------------------------------------------------

  /** @returns Every Linode type. */
  listTypes(options: RequestOptions = {}): Promise<LinodeType[]> {
    return this.listAll("/linode/types", null, options);
  }

  /** @returns Every region. */
  listRegions(options: RequestOptions = {}): Promise<LinodeRegion[]> {
    return this.listAll("/regions", null, options);
  }

  /**
   * Lists public images. The endpoint is limited to 20 requests per minute.
   *
   * @param options - Signal and timeout.
   * @returns Public images.
   */
  listPublicImages(options: RequestOptions = {}): Promise<LinodeImage[]> {
    return this.listAll("/images", { is_public: true }, options);
  }

  // ---------------------------------------------------------------------------
  // Firewalls
  // ---------------------------------------------------------------------------

  /**
   * Lists firewalls.
   *
   * @param filter - `X-Filter`, e.g. `{ label: "x" }`.
   * @param options - Signal and timeout.
   * @returns Matching firewalls.
   */
  listFirewalls(
    filter: Record<string, unknown> | null = null,
    options: RequestOptions = {},
  ): Promise<LinodeFirewall[]> {
    return this.listAll("/networking/firewalls", filter, options);
  }

  /**
   * Creates a firewall.
   *
   * @param body - Label, rules, and tags.
   * @param options - Signal and timeout.
   * @returns The firewall.
   * @throws ProviderApiError `conflict` when the label is taken.
   */
  createFirewall(
    body: LinodeCreateFirewallBody,
    options: RequestOptions = {},
  ): Promise<LinodeFirewall> {
    return this.http.request("POST", "/networking/firewalls", { ...options, body });
  }

  // ---------------------------------------------------------------------------
  // Linodes
  // ---------------------------------------------------------------------------

  /**
   * Lists Linodes.
   *
   * @param filter - `X-Filter`, e.g. `{ tags: "x" }` or `{ label: "x" }`.
   * @param options - Signal and timeout.
   * @returns Matching Linodes.
   */
  listLinodes(
    filter: Record<string, unknown> | null = null,
    options: RequestOptions = {},
  ): Promise<Linode[]> {
    return this.listAll("/linode/instances", filter, options);
  }

  /**
   * Gets a Linode.
   *
   * @param id - Linode ID.
   * @param options - Signal and timeout.
   * @returns The Linode.
   * @throws ProviderApiError `not_found`.
   */
  getLinode(id: number, options: RequestOptions = {}): Promise<Linode> {
    return this.http.request("GET", `/linode/instances/${id}`, options);
  }

  /**
   * Creates a Linode. The create endpoint is limited to 20 requests per 15 s.
   *
   * @param body - Linode spec.
   * @param options - Signal and timeout.
   * @returns The Linode, usually `provisioning`.
   */
  createLinode(body: LinodeCreateBody, options: RequestOptions = {}): Promise<Linode> {
    return this.http.request("POST", "/linode/instances", { ...options, body });
  }

  /**
   * Deletes a Linode.
   *
   * @param id - Linode ID.
   * @param options - Signal and timeout.
   */
  async deleteLinode(id: number, options: RequestOptions = {}): Promise<void> {
    await this.http.request("DELETE", `/linode/instances/${id}`, options);
  }
}
