/**
 * Custom domains (ADR 0009, direct mode): the lifecycle vocabulary, the DNS
 * records a customer creates, and the hostname rules the API enforces and
 * the dashboard previews.
 *
 * - {@link DOMAIN_STATUSES}: `pending_dns → pending_verification → issuing → active`, or `failed`.
 * - {@link normalizeHostname} / {@link customHostnameProblem}: what may be added.
 * - {@link ownershipRecordName} / {@link ownershipRecordValue}: the TXT that proves ownership.
 * - {@link nextCheckDelayMs}: the re-check schedule.
 *
 * @module
 */
import { MAX_DNS_LABEL_LENGTH, MAX_HOSTNAME_LENGTH } from "./hostnames";

/**
 * Where a domain is in its lifecycle. Only `verified` domains are routed;
 * `issuing` and `active` imply verification passed.
 */
export const DOMAIN_STATUSES = [
  "pending_dns",
  "pending_verification",
  "issuing",
  "active",
  "failed",
] as const;

/** A domain lifecycle state; see {@link DOMAIN_STATUSES}. */
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

/**
 * How the control plane serves a custom domain: `direct` (DNS points at the
 * ingress servers) or `cloudflare_saas` (a Cloudflare for SaaS custom
 * hostname in front of them, ADR 0009).
 */
export const DOMAIN_MODES = ["direct", "cloudflare_saas"] as const;

/** Hostnames a Cloudflare for SaaS plan includes before per-hostname billing starts. */
export const SAAS_INCLUDED_HOSTNAMES = 100;

/** A custom-domain mode; see {@link DOMAIN_MODES}. */
export type DomainMode = (typeof DOMAIN_MODES)[number];

/** DNS record types the customer is asked to create. */
export const DNS_RECORD_TYPES = ["CNAME", "A", "AAAA", "TXT"] as const;

/** A DNS record type; see {@link DNS_RECORD_TYPES}. */
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

/**
 * Why a record is needed: routing to the install, proving ownership, (for
 * a wildcard) delegating `_acme-challenge` so the control plane can answer
 * DNS-01 for it, or (Cloudflare for SaaS) Cloudflare's own hostname and
 * certificate validation.
 */
export const DNS_RECORD_PURPOSES = ["routing", "ownership", "acme_delegation", "cf_dcv"] as const;

/** A record's purpose; see {@link DNS_RECORD_PURPOSES}. */
export type DnsRecordPurpose = (typeof DNS_RECORD_PURPOSES)[number];

/**
 * What the last check saw for a record: `unknown` before the first check,
 * `wrong` when it exists but points elsewhere or holds another value.
 */
export const DNS_RECORD_STATES = ["unknown", "ok", "missing", "wrong"] as const;

/** A record's observed state; see {@link DNS_RECORD_STATES}. */
export type DnsRecordState = (typeof DNS_RECORD_STATES)[number];

/** What one DNS check of a custom domain saw, stored as `domains.dns_observed`. */
export interface DomainDnsObservation {
  /** CNAME chain from the hostname, in order. */
  cname: string[];
  /** Final A and AAAA answers. */
  addresses: string[];
  /** TXT values at the ownership name, chunks joined. */
  txt: string[];
  /** Wildcards only: the CNAME target(s) of `_acme-challenge.<base>`. */
  acme_delegation?: string[];
  /** Set when no resolver answered, so the states above are stale rather than "missing". */
  resolver_error?: string;
}

/** Label under the custom hostname that carries the ownership TXT. */
export const OWNERSHIP_RECORD_LABEL = "_roundhouse";

/** Prefix of the ownership TXT value. */
export const OWNERSHIP_VALUE_PREFIX = "rh-verify=";

/** A domain not verified this long after it was added (or re-checked) becomes `failed`. */
export const DOMAIN_VERIFY_WINDOW_MS = 72 * 60 * 60 * 1000;

/** A hostname `failed` this long may be claimed by another service or workspace. */
export const DOMAIN_TAKEOVER_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Most custom domains one service may have in one environment. */
export const MAX_CUSTOM_DOMAINS_PER_SERVICE = 20;

