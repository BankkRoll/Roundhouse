/**
 * One issuance attempt of a control-plane certificate (ADR 0009), as
 * `CertificateWorkflow` runs it: the account, the order ({@link runOrder}),
 * then storing the chain or recording the failure, and always removing the
 * challenges it published.
 *
 * - HTTP-01 key authorizations go to `acme_challenges`, served by
 *   `GET /v1/acme/http-01/{token}` to whichever ingress node's Caddy the
 *   CA reaches.
 * - DNS-01 TXT records are written through the Cloudflare DNS API: at
 *   `_acme-challenge.<apps_domain>` for the apps wildcard, at the domain's
 *   delegation target for a custom wildcard.
 * - The new private key is sealed into `pending_key_sealed` before the CSR
 *   is sent, so a retried finalize reuses the key the CSR named, and only
 *   replaces `key_sealed` together with the chain.
 *
 * SECURITY: a stalled attempt can overlap the next one; storing compares
 * `attempts`, so only the newest attempt's chain is ever kept.
 *
 * @module
 */
import { acmeChallenges, certificates, type Db, domains, projects, services } from "@roundhouse/db";
import { acmeDelegationName, acmeDelegationTarget } from "@roundhouse/shared";
import { and, eq } from "drizzle-orm";
import {
  AcmeClient,
  AcmeError,
  ariCertId,
  computeRenewAfter,
  exportPrivateKeyPem,
  generateCertificateKey,
  importCertificateKeyPem,
  parseCertificateChain,
  sha256Hex,
} from "../acme";
import { recordAudit } from "../audit";
import type { Sealed } from "../crypto";
import { type RefreshEnv, refreshAllNodes } from "../desired-state";
import { refreshServiceNodes } from "../domains/check";
import { type DnsEnv, resolveTxt } from "../domains/dns";
import { recomputeManagedTls } from "../domains/tls";
import type { KeyEnv } from "../instance-secrets";
import { getIngressSettings } from "../settings";
import { CloudflareApiError, createTxtRecord, deleteRecord } from "./cloudflare-dns";
import { openCertificateKey, sealCertificateKey } from "./config";
import type { CertificateRow } from "./coverage";
import {
  type CertificateKeySource,
  type ChallengeSolver,
  OrderFailedError,
  type PresentedChallenge,
  runOrder,
  type Steps,
} from "./order";
import { getAcmeConfig, loadAcmeAccount, loadCloudflareDns, saveAcmeAccountUrl } from "./settings";

/** Bindings an attempt needs. */
export type CertificateEnv = KeyEnv & DnsEnv & RefreshEnv;

/** Parameters of one attempt; also the workflow's params. */
export interface CertificateAttempt {
  certificateId: string;
  /** `certificates.attempts` when it was claimed. */
  attempt: number;
}

let acmeTransport: typeof fetch | null = null;

/**
 * Replaces the `fetch` orders use to reach the CA, for tests.
 *
 * @param fn - A fetch implementation, or `null` to restore the global one.
 */
export function setAcmeTransport(fn: typeof fetch | null): void {
  acmeTransport = fn;
}

/** How long a published HTTP-01 key authorization is served. */
export const CHALLENGE_TTL_MS = 60 * 60_000;

/** Longest error kept on a certificate. */
const MAX_ERROR_CHARS = 500;

/** Retry delays after consecutive failures; the last one repeats. */
export const RETRY_DELAYS_MS = [5, 15, 60, 6 * 60, 24 * 60].map((m) => m * 60_000);

/**
 * When to try again after `failures` failures in a row.
 *
 * @param failures - Consecutive failures, counting this one.
 * @returns Delay in ms.
 */
export function retryDelayMs(failures: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(failures, 1), RETRY_DELAYS_MS.length) - 1]!;
}

/**
 * A readable issuer name from an RFC 4514 DN.
 *
 * @param dn - E.g. `CN=R11,O=Let's Encrypt,C=US`.
 * @returns E.g. `Let's Encrypt R11`; the DN itself when it has neither O nor CN.
 */
export function issuerName(dn: string): string {
  const attrs = new Map<string, string>();
  for (const part of dn.split(/,(?=[A-Z]+=)/)) {
    const i = part.indexOf("=");
    if (i > 0) attrs.set(part.slice(0, i), part.slice(i + 1).replace(/\\(.)/g, "$1"));
  }
  const name = [attrs.get("O"), attrs.get("CN")].filter(Boolean).join(" ");
  return (name || dn).slice(0, 200);
}

