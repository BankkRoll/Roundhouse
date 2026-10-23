/**
 * The custom-domain checker (ADR 0009 "Checks"): resolves a domain's records,
 * moves it through `pending_dns → pending_verification → issuing → active`
 * (or `failed` after 72 hours), and schedules the next look.
 *
 * - {@link planCheck}: the pure state transition, unit-tested on its own.
 * - {@link checkDomain}: one check with its side effects (row update, audit,
 *   pushing routes to nodes once verified).
 * - {@link runDomainChecks}: the Cron Trigger's batch of due domains.
 *
 * TLS after verification: in `acme` mode the serving nodes report their
 * certificates (`cert_status`, `./tls.ts`), and only when none of them
 * speaks `CERTS_PROTOCOL_VERSION` does a check fall back to an HTTPS probe;
 * in `managed` mode the certificate pipeline (`lib/certificates`) moves
 * the domain to `active` once every serving node holds the certificate.
 *
 * SECURITY: `verification_status = 'verified'` is what puts a hostname into
 * nodes' routes (desired state reads it), and it is only ever set here, once
 * both the routing record and the per-domain ownership TXT are seen (and,
 * for a wildcard, its `_acme-challenge` delegation).
 *
 * @module
 */
import {
  createDb,
  type Db,
  deployments,
  domains,
  projects,
  services,
  workspaces,
} from "@roundhouse/db";
import { CERTS_PROTOCOL_VERSION } from "@roundhouse/protocol";
import {
  acmeDelegationName,
  acmeDelegationTarget,
  DOMAIN_VERIFY_WINDOW_MS,
  type DomainDnsObservation,
  isWildcardHostname,
  nextCheckDelayMs,
  ownershipRecordName,
  ownershipRecordValue,
  type TlsMode,
  VERIFIED_RECHECK_MS,
} from "@roundhouse/shared";
import { and, asc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { recordAudit } from "../audit";
import {
  LIVE_DEPLOYMENT_STATUSES,
  nodesOfDeployments,
  type RefreshEnv,
  refreshNodes,
} from "../desired-state";
import { getIngressSettings } from "../settings";
import { type DnsEnv, DnsLookupError, domainFetch, type Resolution, resolveDomain } from "./dns";
import {
  evaluateDelegation,
  evaluateOwnership,
  evaluateRouting,
  type RoutingTargets,
  routingTargets,
} from "./records";
import { pairKey, servingNodes } from "./serving";

type DomainRow = typeof domains.$inferSelect;

/** Bindings a check needs: the resolver and the node namespace. */
export type CheckEnv = DnsEnv & RefreshEnv;

/** How long a verified domain waits for its first certificate before `tls_status` reads `failed`. */
export const TLS_ISSUE_GRACE_MS = 24 * 60 * 60 * 1000;

/** The Cron Trigger expression that runs {@link runDomainChecks}; it must match `wrangler.jsonc`. */
export const DOMAIN_CHECK_CRON = "* * * * *";

/**
 * Most domains one cron tick checks. PERF: each costs 3–4 subrequests, and
 * the Workers Free plan allows 50 per invocation.
 */
export const DOMAIN_CHECK_BATCH = 10;

/** How long a claimed domain is hidden from other ticks while it is being checked. */
const CLAIM_LEASE_MS = 5 * 60_000;

const TLS_PROBE_TIMEOUT_MS = 10_000;

/** The outcome of an HTTPS request to a verified hostname. */
export interface TlsProbe {
  ok: boolean;
  error?: string;
}

/** Inputs to {@link planCheck}. */
export interface CheckInput {
  now: number;
  /** What the resolvers saw, or `null` when none answered. */
  seen: Resolution | null;
  /** Why the lookup failed, when `seen` is `null`. */
  lookupError?: string;
  targets: RoutingTargets;
  tlsMode: TlsMode;
  /**
   * Present when the domain was already `issuing` in `acme` mode and an
   * HTTPS request was made, because no serving node reports certificates.
   */
  tls?: TlsProbe;
}

/** The row changes a check makes, and the audit event it causes. */
export interface CheckPlan {
  patch: Partial<DomainRow>;
  event: "verified" | "failed" | null;
}

function describeRouting(
  d: DomainRow,
  seen: DomainDnsObservation,
  state: string,
  targets: RoutingTargets,
) {
  if (state === "ok") return null;
  const want = targets.cname ?? (targets.addresses.join(", ") || "this install's servers");
  if (state === "missing") return `No CNAME or A/AAAA record found for ${d.hostname}.`;
  const got = seen.cname[0] ?? seen.addresses.join(", ");
  return (
    `${d.hostname} points to ${got}, not ${want}. ` +
    "If the record is proxied (Cloudflare's orange cloud, for example), set it to DNS only."
  );
}

function describeOwnership(d: DomainRow, state: string) {
  const name = ownershipRecordName(d.hostname);
  if (state === "missing") return `TXT ${name} not found.`;
  if (state === "wrong")
    return `TXT ${name} doesn't contain ${ownershipRecordValue(d.verificationToken!)}.`;
  return null;
}

function describeDelegation(d: DomainRow, seen: DomainDnsObservation, targets: RoutingTargets) {
  if (!isWildcardHostname(d.hostname)) return null;
  if (!targets.appsDomain) return "Set the apps domain before adding a wildcard.";
  const target = acmeDelegationTarget(d.id, targets.appsDomain);
  const state = evaluateDelegation(seen, target);
  if (state === "ok") return null;
  const name = acmeDelegationName(d.hostname);
  return state === "missing"
    ? `CNAME ${name} not found.`
    : `${name} points to ${seen.acme_delegation?.[0]}, not ${target}.`;
}

/** Whether the TLS mode issues certificates after verification (rather than having them at once). */
const issues = (tlsMode: TlsMode) => tlsMode === "acme" || tlsMode === "managed";

function settledTls(tlsMode: TlsMode) {
  return tlsMode === "off" ? ("disabled" as const) : ("issued" as const);
}

/**
 * Decides what one check changes. Resolver failures never fail a domain;
 * only real answers count against the 72-hour window.
 *
 * @param d - The domain before the check.
 * @param input - What the check saw.
 * @returns The patch to write and the audit event, if any.
 */
export function planCheck(d: DomainRow, input: CheckInput): CheckPlan {
  const { now, seen, targets, tlsMode } = input;
  const attempts = d.checkAttempts + 1;
  const base: Partial<DomainRow> = {
    lastCheckedAt: new Date(now),
    checkAttempts: attempts,
    updatedAt: new Date(now),
  };
  const verified = d.verificationStatus === "verified";

  if (!seen) {
    const previous = d.dnsObserved ?? { cname: [], addresses: [], txt: [] };
    return {
      patch: {
        ...base,
        dnsObserved: { ...previous, resolver_error: input.lookupError ?? "lookup failed" },
        error: verified ? d.error : `DNS lookup failed (${input.lookupError}); retrying.`,
        nextCheckAt: new Date(now + nextCheckDelayMs(attempts)),
      },
      event: null,
    };
  }

  const routing = evaluateRouting(seen, targets);
  const ownership = evaluateOwnership(seen, d.verificationToken ?? "");
  const observed: DomainDnsObservation = {
    cname: seen.cname,
    addresses: seen.addresses,
    txt: seen.txt,
    ...(seen.acme_delegation ? { acme_delegation: seen.acme_delegation } : {}),
  };
  const delegation = describeDelegation(d, observed, targets);
  const problems = [
    describeRouting(d, seen, routing, targets),
    describeOwnership(d, ownership),
    delegation,
  ].filter(Boolean);
  const patch: Partial<DomainRow> = {
    ...base,
    dnsStatus: routing,
    ownershipStatus: ownership,
    dnsObserved: observed,
  };

  if (verified) {
    // NOTE: a verified domain stays routed when its records later change.
    // The records belong to the customer; removing the route because of a
    // DNS blip would be an outage, and ownership changes need a new token
    // (remove and re-add) anyway.
    if (d.status === "issuing" && issues(tlsMode)) {
      // The nodes' reports (acme) or the certificate pipeline (managed) move
      // the domain on; only the probe fallback decides here.
      if (!input.tls) {
        return {
          patch: {
            ...patch,
            error: problems.length
              ? `Records changed since verification: ${problems.join(" ")}`
              : d.error,
            nextCheckAt: new Date(now + VERIFIED_RECHECK_MS),
          },
          event: null,
        };
      }
      if (input.tls.ok) {
        return {
          patch: {
            ...patch,
            status: "active",
            tlsStatus: "issued",
            error: null,
            nextCheckAt: new Date(now + VERIFIED_RECHECK_MS),
          },
          event: null,
        };
      }
      const late = d.verifiedAt !== null && now - +d.verifiedAt > TLS_ISSUE_GRACE_MS;
      return {
        patch: {
          ...patch,
          tlsStatus: late ? "failed" : "pending",
          error: `Waiting for the certificate${input.tls?.error ? `: ${input.tls.error}` : ""}.`,
          nextCheckAt: new Date(now + nextCheckDelayMs(attempts)),
        },
        event: null,
      };
    }
    return {
      patch: {
        ...patch,
        ...(d.status === "issuing" ? { status: "active", tlsStatus: settledTls(tlsMode) } : {}),
        error: problems.length ? `Records changed since verification: ${problems.join(" ")}` : null,
        nextCheckAt: new Date(now + VERIFIED_RECHECK_MS),
      },
      event: null,
    };
  }

  if (routing === "ok" && ownership === "ok" && !delegation) {
    const issuing = issues(tlsMode);
    return {
      patch: {
        ...patch,
        verificationStatus: "verified",
        verifiedAt: new Date(now),
        status: issuing ? "issuing" : "active",
        tlsStatus: issuing ? "pending" : settledTls(tlsMode),
        error: null,
        checkAttempts: 0,
        // A probe, if one is needed, waits for the nodes to load the new route.
        nextCheckAt: new Date(now + (tlsMode === "acme" ? nextCheckDelayMs(1) : VERIFIED_RECHECK_MS)),
      },
      event: "verified",
    };
  }

  const since = d.pendingSince ? +d.pendingSince : +d.createdAt;
  const message = problems.join(" ");
  if (now - since >= DOMAIN_VERIFY_WINDOW_MS) {
    return {
      patch: {
        ...patch,
        status: "failed",
        verificationStatus: "failed",
        error: `Not verified within 72 hours. ${message} Fix the records, then check again.`,
        nextCheckAt: null,
      },
      event: "failed",
    };
  }
  return {
    patch: {
      ...patch,
      status: routing === "ok" ? "pending_verification" : "pending_dns",
      error: message,
      nextCheckAt: new Date(now + nextCheckDelayMs(attempts)),
    },
    event: null,
  };
}

/**
 * Makes one HTTPS request to a verified hostname. In `acme` mode it is also
 * what makes Caddy issue the certificate on demand. Any HTTP response means
 * the handshake passed with a publicly trusted certificate.
 *
 * SECURITY: only verified hostnames, which provably point at this install's
 * servers, are probed; nothing from the response is kept but success.
 *
 * @param hostname - A verified custom hostname.
 * @returns Whether the handshake passed.
 */
export async function probeTls(hostname: string): Promise<TlsProbe> {
  try {
    const res = await domainFetch()(`https://${hostname}/`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(TLS_PROBE_TIMEOUT_MS),
    });
    await res.body?.cancel();
    // 525/526 come from a Cloudflare proxy in front of a bad origin certificate.
    if (res.status === 525 || res.status === 526) {
      return { ok: false, error: `the proxy reported HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "request failed" };
  }
}

/**
 * Whether an issuing domain's certificate can only be learned by probing:
 * it has serving nodes, and none of them reports `cert_status`.
 *
 * @param db - Database client.
 * @param d - The domain.
 * @returns `true` when a probe is the only signal.
 */
async function needsProbe(db: Db, d: DomainRow): Promise<boolean> {
  const nodes = (await servingNodes(db, [d])).get(pairKey(d)) ?? [];
  return nodes.length > 0 && nodes.every((n) => n.protocolVersion < CERTS_PROTOCOL_VERSION);
}

/**
 * Pushes fresh desired state to every node running a live deployment of a
 * service in an environment, so a domain's route appears or disappears.
 *
 * @param env - Bindings with the node namespace.
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 */
export async function refreshServiceNodes(
  env: RefreshEnv,
  db: Db,
  serviceId: string,
  environmentId: string,
): Promise<void> {
  const live = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.serviceId, serviceId),
        eq(deployments.environmentId, environmentId),
        inArray(deployments.status, [...LIVE_DEPLOYMENT_STATUSES]),
      ),
    );
  await refreshNodes(
    env,
    db,
    await nodesOfDeployments(
      db,
      live.map((d) => d.id),
    ),
  );
}

/** Who caused a check, for audit entries. */
export interface CheckActor {
  actorType: "user" | "token" | "system";
  actorId: string | null;
}

const SYSTEM: CheckActor = { actorType: "system", actorId: null };

/**
 * Checks one custom domain now and stores the result.
 *
 * @param ctx - Database, bindings and the current time.
 * @param d - The domain.
 * @param workspaceId - Its workspace, for routing targets and audit.
 * @param actor - Who asked; the cron is `system`.
 * @param options - `resolution`: answers already fetched (adding a domain resolves it once).
 * @returns The updated row (unchanged for generated domains).
 */
export async function checkDomain(
  ctx: { db: Db; env: CheckEnv; now?: number },
  d: DomainRow,
  workspaceId: string,
  actor: CheckActor = SYSTEM,
  options: { resolution?: Resolution } = {},
): Promise<DomainRow> {
  if (d.type !== "custom") return d;
  const { db, env } = ctx;
  const ingress = await getIngressSettings(db);
  const targets = await routingTargets(
    db,
    { workspaceId, serviceId: d.serviceId, environmentId: d.environmentId },
    ingress.appsDomain,
  );
  let seen: Resolution | null = options.resolution ?? null;
  let lookupError: string | undefined;
  if (!seen) {
    try {
      seen = await resolveDomain(env, d.hostname);
    } catch (err) {
      lookupError = err instanceof DnsLookupError ? err.message : "no resolver answered";
    }
  }
  const tls =
    seen &&
    d.verificationStatus === "verified" &&
    d.status === "issuing" &&
    ingress.tlsMode === "acme" &&
    (await needsProbe(db, d))
      ? await probeTls(d.hostname)
      : undefined;
  const now = ctx.now ?? Date.now();
  const plan = planCheck(d, {
    now,
    seen,
    ...(lookupError ? { lookupError } : {}),
    targets,
    tlsMode: ingress.tlsMode,
    ...(tls ? { tls } : {}),
  });
  const [row] = await db.update(domains).set(plan.patch).where(eq(domains.id, d.id)).returning();
  if (!row) return { ...d, ...plan.patch };
  if (plan.event) {
    await recordAudit(db, {
      workspaceId,
      ...(plan.event === "verified" ? actor : SYSTEM),
      action: plan.event === "verified" ? "domain.verified" : "domain.failed",
      targetType: "domain",
      targetId: d.id,
      metadata: {
        hostname: d.hostname,
        service_id: d.serviceId,
        environment_id: d.environmentId,
      },
    });
  }
  if (plan.event === "verified") {
    await refreshServiceNodes(env, db, d.serviceId, d.environmentId);
  }
  return row;
}

/**
 * The Cron Trigger's pass: claims up to {@link DOMAIN_CHECK_BATCH} custom
 * domains whose `next_check_at` has passed and checks them. Domains of
 * deleted services or projects are dropped from the schedule.
 *
 * @param env - Worker bindings.
 * @param now - The tick's time, unix ms.
 * @returns How many domains were checked and how many became verified.
 */
export async function runDomainChecks(
  env: CheckEnv & { DB: D1Database },
  now: number,
): Promise<{ checked: number; verified: number; failed: number }> {
  const db = createDb(env.DB);
  const due = db
    .select({ id: domains.id })
    .from(domains)
    .where(
      and(
        eq(domains.type, "custom"),
        isNotNull(domains.nextCheckAt),
        lte(domains.nextCheckAt, new Date(now)),
      ),
    )
    .orderBy(asc(domains.nextCheckAt))
    .limit(DOMAIN_CHECK_BATCH);
  // One statement claims the batch, so overlapping ticks never check a domain twice.
  const claimed = await db
    .update(domains)
    .set({ nextCheckAt: new Date(now + CLAIM_LEASE_MS) })
    .where(inArray(domains.id, due))
    .returning();
  if (!claimed.length) return { checked: 0, verified: 0, failed: 0 };

  const owners = await db
    .select({ serviceId: services.id, workspaceId: projects.workspaceId })
    .from(services)
    .innerJoin(projects, eq(projects.id, services.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(
      and(
        inArray(services.id, [...new Set(claimed.map((d) => d.serviceId))]),
        isNull(services.deletedAt),
        isNull(projects.deletedAt),
        isNull(workspaces.deletedAt),
      ),
    );
  const workspaceOf = new Map(owners.map((o) => [o.serviceId, o.workspaceId]));
  let verified = 0;
  let failed = 0;
  for (const d of claimed) {
    const workspaceId = workspaceOf.get(d.serviceId);
    if (!workspaceId) {
      await db.update(domains).set({ nextCheckAt: null }).where(eq(domains.id, d.id));
      continue;
    }
    try {
      const after = await checkDomain({ db, env, now }, d, workspaceId);
      if (after.verificationStatus === "verified" && d.verificationStatus !== "verified")
        verified++;
      if (after.status === "failed" && d.status !== "failed") failed++;
    } catch (err) {
      // The lease expires, so the next tick after it retries this domain.
      console.error("domain check failed", d.id, err instanceof Error ? err.name : "error");
    }
  }
  return { checked: claimed.length, verified, failed };
}