/** Delays between checks of an unverified domain, then hourly (ADR 0009 "Checks"). */
export const DOMAIN_CHECK_SCHEDULE_MS = [1, 2, 5, 10, 30].map((m) => m * 60_000);

/** How often a verified domain's records are looked at again. */
export const VERIFIED_RECHECK_MS = 24 * 60 * 60 * 1000;

const HOURLY = 60 * 60 * 1000;

/**
 * Delay before the next scheduled check of an unverified domain.
 *
 * @param attempts - Checks already made, the one just finished included.
 * @returns Milliseconds: 1, 2, 5, 10 and 30 minutes, then an hour.
 * @example
 * nextCheckDelayMs(1); // 60_000
 * nextCheckDelayMs(9); // 3_600_000
 */
export function nextCheckDelayMs(attempts: number): number {
  return DOMAIN_CHECK_SCHEDULE_MS[Math.max(0, attempts - 1)] ?? HOURLY;
}

/**
 * Name of the ownership TXT record for a hostname.
 *
 * A wildcard proves ownership at its base name: `_roundhouse.*.example.com`
 * can't be created in most DNS providers, and whoever controls
 * `example.com`'s zone controls every name under it anyway.
 *
 * @param hostname - The custom hostname.
 * @returns E.g. `_roundhouse.shop.example.com`; `_roundhouse.example.com` for `*.example.com`.
 */
export function ownershipRecordName(hostname: string): string {
  return `${OWNERSHIP_RECORD_LABEL}.${wildcardBase(hostname)}`;
}

/**
 * Whether a hostname is a wildcard (`*.example.com`).
 *
 * @param hostname - A normalised hostname.
 * @returns `true` for a leading `*.` label.
 */
export function isWildcardHostname(hostname: string): boolean {
  return hostname.startsWith("*.");
}

/**
 * The name a wildcard covers the children of.
 *
 * @param hostname - A normalised hostname.
 * @returns `example.com` for `*.example.com`; any other name unchanged.
 */
export function wildcardBase(hostname: string): string {
  return isWildcardHostname(hostname) ? hostname.slice(2) : hostname;
}

/**
 * Name of the CNAME a wildcard's owner creates so the control plane can
 * answer DNS-01 challenges for it (ADR 0009, "DNS-01 delegation").
 *
 * @param hostname - A wildcard hostname.
 * @returns E.g. `_acme-challenge.example.com` for `*.example.com`.
 */
export function acmeDelegationName(hostname: string): string {
  return `_acme-challenge.${wildcardBase(hostname)}`;
}

/**
 * Target of {@link acmeDelegationName}: a name in the apps domain's zone,
 * which the control plane writes TXT records at through the Cloudflare DNS
 * API. Domain IDs are lowercased and their `_` replaced, since a hostname
 * label can't hold either.
 *
 * @param domainId - The domain's ID.
 * @param appsDomain - The install's apps domain.
 * @returns E.g. `dom-01j9z6….acme.apps.example.com`.
 */
export function acmeDelegationTarget(domainId: string, appsDomain: string): string {
  return `${domainId.toLowerCase().replace(/_/g, "-")}.acme.${appsDomain}`;
}

// -----------------------------------------------------------------------------
// HSTS
// -----------------------------------------------------------------------------

/** A custom domain's `Strict-Transport-Security` policy, stored as `domains.hsts`. */
export interface DomainHsts {
  enabled: boolean;
  /** Seconds; at most {@link MAX_HSTS_MAX_AGE_S}. */
  max_age: number;
  include_subdomains: boolean;
  preload: boolean;
}

/** One year: the default `max-age`, and the least the preload list accepts. */
export const HSTS_PRELOAD_MIN_MAX_AGE_S = 31_536_000;

/** Two years, as the protocol bounds a route's `max_age`. */
export const MAX_HSTS_MAX_AGE_S = 63_072_000;

/** What every HTTPS route gets unless its domain says otherwise (ADR 0009). */
export const DEFAULT_HSTS: DomainHsts = {
  enabled: true,
  max_age: HSTS_PRELOAD_MIN_MAX_AGE_S,
  include_subdomains: false,
  preload: false,
};