async function loadCertificate(db: Db, id: string) {
  return db.query.certificates.findFirst({ where: eq(certificates.id, id) });
}

/**
 * Where a DNS-01 record for a certificate is written, and the name the CA
 * (and the propagation check) looks up.
 */
async function dns01Names(
  db: Db,
  cert: CertificateRow,
  identifier: string,
): Promise<{ write: string; lookup: string }> {
  const lookup = acmeDelegationName(identifier);
  if (cert.kind === "apps_wildcard") return { write: lookup, lookup };
  const { appsDomain } = await getIngressSettings(db);
  if (!cert.domainId || !appsDomain) {
    throw new OrderFailedError("A wildcard needs the apps domain set to answer DNS-01.");
  }
  // The customer's `_acme-challenge` CNAME sends the CA to this name in the
  // install's own zone.
  return { write: acmeDelegationTarget(cert.domainId, appsDomain), lookup };
}

function dbSolver(
  db: Db,
  env: CertificateEnv,
  cert: CertificateRow,
  now: () => number,
): ChallengeSolver {
  return {
    async present(c: PresentedChallenge) {
      const existing = await db.query.acmeChallenges.findFirst({
        where: eq(acmeChallenges.token, c.token),
      });
      if (existing) return;
      const at = new Date(now());
      const expiresAt = new Date(now() + CHALLENGE_TTL_MS);
      if (c.type === "http-01") {
        await db.insert(acmeChallenges).values({
          token: c.token,
          keyAuthorization: c.keyAuthorization,
          certificateId: cert.id,
          type: "http-01",
          expiresAt,
          createdAt: at,
          updatedAt: at,
        });
        return;
      }
      const zone = await loadCloudflareDns(db, env);
      if (!zone) {
        throw new OrderFailedError(
          "DNS-01 needs the Cloudflare DNS token under Settings → Domains & TLS.",
        );
      }
      const { write } = await dns01Names(db, cert, c.identifier);
      const recordId = await createTxtRecord(zone, write, c.dnsValue!);
      await db.insert(acmeChallenges).values({
        token: c.token,
        keyAuthorization: c.dnsValue!,
        certificateId: cert.id,
        type: "dns-01",
        dnsName: write,
        dnsRecordId: recordId,
        expiresAt,
        createdAt: at,
        updatedAt: at,
      });
    },
    async visible(c: PresentedChallenge) {
      if (c.type !== "dns-01") return true;
      const { lookup } = await dns01Names(db, cert, c.identifier);
      try {
        return (await resolveTxt(env, lookup)).includes(c.dnsValue!);
      } catch {
        return false;
      }
    },
  };
}

function dbKeySource(db: Db, env: CertificateEnv, cert: CertificateRow): CertificateKeySource {
  return {
    async keyPair() {
      const row = await loadCertificate(db, cert.id);
      if (row?.pendingKeySealed) {
        return importCertificateKeyPem(
          await openCertificateKey(env, cert.id, row.pendingKeySealed as Sealed),
        );
      }
      const pair = await generateCertificateKey();
      const sealed = await sealCertificateKey(
        env,
        cert.id,
        await exportPrivateKeyPem(pair.privateKey),
      );
      await db
        .update(certificates)
        .set({ pendingKeySealed: sealed, updatedAt: new Date() })
        .where(eq(certificates.id, cert.id));
      return pair;
    },
  };
}

/**
 * Removes the challenges an attempt published: the TXT records it wrote
 * and every stored key authorization. Failures to delete a record are
 * logged, not thrown: a stale TXT record is harmless.
 *
 * @param db - Database client.
 * @param env - Bindings with the keyring.
 * @param certificateId - The certificate.
 */
export async function cleanupChallenges(db: Db, env: KeyEnv, certificateId: string): Promise<void> {
  const rows = await db
    .select()
    .from(acmeChallenges)
    .where(eq(acmeChallenges.certificateId, certificateId));
  const dns = rows.filter((r) => r.type === "dns-01" && r.dnsRecordId);
  if (dns.length) {
    const zone = await loadCloudflareDns(db, env).catch(() => null);
    for (const r of dns) {
      if (!zone) break;
      await deleteRecord(zone, r.dnsRecordId!).catch((err: unknown) =>
        console.warn("acme txt cleanup failed", err instanceof Error ? err.message : "error"),
      );
    }
  }
  if (rows.length) {
    await db.delete(acmeChallenges).where(eq(acmeChallenges.certificateId, certificateId));
  }
}

