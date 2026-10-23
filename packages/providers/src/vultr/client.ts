/**
 * Typed Vultr API v2 client, on the shared HTTP core.
 *
 * Responsibilities:
 * - Bearer authentication and error mapping (`{error, status}`).
 * - Cursor pagination: `per_page` (max 500) and `cursor` from
 *   `meta.links.next`, which is `""` on the last page. `meta.total` is not
 *   trusted.
 * - Rate limiting: Vultr documents 30 requests per second per IP and a
 *   `Retry-After` header on `429`, which the core honours. The undocumented
 *   `X-RateLimit-*` headers are ignored.
 * - Token validation from the owning user's ACLs; Vultr keys have no scopes
 *   of their own.
 *
 * @module
 */
import { type ApiErrorCode, ProviderApiError } from "../errors";
import {
  collect,
  HttpClient,
  type Query,
  type RequestOptions,
  type TransportOptions,
} from "../http";
import type { TokenCheck } from "../provider";
import type {
  VultrAccount,
  VultrCreateInstanceBody,
  VultrCreateRuleBody,
  VultrFirewallGroup,
  VultrFirewallRule,
  VultrInstance,
  VultrMeta,
  VultrOs,
  VultrPlan,
  VultrRegion,
  VultrSshKey,
} from "./types";

/** Default API base URL. */
export const VULTR_API_URL = "https://api.vultr.com/v2";

/** Largest page size the API accepts. */
export const VULTR_MAX_PER_PAGE = 500;

/**
 * ACLs a sub-user needs to provision: deploy (`provisioning`), manage and
 * destroy instances (`subscriptions`), and firewall groups (`firewall`).
 * Vultr lists the ACL names but not what each endpoint requires, so this is
 * the narrowest set that plausibly covers the calls.
 */
export const VULTR_REQUIRED_ACLS = ["provisioning", "subscriptions", "firewall"] as const;

/** Options for {@link VultrClient}. */
export interface VultrClientOptions extends TransportOptions {
  /** Vultr API key. */
  token: string;
  /** API base URL. Defaults to {@link VULTR_API_URL}. */
  baseUrl?: string;
}

function codeForStatus(status: number, message: string): ApiErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  if (status === 400 || status === 422) {
    if (/\b(limit|quota|exceed)/i.test(message)) return "quota_exceeded";
    if (/already exists|duplicate/i.test(message)) return "conflict";
    return "invalid_input";
  }
  return "unknown";
}

/**
 * Maps a Vultr error response to a {@link ProviderApiError}. Vultr has no
 * machine-readable error codes, so `providerCode` is `http_<status>` and the
 * message refines `invalid_input` into quota or conflict errors.
 *
 * @param status - HTTP status.
 * @param text - Raw body.
 * @returns The error.
 */
export function parseVultrError(status: number, text: string): ProviderApiError {
  let message = text.slice(0, 200) || "empty response";
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // Non-JSON bodies keep the raw text.
  }
  return new ProviderApiError({
    provider: "vultr",
    status,
    code: codeForStatus(status, message),
    providerCode: `http_${status}`,
    message,
  });
}

/**
 * Vultr API v2 client.
 *
 * @example
 * const vultr = new VultrClient({ token });
 * const plans = await vultr.listPlans();
 */
export class VultrClient {
  /** The shared HTTP core; exposes `sleep` and `now`. */
  readonly http: HttpClient;

  /**
   * @param options - Token and tuning.
   * @throws TypeError when the token is empty or contains whitespace.
   */
  constructor(options: VultrClientOptions) {
    const token = options.token?.trim() ?? "";
    if (!token || /\s/.test(token)) throw new TypeError("Vultr API key is empty or malformed");
    this.http = new HttpClient({
      ...options,
      provider: "vultr",
      baseUrl: options.baseUrl ?? VULTR_API_URL,
      headers: { authorization: `Bearer ${token}` },
      parseError: parseVultrError,
    });
  }

  /**
   * Collects every item of a list endpoint, following cursors.
   *
   * @param path - List endpoint, e.g. `/instances`.
   * @param key - Array property, e.g. `instances`.
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
    return collect<T, string>(path, "", async (cursor) => {
      const res = await this.http.request<Record<string, unknown> & { meta?: VultrMeta }>(
        "GET",
        path,
        {
          ...options,
          query: { ...query, per_page: VULTR_MAX_PER_PAGE, cursor: cursor || undefined },
        },
      );
      const items = Array.isArray(res[key]) ? (res[key] as T[]) : [];
      const next = res.meta?.links?.next;
      return { items, next: next ? next : null };
    });
  }

  /**
   * Checks a key with `GET /account`, which every key can call:
   * - `401` means invalid.
   * - The owning user's `acls` decide write access. A root user's key lists
   *   `manage_users`; a sub-user needs {@link VULTR_REQUIRED_ACLS}.
   *
   * @param options - Signal and timeout.
   * @returns Validity, write access, missing ACLs, and the account.
   */
  async validateToken(options: RequestOptions = {}): Promise<TokenCheck> {
    let account: VultrAccount;
    try {
      account = (await this.http.request<{ account: VultrAccount }>("GET", "/account", options))
        .account;
    } catch (e) {
      if (e instanceof ProviderApiError && e.code === "unauthorized") {
        return { valid: false, canWrite: false };
      }
      throw e;
    }
    const acls = account.acls ?? [];
    // NOTE: an empty list is treated as the account owner, whose key is not
    // restricted by sub-user ACLs.
    const unrestricted = acls.length === 0 || acls.includes("manage_users");
    const missing = unrestricted ? [] : VULTR_REQUIRED_ACLS.filter((a) => !acls.includes(a));
    return {
      valid: true,
      canWrite: missing.length === 0,
      ...(missing.length ? { missing } : {}),
      account: { email: account.email, name: account.name },
    };
  }