/**
 * Why an HSTS policy can't be saved for a hostname (RFC 6797; the preload
 * list's rules from hstspreload.org).
 *
 * @param hsts - The policy.
 * @param hostname - The domain it is for.
 * @param apex - Whether the hostname is a zone apex; preload is apex-only.
 * @returns Problems in words, empty when it is acceptable.
 */
export function hstsProblems(hsts: DomainHsts, hostname: string, apex: boolean): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(hsts.max_age) || hsts.max_age < 0 || hsts.max_age > MAX_HSTS_MAX_AGE_S) {
    problems.push(`max-age must be a whole number of seconds from 0 to ${MAX_HSTS_MAX_AGE_S}.`);
  }
  if (hsts.preload) {
    if (!hsts.enabled) problems.push("Preload needs HSTS enabled.");
    if (!hsts.include_subdomains) problems.push("Preload needs includeSubDomains.");
    if (hsts.max_age < HSTS_PRELOAD_MIN_MAX_AGE_S) {
      problems.push(
        `Preload needs a max-age of at least ${HSTS_PRELOAD_MIN_MAX_AGE_S} (one year).`,
      );
    }
    if (isWildcardHostname(hostname) || !apex) {
      problems.push("Only a registered domain's apex (example.com) can be preloaded.");
    }
  }
  return problems;
}

/**
 * Cautions about a valid HSTS policy, for the dashboard and the CLI to show
 * before saving.
 *
 * @param hsts - The policy.
 * @returns Warnings in words, empty when there is nothing to point out.
 */
export function hstsWarnings(hsts: DomainHsts): string[] {
  if (!hsts.enabled) return [];
  const warnings: string[] = [];
  if (hsts.max_age === 0) {
    warnings.push("max-age 0 tells browsers to forget the policy; use it to undo HSTS.");
  } else if (hsts.max_age < 86_400) {
    warnings.push("A max-age under a day gives little protection.");
  }
  if (hsts.include_subdomains) {
    warnings.push(
      "includeSubDomains makes browsers refuse plain HTTP on every subdomain, including ones served elsewhere.",
    );
  }
  if (hsts.preload) {
    warnings.push(
      "Preloading is effectively irreversible: removal from browsers' lists takes months after you ask.",
    );
  }
  return warnings;
}

/**
 * The header value for a policy.
 *
 * @param hsts - An enabled policy.
 * @returns E.g. `max-age=31536000; includeSubDomains; preload`.
 */
export function hstsHeaderValue(
  hsts: Pick<DomainHsts, "max_age" | "include_subdomains" | "preload">,
): string {
  return [
    `max-age=${hsts.max_age}`,
    ...(hsts.include_subdomains ? ["includeSubDomains"] : []),
    ...(hsts.preload ? ["preload"] : []),
  ].join("; ");
}

/**
 * Value of the ownership TXT record.
 *
 * @param token - The domain's verification token.
 * @returns E.g. `rh-verify=3f…`.
 */
export function ownershipRecordValue(token: string): string {
  return `${OWNERSHIP_VALUE_PREFIX}${token}`;
}

const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// COMPAT: this package compiles against plain ES2023 (no DOM or Node types),
// but every runtime it runs in has WHATWG `URL`, whose host parser does the
// IDNA (punycode) and IPv4 normalisation we need.
const WhatwgUrl = (globalThis as unknown as { URL: new (input: string) => { hostname: string } })
  .URL;

/**
 * Suffixes that never resolve publicly (RFC 6761, RFC 6762, ICANN's
 * `.internal`), so a certificate could never be issued for them. `.internal`
 * is also where private service domains live.
 */
const NON_PUBLIC_SUFFIXES = ["localhost", "local", "internal", "invalid", "onion", "arpa"];

/**
 * Lowercases a hostname, drops one trailing dot, and turns an
 * internationalised name into its ASCII (punycode) form.
 *
 * @param input - What the user typed.
 * @returns The normalised hostname, or `null` when it can't be one.
 * @example
 * normalizeHostname(" Shop.Example.COM. "); // "shop.example.com"
 * normalizeHostname("bücher.example");      // "xn--bcher-kva.example"
 */
