/**
 * Which certificates exist and when their orders start (ADR 0009, `managed`
 * mode), run by the minute tick:
 *
 * - {@link syncCertificates}: creates a row for each name that needs one:
 *   the apps wildcard when DNS-01 is available for the apps domain; each
 *   verified custom domain; each verified generated hostname the wildcard
 *   doesn't cover. HTTP-01 names wait until a node serves them, since the CA
 *   must reach one. It removes rows nothing needs any more.
 * - {@link claimDueCertificates}: claims rows whose `next_attempt_at` has
 *   passed (new, retried or due for renewal) with a compare-and-swap, and
 *   starts a `CertificateWorkflow` instance `<id>-<attempt>` for each.
 *
 * Outside `managed` mode neither does anything, so leaving the mode stops
 * renewals without deleting what was issued.
 *
 * @module
 */
import { certificates, type Db, domains } from "@roundhouse/db";
import { isWildcardHostname, newId } from "@roundhouse/shared";
import { and, asc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { Env } from "../../env";
import { pairKey, servingNodes } from "../domains/serving";
import { getIngressSettings } from "../settings";
import { type CertificateRow, certificateCovers, servable } from "./coverage";
import type { CertificateAttempt } from "./pipeline";
import { dns01Available, getCloudflareDnsView } from "./settings";

/** Orders started per tick: the CA's validation traffic stays well under the HTTP-01 endpoint's limit. */
export const CERTIFICATE_CLAIM_BATCH = 10;

/** New rows created per pass; the rest follow on the next ticks. */
const CREATE_BATCH = 50;

/**
 * How long a claimed attempt owns its row. A workflow that hasn't finished
 * by then is presumed stalled, and the next tick starts another attempt.
 */
export const ATTEMPT_LEASE_MS = 60 * 60_000;

/** The apps wildcard's single name. */
export const appsWildcardName = (appsDomain: string) => `*.${appsDomain}`;

/**
 * Brings the certificate rows in line with the domains that need them.
 *
 * @param db - Database client.
 * @param now - Current time, unix ms.
 * @returns How many rows were created.
 */
export async function syncCertificates(db: Db, now = Date.now()): Promise<number> {
  const { tlsMode, appsDomain } = await getIngressSettings(db);
  if (tlsMode !== "managed") return 0;
  const dns = await getCloudflareDnsView(db);
  const dns01 = dns01Available(appsDomain, dns);
  const at = new Date(now);
  let created = 0;

  const wildcards = await db
    .select()
    .from(certificates)
    .where(eq(certificates.kind, "apps_wildcard"));
  const wanted = dns01 && appsDomain ? appsWildcardName(appsDomain) : null;
  const stale = wildcards.filter((c) => c.hostnames[0] !== wanted);
  if (stale.length) {
    await db.delete(certificates).where(
      inArray(
        certificates.id,
        stale.map((c) => c.id),
      ),
    );
  }
  let wildcard = wildcards.find((c) => c.hostnames[0] === wanted);
  if (wanted && !wildcard) {
    [wildcard] = (await db
      .insert(certificates)
      .values({
        id: newId("certificate"),
        hostnames: [wanted],
        kind: "apps_wildcard",
        challenge: "dns-01",
        status: "pending",
        nextAttemptAt: at,
        createdAt: at,
        updatedAt: at,
      })
      .returning()) as [CertificateRow];
    created++;
  }

  // Verified domains without a certificate of their own.
  const candidates = await db
    .select({
      id: domains.id,
      hostname: domains.hostname,
      type: domains.type,
      serviceId: domains.serviceId,
      environmentId: domains.environmentId,
    })
    .from(domains)
    .leftJoin(certificates, eq(certificates.domainId, domains.id))
    .where(and(eq(domains.verificationStatus, "verified"), isNull(certificates.id)))
    .orderBy(asc(domains.createdAt));
  const needing = candidates.filter((d) => {
    if (d.type === "custom") return !isWildcardHostname(d.hostname) || dns01;
    return !(wildcard && certificateCovers(wildcard.hostnames, d.hostname));
  });
  const httpNames = needing.filter((d) => !isWildcardHostname(d.hostname));
  const serving = httpNames.length
    ? await servingNodes(db, httpNames, { managed: true })
    : new Map();
  const rows = needing
    .filter((d) => isWildcardHostname(d.hostname) || (serving.get(pairKey(d))?.length ?? 0) > 0)
    .slice(0, CREATE_BATCH)
    .map((d) => ({
      id: newId("certificate"),
      hostnames: [d.hostname],
      kind: d.type === "custom" ? ("custom" as const) : ("generated" as const),
      challenge: isWildcardHostname(d.hostname) ? ("dns-01" as const) : ("http-01" as const),
      domainId: d.id,
      status: "pending" as const,
      nextAttemptAt: at,
      createdAt: at,
      updatedAt: at,
    }));
  for (const row of rows) {
    await db.insert(certificates).values(row).onConflictDoNothing();
    created++;
  }

  // Per-name generated certificates the wildcard now covers.
  if (wildcard && servable(wildcard)) {
    const own = await db
      .select({ id: certificates.id, hostnames: certificates.hostnames })
      .from(certificates)
      .where(eq(certificates.kind, "generated"));
    const covered = own.filter((c) =>
      c.hostnames.every((h) => certificateCovers(wildcard.hostnames, h)),
    );
    if (covered.length) {
      await db.delete(certificates).where(
        inArray(
          certificates.id,
          covered.map((c) => c.id),
        ),
      );
    }
  }
  return created;
}

/**
 * Claims due certificates and starts their orders.
 *
 * @param env - Bindings with `CERT_WORKFLOW`.
 * @param db - Database client.
 * @param now - Current time, unix ms.
 * @returns How many attempts were started.
 */
export async function claimDueCertificates(
  env: Pick<Env, "CERT_WORKFLOW">,
  db: Db,
  now = Date.now(),
): Promise<number> {
  const { tlsMode } = await getIngressSettings(db);
  if (tlsMode !== "managed") return 0;
  const due = await db
    .select()
    .from(certificates)
    .where(
      and(isNotNull(certificates.nextAttemptAt), lte(certificates.nextAttemptAt, new Date(now))),
    )
    .orderBy(asc(certificates.nextAttemptAt))
    .limit(CERTIFICATE_CLAIM_BATCH);
  let started = 0;
  for (const c of due) {
    const attempt = c.attempts + 1;
    const [claimed] = await db
      .update(certificates)
      .set({
        attempts: attempt,
        status: c.chainPem ? "renewing" : "pending",
        nextAttemptAt: new Date(now + ATTEMPT_LEASE_MS),
        updatedAt: new Date(now),
      })
      .where(and(eq(certificates.id, c.id), eq(certificates.attempts, c.attempts)))
      .returning({ id: certificates.id });
    if (!claimed) continue;
    const params: CertificateAttempt = { certificateId: c.id, attempt };
    try {
      await env.CERT_WORKFLOW.create({ id: `${c.id}-${attempt}`, params });
      started++;
    } catch (err) {
      // The lease expires and the next tick tries again.
      console.error(
        "certificate workflow start failed",
        err instanceof Error ? err.message : "error",
      );
    }
  }
  return started;
}