  // ---------------------------------------------------------------------------
  // Catalogue
  // ---------------------------------------------------------------------------

  /** @returns Every cloud plan (`type=all`). */
  listPlans(options: RequestOptions = {}): Promise<VultrPlan[]> {
    return this.listAll("/plans", "plans", { type: "all" }, options);
  }

  /** @returns Every region. */
  listRegions(options: RequestOptions = {}): Promise<VultrRegion[]> {
    return this.listAll("/regions", "regions", {}, options);
  }

  /** @returns Every operating system. */
  listOs(options: RequestOptions = {}): Promise<VultrOs[]> {
    return this.listAll("/os", "os", {}, options);
  }

  // ---------------------------------------------------------------------------
  // SSH keys and firewall groups
  // ---------------------------------------------------------------------------

  /** @returns Every SSH key. */
  listSshKeys(options: RequestOptions = {}): Promise<VultrSshKey[]> {
    return this.listAll("/ssh-keys", "ssh_keys", {}, options);
  }

  /**
   * Uploads a public key.
   *
   * @param body - Name and key.
   * @param options - Signal and timeout.
   * @returns The key.
   */
  async createSshKey(
    body: { name: string; ssh_key: string },
    options: RequestOptions = {},
  ): Promise<VultrSshKey> {
    return (
      await this.http.request<{ ssh_key: VultrSshKey }>("POST", "/ssh-keys", { ...options, body })
    ).ssh_key;
  }

  /** @returns Every firewall group. */
  listFirewallGroups(options: RequestOptions = {}): Promise<VultrFirewallGroup[]> {
    return this.listAll("/firewalls", "firewall_groups", {}, options);
  }

  /**
   * Creates an empty firewall group.
   *
   * @param description - Its only identifying field.
   * @param options - Signal and timeout.
   * @returns The group.
   */
  async createFirewallGroup(
    description: string,
    options: RequestOptions = {},
  ): Promise<VultrFirewallGroup> {
    return (
      await this.http.request<{ firewall_group: VultrFirewallGroup }>("POST", "/firewalls", {
        ...options,
        body: { description },
      })
    ).firewall_group;
  }

  /**
   * Renames a firewall group.
   *
   * @param id - Group ID.
   * @param description - New description.
   * @param options - Signal and timeout.
   */
  async updateFirewallGroup(
    id: string,
    description: string,
    options: RequestOptions = {},
  ): Promise<void> {
    await this.http.request("PUT", `/firewalls/${encodeURIComponent(id)}`, {
      ...options,
      body: { description },
    });
  }

  /**
   * Deletes a firewall group.
   *
   * @param id - Group ID.
   * @param options - Signal and timeout.
   */
  async deleteFirewallGroup(id: string, options: RequestOptions = {}): Promise<void> {
    await this.http.request("DELETE", `/firewalls/${encodeURIComponent(id)}`, options);
  }

  /**
   * Adds a rule to a group.
   *
   * @param groupId - Group ID.
   * @param body - Rule.
   * @param options - Signal and timeout.
   * @returns The rule.
   */
  async createFirewallRule(
    groupId: string,
    body: VultrCreateRuleBody,
    options: RequestOptions = {},
  ): Promise<VultrFirewallRule> {
    return (
      await this.http.request<{ firewall_rule: VultrFirewallRule }>(
        "POST",
        `/firewalls/${encodeURIComponent(groupId)}/rules`,
        { ...options, body },
      )
    ).firewall_rule;
  }

  // ---------------------------------------------------------------------------
  // Instances
  // ---------------------------------------------------------------------------

  /**
   * Lists instances by one exact tag or label.
   *
   * @param filter - `tag` and/or `label`.
   * @param options - Signal and timeout.
   * @returns Matching instances.
   */
  listInstances(
    filter: { tag?: string; label?: string } = {},
    options: RequestOptions = {},
  ): Promise<VultrInstance[]> {
    return this.listAll(
      "/instances",
      "instances",
      { tag: filter.tag, label: filter.label },
      options,
    );
  }

  /**
   * Gets an instance.
   *
   * @param id - Instance UUID.
   * @param options - Signal and timeout.
   * @returns The instance.
   * @throws ProviderApiError `not_found`.
   */
  async getInstance(id: string, options: RequestOptions = {}): Promise<VultrInstance> {
    return (
      await this.http.request<{ instance: VultrInstance }>(
        "GET",
        `/instances/${encodeURIComponent(id)}`,
        options,
      )
    ).instance;
  }

  /**
   * Creates an instance. Answers `202` while it deploys.
   *
   * @param body - Instance spec.
   * @param options - Signal and timeout.
   * @returns The pending instance, including `default_password`.
   */
  async createInstance(
    body: VultrCreateInstanceBody,
    options: RequestOptions = {},
  ): Promise<VultrInstance> {
    return (
      await this.http.request<{ instance: VultrInstance }>("POST", "/instances", {
        ...options,
        body,
      })
    ).instance;
  }

  /**
   * Deletes an instance.
   *
   * @param id - Instance UUID.
   * @param options - Signal and timeout.
   */
  async deleteInstance(id: string, options: RequestOptions = {}): Promise<void> {
    await this.http.request("DELETE", `/instances/${encodeURIComponent(id)}`, options);
  }
}