export function normalizeHostname(input: string): string | null {
  const trimmed = input.trim().replace(/\.$/, "");
  if (!trimmed || /[\s/:@?#[\]\\]/.test(trimmed)) return null;
  const wildcard = trimmed.startsWith("*.");
  const rest = wildcard ? trimmed.slice(2) : trimmed;
  let ascii: string;
  try {
    ascii = new WhatwgUrl(`http://${rest}`).hostname;
  } catch {
    return null;
  }
  return wildcard ? `*.${ascii}` : ascii;
}

/** Why a hostname can't be added as a custom domain. */
export type CustomHostnameProblem =
  | "invalid"
  | "wildcard"
  | "ip_address"
  | "non_public"
  | "reserved";

/** Hostnames that belong to the install and can't be claimed. */
export interface ReservedHostnames {
  /** Parent of generated hostnames; it and every name under it are refused. */
  appsDomain: string | null;
  /** Other exact names, e.g. the dashboard's own host and the ingress hostname. */
  exact?: readonly (string | null | undefined)[];
}

/**
 * Checks a normalised hostname against the custom-domain rules.
 *
 * - Valid DNS syntax, at least two labels, at most 253 characters.
 * - A wildcard (`*.example.com`) only with `allowWildcard`: its certificate
 *   needs DNS-01 delegation, which only `managed` TLS with Cloudflare DNS
 *   offers (ADR 0009). Its base must itself be a valid name of two labels or
 *   more.
 * - Not an IP address and not under a suffix that never resolves publicly.
 * - Not the apps domain or a name under it (generated hostnames live there),
 *   none of the install's own names, and no wildcard that would match one.
 *
 * @param hostname - Output of {@link normalizeHostname}.
 * @param reserved - The install's own names.
 * @param options - `allowWildcard`: the install can issue wildcard certificates.
 * @returns The first problem found, or `null` when it may be added.
 * @example
 * customHostnameProblem("api-prod-x7k2.apps.example.com", { appsDomain: "apps.example.com" }); // "reserved"
 */
export function customHostnameProblem(
  hostname: string,
  reserved: ReservedHostnames,
  options: { allowWildcard?: boolean } = {},
): CustomHostnameProblem | null {
  const wildcard = isWildcardHostname(hostname);
  if (wildcard && !options.allowWildcard) return "wildcard";
  if (hostname.length > MAX_HOSTNAME_LENGTH) return "invalid";
  const base = wildcardBase(hostname);
  const labels = base.split(".");
  if (labels.length < 2) return "invalid";
  if (labels.some((l) => l.length > MAX_DNS_LABEL_LENGTH || !LABEL_RE.test(l))) return "invalid";
  // An all-digit last label is an IPv4 literal (URL normalised any short forms).
  if (/^\d+$/.test(labels.at(-1)!)) return "ip_address";
  if (NON_PUBLIC_SUFFIXES.includes(labels.at(-1)!)) return "non_public";
  const apps = reserved.appsDomain?.toLowerCase().replace(/\.$/, "");
  const own = [apps, ...(reserved.exact ?? []).map((n) => n?.toLowerCase())].filter(
    (n): n is string => !!n,
  );
  if (apps && (base === apps || base.endsWith(`.${apps}`))) return "reserved";
  for (const name of own) {
    if (!wildcard && hostname === name) return "reserved";
    // SECURITY: `*.example.com` matches one label, so it would capture the
    // install's own `ingress.example.com` or `apps.example.com`.
    if (wildcard && name.endsWith(`.${base}`) && !name.slice(0, -base.length - 1).includes(".")) {
      return "reserved";
    }
  }
  return null;
}

/** Human-readable explanation of each {@link CustomHostnameProblem}. */
export const CUSTOM_HOSTNAME_PROBLEM_MESSAGES: Record<CustomHostnameProblem, string> = {
  invalid: "Enter a full hostname such as shop.example.com.",
  wildcard:
    "Wildcard domains need the managed TLS mode with a Cloudflare DNS token for the apps " +
    "domain's zone (Settings → Domains & TLS), so their certificate can be issued over " +
    "DNS-01. Until then, add each hostname on its own.",
  ip_address: "Enter a hostname, not an IP address.",
  non_public: "That name never resolves on the public internet, so it can't get a certificate.",
  reserved: "That hostname belongs to this install.",
};
