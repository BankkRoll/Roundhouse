/**
 * DNS lookups for custom-domain checks over DNS-over-HTTPS (the JSON API
 * both Cloudflare and Google serve), since Workers have no resolver of their
 * own (ADR 0009 "Checks").
 *
 * - {@link resolveDomain}: the CNAME chain, final addresses, ownership TXT
 *   and whether the name is a zone apex, in one call.
 * - {@link setDnsTransport}: swaps `fetch` out in tests.
 *
 * `DNS_RESOLVER_URL` overrides the primary resolver; the fallback is always
 * Google's, tried when the primary errors or answers SERVFAIL.
 *
 * @module
 */
import type { DomainDnsObservation } from "@roundhouse/shared";
import { acmeDelegationName, isWildcardHostname, ownershipRecordName } from "@roundhouse/shared";

/** Primary resolver unless `DNS_RESOLVER_URL` is set. */
export const DEFAULT_DNS_RESOLVER = "https://cloudflare-dns.com/dns-query";

/** Tried when the primary fails. */
export const FALLBACK_DNS_RESOLVER = "https://dns.google/resolve";

/** Per-query timeout: a stuck resolver must not hold a request or a cron tick. */
const QUERY_TIMEOUT_MS = 5_000;

const TYPE = { A: 1, CNAME: 5, SOA: 6, TXT: 16, AAAA: 28 } as const;
type QueryType = keyof typeof TYPE;

/** DoH JSON `Status` values that are real answers rather than resolver trouble. */
const NOERROR = 0;
const NXDOMAIN = 3;

interface DohAnswer {
  name: string;
  type: number;
  data: string;
}

interface DohResponse {
  Status: number;
  Answer?: DohAnswer[];
}

let transport: typeof fetch | null = null;

/**
 * Replaces the `fetch` DNS queries and TLS probes use, for tests.
 *
 * @param fn - A fetch implementation, or `null` to restore the global one.
 */
export function setDnsTransport(fn: typeof fetch | null): void {
  transport = fn;
}

/**
 * The `fetch` outbound domain checks go through.
 *
 * @returns The test transport when set, else the global `fetch`.
 */
export function domainFetch(): typeof fetch {
  return transport ?? fetch;
}

/** The bindings lookups read. */
export interface DnsEnv {
  /** Primary DoH JSON endpoint; defaults to {@link DEFAULT_DNS_RESOLVER}. */
  DNS_RESOLVER_URL?: string;
}

/** A resolver that answered nothing usable. */
export class DnsLookupError extends Error {
  override name = "DnsLookupError";
}

const bare = (name: string) => name.toLowerCase().replace(/\.$/, "");

async function queryOne(endpoint: string, name: string, type: QueryType): Promise<DohResponse> {
  const url = new URL(endpoint);
  url.searchParams.set("name", name);
  url.searchParams.set("type", type);
  const res = await domainFetch()(url.toString(), {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!res.ok) throw new DnsLookupError(`resolver answered HTTP ${res.status}`);
  const body = (await res.json()) as DohResponse;
  if (typeof body?.Status !== "number") throw new DnsLookupError("resolver sent no status");
  if (body.Status !== NOERROR && body.Status !== NXDOMAIN) {
    throw new DnsLookupError(`resolver answered DNS status ${body.Status}`);
  }
  return body;
}

async function query(env: DnsEnv, name: string, type: QueryType): Promise<DohAnswer[]> {
  const primary = env.DNS_RESOLVER_URL || DEFAULT_DNS_RESOLVER;
  let body: DohResponse;
  try {
    body = await queryOne(primary, name, type);
  } catch (first) {
    if (primary === FALLBACK_DNS_RESOLVER) throw first;
    try {
      body = await queryOne(FALLBACK_DNS_RESOLVER, name, type);
    } catch {
      throw first instanceof DnsLookupError
        ? first
        : new DnsLookupError(first instanceof Error ? first.message : "lookup failed");
    }
  }
  return (body.Answer ?? []).map((a) => ({ ...a, name: bare(a.name) }));
}

/**
 * Decodes a TXT answer: the presentation form is one or more quoted strings
 * (`"a" "b"`), which a record longer than 255 bytes needs, joined with nothing.
 *
 * @param data - The `data` field of a DoH TXT answer.
 * @returns The record's value.
 * @example
 * txtValue('"rh-verify=ab" "cd"'); // "rh-verify=abcd"
 */
export function txtValue(data: string): string {
  const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    m[1]!.replace(/\\(.)/g, "$1"),
  );
  return parts.length ? parts.join("") : data.trim();
}

/** Everything one check needs to know about a hostname. */
export interface Resolution extends DomainDnsObservation {
  /** The name has its own SOA, so it is a zone apex. */
  apex: boolean;
}

/**
 * Resolves a hostname for a check: A and AAAA (whose answers carry the
 * CNAME chain), the ownership TXT, optionally its SOA, and for a wildcard
 * the CNAME of its `_acme-challenge` delegation. A wildcard's own name is
 * queried literally: resolvers answer `*.example.com` from the wildcard
 * record itself.
 *
 * @param env - Resolver settings.
 * @param hostname - The custom hostname.
 * @param options - `apex: true` also asks for the SOA.
 * @returns What the resolvers saw.
 * @throws {DnsLookupError} When neither resolver answers a query.
 */
export async function resolveDomain(
  env: DnsEnv,
  hostname: string,
  options: { apex?: boolean } = {},
): Promise<Resolution> {
  const wildcard = isWildcardHostname(hostname);
  const [a, aaaa, txt, soa, delegation] = await Promise.all([
    query(env, hostname, "A"),
    query(env, hostname, "AAAA"),
    query(env, ownershipRecordName(hostname), "TXT"),
    options.apex && !wildcard ? query(env, hostname, "SOA") : Promise.resolve([]),
    wildcard ? query(env, acmeDelegationName(hostname), "CNAME") : Promise.resolve([]),
  ]);
  const chain: string[] = [];
  let current = hostname;
  const cnames = [...a, ...aaaa].filter((r) => r.type === TYPE.CNAME);
  // Follow the chain in order; answers may come in any order, and a loop
  // must not spin forever.
  for (let i = 0; i < 16; i++) {
    const next = cnames.find((r) => r.name === current);
    if (!next) break;
    current = bare(next.data);
    if (chain.includes(current)) break;
    chain.push(current);
  }
  const addresses = [
    ...new Set(
      [...a, ...aaaa]
        .filter((r) => r.type === TYPE.A || r.type === TYPE.AAAA)
        .map((r) => r.data.toLowerCase()),
    ),
  ];
  return {
    cname: chain,
    addresses,
    txt: txt.filter((r) => r.type === TYPE.TXT).map((r) => txtValue(r.data)),
    apex: soa.some((r) => r.type === TYPE.SOA && r.name === hostname),
    ...(wildcard
      ? {
          acme_delegation: delegation
            .filter((r) => r.type === TYPE.CNAME)
            .map((r) => bare(r.data)),
        }
      : {}),
  };
}

/**
 * The TXT values at a name, for watching a DNS-01 record propagate.
 *
 * @param env - Resolver settings.
 * @param name - The record name; a CNAME to it (a delegation) is followed.
 * @returns Each TXT value, chunks joined.
 * @throws {DnsLookupError} When neither resolver answers.
 */
export async function resolveTxt(env: DnsEnv, name: string): Promise<string[]> {
  const answers = await query(env, name, "TXT");
  return answers.filter((r) => r.type === TYPE.TXT).map((r) => txtValue(r.data));
}