/** The workspace a certificate's events are audited in; `null` for the apps wildcard. */
async function auditWorkspace(db: Db, cert: CertificateRow): Promise<string | null> {
  if (!cert.domainId) return null;
  const [row] = await db
    .select({ workspaceId: projects.workspaceId })
    .from(domains)
    .innerJoin(services, eq(services.id, domains.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .where(eq(domains.id, cert.domainId))
    .limit(1);
  return row?.workspaceId ?? null;
}

/**
 * Pushes desired state to the nodes that serve a certificate's names and
 * recomputes the TLS state of its domain.
 */
async function publish(db: Db, env: CertificateEnv, cert: CertificateRow, now: number) {
  if (!cert.domainId) {
    await refreshAllNodes(env, db);
    return;
  }
  const d = await db.query.domains.findFirst({ where: eq(domains.id, cert.domainId) });
  if (!d) return;
  await refreshServiceNodes(env, db, d.serviceId, d.environmentId);
  await recomputeManagedTls(db, [d.id], now);
}

/**
 * Stores an issued chain if the attempt is still the newest.
 *
 * @returns Whether it was stored.
 */
async function storeIssued(
  db: Db,
  env: CertificateEnv,
  client: AcmeClient,
  params: CertificateAttempt,
  chainPem: string,
  orderUrl: string,
  now: number,
): Promise<boolean> {
  const cert = await loadCertificate(db, params.certificateId);
  if (!cert || cert.attempts !== params.attempt || !cert.pendingKeySealed) return false;
  const leaf = parseCertificateChain(chainPem);
  const ariId = ariCertId(leaf);
  const ari = ariId ? await client.renewalInfo(ariId).catch(() => null) : null;
  const renewAfter = computeRenewAfter(leaf, ari);
  const renewal = !!cert.chainPem;
  const [stored] = await db
    .update(certificates)
    .set({
      status: "issued",
      keySealed: cert.pendingKeySealed,
      pendingKeySealed: null,
      chainPem,
      sha256: await sha256Hex(chainPem),
      issuer: issuerName(leaf.issuer),
      notBefore: new Date(leaf.notBefore),
      notAfter: new Date(leaf.notAfter),
      renewAfter: new Date(renewAfter),
      ariCertId: ariId,
      orderUrl,
      error: null,
      failures: 0,
      nextAttemptAt: new Date(renewAfter),
      updatedAt: new Date(now),
    })
    .where(and(eq(certificates.id, cert.id), eq(certificates.attempts, params.attempt)))
    .returning();
  if (!stored) return false;
  await recordAudit(db, {
    workspaceId: await auditWorkspace(db, stored),
    actorType: "system",
    actorId: null,
    action: renewal ? "certificate.renewed" : "certificate.issued",
    targetType: "certificate",
    targetId: stored.id,
    metadata: {
      hostnames: stored.hostnames,
      issuer: stored.issuer,
      not_after: leaf.notAfter,
      renew_after: renewAfter,
      domain_id: stored.domainId,
    },
  });
  await publish(db, env, stored, now);
  return true;
}

/**
 * Records a failed attempt: the old chain (if any) keeps serving, the next
 * attempt is spaced out by consecutive failures.
 */
async function recordFailure(
  db: Db,
  params: CertificateAttempt,
  reason: string,
  now: number,
): Promise<void> {
  const cert = await loadCertificate(db, params.certificateId);
  if (!cert || cert.attempts !== params.attempt) return;
  const failures = cert.failures + 1;
  const error = reason.slice(0, MAX_ERROR_CHARS);
  const [row] = await db
    .update(certificates)
    .set({
      status: cert.chainPem ? "issued" : "failed",
      pendingKeySealed: null,
      error,
      failures,
      nextAttemptAt: new Date(now + retryDelayMs(failures)),
      updatedAt: new Date(now),
    })
    .where(and(eq(certificates.id, cert.id), eq(certificates.attempts, params.attempt)))
    .returning();
  if (!row) return;
  await recordAudit(db, {
    workspaceId: await auditWorkspace(db, row),
    actorType: "system",
    actorId: null,
    action: "certificate.failed",
    targetType: "certificate",
    targetId: row.id,
    metadata: { hostnames: row.hostnames, error, failures, domain_id: row.domainId },
  });
  if (row.domainId) await recomputeManagedTls(db, [row.domainId], now);
}

/**
 * Words safe to show for an attempt's failure.
 *
 * @param err - What was thrown.
 * @returns The reason.
 */
export function failureMessage(err: unknown): string {
  if (err instanceof OrderFailedError) return err.message;
  if (err instanceof AcmeError) return `The CA answered: ${err.detail || err.type}`;
  if (err instanceof CloudflareApiError) return err.message;
  // Errors crossing a workflow step boundary lose their class; the
  // workflow marks the ones safe to show with this prefix.
  if (err instanceof Error && err.message.startsWith(PUBLIC_ERROR_PREFIX)) {
    return err.message.slice(PUBLIC_ERROR_PREFIX.length);
  }
  return "Issuance failed unexpectedly; it will be retried.";
}

/** Marks an error message as safe to show after it crossed a workflow step. */
export const PUBLIC_ERROR_PREFIX = "certificate: ";

/**
 * Whether an error is final for this attempt: the CA or Cloudflare gave a
 * definitive answer, so retrying the step can't help.
 *
 * @param err - What a step threw.
 * @returns `true` for refusals; `false` for transport trouble and the unknown.
 */
export function isDefinitive(err: unknown): boolean {
  if (err instanceof OrderFailedError) return true;
  if (err instanceof AcmeError) {
    return err.status >= 400 && err.status < 500 && !err.is("badNonce") && !err.is("rateLimited");
  }
  if (err instanceof CloudflareApiError) return err.status >= 400 && err.status < 500;
  return false;
}

/**
 * Whether an error's message may be shown to the domain's owner.
 *
 * @param err - What a step threw.
 * @returns `true` for the CA's, Cloudflare's and the order's own errors.
 */
export const isPublicError = (err: unknown) =>
  err instanceof OrderFailedError || err instanceof AcmeError || err instanceof CloudflareApiError;

/**
 * Runs one attempt end to end.
 *
 * @param env - Bindings.
 * @param db - Database client.
 * @param params - The certificate and the attempt number it was claimed with.
 * @param steps - The workflow's step runner, or {@link inlineSteps}.
 * @param options - `fetch` for the CA (tests), `now` for timestamps.
 * @returns `issued`, `failed`, or `superseded` when a newer attempt owns the row.
 */
export async function runCertificateAttempt(
  env: CertificateEnv,
  db: Db,
  params: CertificateAttempt,
  steps: Steps,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<"issued" | "failed" | "superseded"> {
  const now = options.now ?? Date.now;
  const cert = await loadCertificate(db, params.certificateId);
  if (!cert || cert.attempts !== params.attempt) return "superseded";

  let outcome: "issued" | "failed" | "superseded";
  try {
    // The account key is created (once) outside any order; a resumed run
    // reads the same key back.
    await steps.do("account-key", async () => {
      await loadAcmeAccount(db, env);
      return true;
    });
    const account = await loadAcmeAccount(db, env);
    const client = new AcmeClient({
      directoryUrl: account.directoryUrl,
      accountKey: account.key,
      accountUrl: account.url,
      ...((options.fetch ?? acmeTransport) ? { fetch: options.fetch ?? acmeTransport! } : {}),
    });
    if (!account.url) {
      const url = await steps.do("register", async () => {
        const { email } = await getAcmeConfig(db);
        return client.register(email ? { contact: [`mailto:${email}`] } : {});
      });
      await saveAcmeAccountUrl(db, account.directoryUrl, url);
    }
    const { chainPem, orderUrl } = await runOrder(
      {
        client,
        solver: dbSolver(db, env, cert, now),
        key: dbKeySource(db, env, cert),
        steps,
      },
      {
        hostnames: cert.hostnames,
        challenge: cert.challenge,
        replaces: cert.chainPem ? cert.ariCertId : null,
      },
    );
    const stored = await steps.do("store", () =>
      storeIssued(db, env, client, params, chainPem, orderUrl, now()),
    );
    outcome = stored ? "issued" : "superseded";
  } catch (err) {
    const reason = failureMessage(err);
    if (!(err instanceof OrderFailedError) && !(err instanceof AcmeError)) {
      console.error("certificate attempt failed", err instanceof Error ? err.message : "error");
    }
    await steps.do("fail", async () => {
      await recordFailure(db, params, reason, now());
      return true;
    });
    outcome = "failed";
  }
  await steps.do("cleanup", async () => {
    await cleanupChallenges(db, env, params.certificateId);
    return true;
  });
  return outcome;
}
