/**
 * Which control-plane certificate serves which hostname (ADR 0009, `managed`
 * mode): a custom domain and, without the apps wildcard, a generated one have
 * their own certificate (`certificates.domain_id`); generated hostnames are
 * otherwise covered by `*.<apps_domain>`.
 *
 * @module
 */
import { certificates, type Db } from "@roundhouse/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

/** A certificate row. */
export type CertificateRow = typeof certificates.$inferSelect;

/**
 * Whether a certificate's names cover a hostname: exactly, or through a
 * wildcard, which matches one label (RFC 6125 §6.4.3).
 *
 * @param names - The certificate's hostnames.
 * @param hostname - A hostname, possibly itself a wildcard.
 * @returns `true` when a TLS client would accept the certificate for it.
 * @example
 * certificateCovers(["*.apps.example.com"], "web-x7k2.apps.example.com"); // true
 * certificateCovers(["*.apps.example.com"], "a.b.apps.example.com"); // false
 */
export function certificateCovers(names: readonly string[], hostname: string): boolean {
  return names.some((n) => {
    if (n === hostname) return true;
    if (!n.startsWith("*.") || hostname.startsWith("*.")) return false;
    const base = n.slice(1);
    return hostname.endsWith(base) && !hostname.slice(0, -base.length).includes(".");
  });
}

/** Whether a certificate holds a chain to serve. */
export const servable = (c: Pick<CertificateRow, "chainPem" | "sha256" | "keySealed">) =>
  !!c.chainPem && !!c.sha256 && !!c.keySealed;

/** A domain as coverage needs it. */
export interface CoveredDomain {
  id: string;
  hostname: string;
  type: string;
}

/**
 * The certificate serving each domain, servable or not: its own, else (for
 * a generated hostname) the apps wildcard when that covers it.
 *
 * @param db - Database client.
 * @param list - Domains.
 * @returns Certificate per domain ID; domains without one are absent.
 */
export async function certificatesForDomains(
  db: Db,
  list: readonly CoveredDomain[],
): Promise<Map<string, CertificateRow>> {
  const out = new Map<string, CertificateRow>();
  if (!list.length) return out;
  const own = await db
    .select()
    .from(certificates)
    .where(
      and(
        isNotNull(certificates.domainId),
        inArray(
          certificates.domainId,
          list.map((d) => d.id),
        ),
      ),
    );
  for (const c of own) out.set(c.domainId!, c);
  const generated = list.filter((d) => d.type === "generated" && !out.has(d.id));
  if (generated.length) {
    const [wildcard] = await db
      .select()
      .from(certificates)
      .where(eq(certificates.kind, "apps_wildcard"))
      .limit(1);
    if (wildcard) {
      for (const d of generated) {
        if (certificateCovers(wildcard.hostnames, d.hostname)) out.set(d.id, wildcard);
      }
    }
  }
  return out;
}
