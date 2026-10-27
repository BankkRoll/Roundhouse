/**
 * Custom domain routes (ADR 0009, direct mode).
 *
 * - Adding validates and normalises the hostname, refuses names the install
 *   owns, enforces instance-wide uniqueness (a hostname `failed` for over
 *   7 days, or left behind by a deleted service, may be taken over), mints
 *   the ownership token and checks DNS once.
 * - Wildcards (`*.example.com`) are accepted only in `managed` mode with
 *   DNS-01 available (the apps domain in the Cloudflare zone): their
 *   certificate needs the `_acme-challenge` delegation, which on-demand
 *   issuance can't do (ADR 0009).
 * - Updating changes the HSTS policy, with typed consent for `preload`, and
 *   pushes it to the nodes serving the domain.
 * - Checking now is throttled per domain and resumes a `failed` domain.
 * - Removing pulls the route from the service's nodes.
 *
 * @module
 */
import { domains, projects, services } from "@roundhouse/db";
import {
  CUSTOM_HOSTNAME_PROBLEM_MESSAGES,
  customHostnameProblem,
  DOMAIN_TAKEOVER_AFTER_MS,
  hstsProblems,
  MAX_CUSTOM_DOMAINS_PER_SERVICE,
  newId,
  normalizeHostname,
} from "@roundhouse/shared";
import { and, count, eq } from "drizzle-orm";
import { type AppContext, clientIp, createRouter } from "../context";
import {
  addDomain,
  getDomain,
  policyOf,
  recheckDomain,
  removeDomain,
  updateDomain,
} from "../contracts";
import { recordAudit } from "../lib/audit";
import { dns01Available, getCloudflareDnsView } from "../lib/certificates/settings";
import { checkDomain, refreshServiceNodes } from "../lib/domains/check";
import { type DnsLookupError, type Resolution, resolveDomain } from "../lib/domains/dns";
import { presentDomains } from "../lib/domains/present";
import { INGRESS_HOSTNAME_SETTING } from "../lib/domains/records";
import { ApiError, conflict, isUniqueViolation, notFound } from "../lib/errors";
import { publicOrigin } from "../lib/origin";
import { latestConfig } from "../lib/projects";
import { environmentOf, serviceScope } from "../lib/scope";
import { getIngressSettings, getSetting } from "../lib/settings";

/** A manual check sooner than this after the last one is refused with 429. */
export const CHECK_COOLDOWN_MS = 30_000;

type DomainRow = typeof domains.$inferSelect;
type Action = NonNullable<ReturnType<typeof policyOf>["action"]>;

/**
 * Loads a domain and authorizes the caller on its service, in its
 * environment when `withEnvironment` (so protection applies to changes).
 */
async function domainScope(
  c: AppContext,
  domainId: string,
  action: Action,
  withEnvironment: boolean,
) {
  const d = await c.get("db").query.domains.findFirst({ where: eq(domains.id, domainId) });
  if (!d) throw notFound("Domain");
  try {
    const scope = await serviceScope(
      c,
      d.serviceId,
      action,
      withEnvironment ? d.environmentId : undefined,
    );
    return { domain: d, ...scope };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) throw notFound("Domain");
    throw err;
  }
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Whether an existing row may give up its hostname: a custom domain that
 * failed long ago, or whose service or project is gone. Generated domains
 * are never taken over (their names are under the apps domain, which is
 * refused anyway).
 */
async function releasable(c: AppContext, hostname: string, now: number) {
  const [row] = await c
    .get("db")
    .select({
      domain: domains,
      serviceDeleted: services.deletedAt,
      projectDeleted: projects.deletedAt,
      workspaceId: projects.workspaceId,
    })
    .from(domains)
    .innerJoin(services, eq(services.id, domains.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .where(eq(domains.hostname, hostname))
    .limit(1);
  if (!row) return { taken: false as const };
  const d = row.domain;
  const stale =
    d.type === "custom" &&
    (row.serviceDeleted !== null ||
      row.projectDeleted !== null ||
      (d.status === "failed" && now - +d.updatedAt > DOMAIN_TAKEOVER_AFTER_MS));
  return { taken: true as const, stale, row: d, workspaceId: row.workspaceId };
}

/** Custom domain routes. */
export const domainRoutes = createRouter()
  .openapi(addDomain, async (c) => {
    const { serviceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { service, project, caller } = await serviceScope(
      c,
      serviceId,
      policyOf(addDomain).action!,
      body.environment_id,
    );
    const env = await environmentOf(c, project.id, body.environment_id);
    const db = c.get("db");

    const hostname = normalizeHostname(body.hostname);
    if (!hostname) {
      throw new ApiError(400, "invalid_request", CUSTOM_HOSTNAME_PROBLEM_MESSAGES.invalid);
    }
    const ingress = await getIngressSettings(db);
    const [ingressHostname, dns] = await Promise.all([
      getSetting<unknown>(db, INGRESS_HOSTNAME_SETTING),
      getCloudflareDnsView(db),
    ]);
    const problem = customHostnameProblem(
      hostname,
      {
        appsDomain: ingress.appsDomain,
        exact: [
          new URL(publicOrigin(c)).hostname,
          typeof ingressHostname === "string" ? ingressHostname : null,
        ],
      },
      { allowWildcard: ingress.tlsMode === "managed" && dns01Available(ingress.appsDomain, dns) },
    );
    if (problem === "invalid") {
      throw new ApiError(400, "invalid_request", CUSTOM_HOSTNAME_PROBLEM_MESSAGES.invalid);
    }
    if (problem) {
      throw new ApiError(422, "hostname_not_allowed", CUSTOM_HOSTNAME_PROBLEM_MESSAGES[problem]);
    }

    const config = await latestConfig(db, serviceId, env.id);
    const port = config?.networking.port ?? null;
    if (!port) {
      throw conflict(`${service.name} has no port in ${env.name}; set one under Networking first`);
    }
    const [{ n }] = (await db
      .select({ n: count() })
      .from(domains)
      .where(
        and(
          eq(domains.serviceId, serviceId),
          eq(domains.environmentId, env.id),
          eq(domains.type, "custom"),
        ),
      )) as [{ n: number }];
    if (n >= MAX_CUSTOM_DOMAINS_PER_SERVICE) {
      throw conflict(
        `A service can have at most ${MAX_CUSTOM_DOMAINS_PER_SERVICE} custom domains per environment`,
      );
    }

    const now = Date.now();
    const existing = await releasable(c, hostname, now);
    const taken = () =>
      new ApiError(
        409,
        "domain_taken",
        `${hostname} is already added to a service on this install`,
      );
    if (existing.taken && !existing.stale) throw taken();

    let resolution: Resolution | undefined;
    try {
      resolution = await resolveDomain(c.env, hostname, { apex: true });
    } catch (err) {
      // The first scheduled check retries; apex detection then waits for a re-add.
      console.warn("domain add lookup failed", (err as DnsLookupError).message);
    }

    const id = newId("domain");
    const insert = db
      .insert(domains)
      .values({
        id,
        serviceId,
        environmentId: env.id,
        hostname,
        type: "custom",
        targetPort: port,
        verificationStatus: "pending",
        tlsStatus: ingress.tlsMode === "off" ? "disabled" : "pending",
        status: "pending_dns",
        mode: "direct",
        verificationToken: randomToken(),
        apex: resolution?.apex ?? false,
        pendingSince: new Date(now),
        nextCheckAt: new Date(now),
      })
      .returning();
    let row: DomainRow;
    try {
      if (existing.taken) {
        const [, inserted] = await db.batch([
          db.delete(domains).where(eq(domains.id, existing.row.id)),
          insert,
        ]);
        row = inserted[0]!;
        await recordAudit(db, {
          workspaceId: existing.workspaceId,
          actorType: "system",
          actorId: null,
          action: "domain.removed",
          targetType: "domain",
          targetId: existing.row.id,
          metadata: { hostname, reason: "claimed_elsewhere" },
        });
      } else {
        [row] = (await insert) as [DomainRow];
      }
    } catch (err) {
      if (isUniqueViolation(err, "domains.hostname")) throw taken();
      throw err;
    }
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "domain.added",
      targetType: "domain",
      targetId: id,
      metadata: { hostname, service_id: serviceId, environment_id: env.id },
      ip: clientIp(c),
    });
    const checked = await checkDomain(
      { db, env: c.env, now },
      row,
      project.workspaceId,
      caller.actor,
      resolution ? { resolution } : {},
    );
    const [out] = await presentDomains(db, project.workspaceId, [checked]);
    return c.json(out!, 201);
  })
  .openapi(getDomain, async (c) => {
    const { domainId } = c.req.valid("param");
    const { domain, project } = await domainScope(c, domainId, policyOf(getDomain).action!, false);
    const [out] = await presentDomains(c.get("db"), project.workspaceId, [domain]);
    return c.json(out!, 200);
  })
  .openapi(updateDomain, async (c) => {
    const { domainId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { domain, project, caller } = await domainScope(
      c,
      domainId,
      policyOf(updateDomain).action!,
      true,
    );
    if (domain.type !== "custom") {
      throw conflict("Generated domains use the default HSTS policy");
    }
    const problems = hstsProblems(body.hsts, domain.hostname, domain.apex);
    if (problems.length) {
      throw new ApiError(
        422,
        "invalid_hsts",
        problems.join(" "),
        problems.map((message) => ({ field: "hsts", code: "invalid_hsts", message })),
      );
    }
    const before = domain.hsts;
    if (body.hsts.preload && !before?.preload && body.confirm_preload !== domain.hostname) {
      throw new ApiError(
        422,
        "preload_confirmation_required",
        `Preloading is effectively irreversible. Type ${domain.hostname} to confirm.`,
      );
    }
    const db = c.get("db");
    const [row] = (await db
      .update(domains)
      .set({ hsts: body.hsts, updatedAt: new Date() })
      .where(eq(domains.id, domain.id))
      .returning()) as [DomainRow];
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "domain.updated",
      targetType: "domain",
      targetId: domain.id,
      metadata: { hostname: domain.hostname, before: { hsts: before }, after: { hsts: body.hsts } },
      ip: clientIp(c),
    });
    if (domain.verificationStatus === "verified") {
      await refreshServiceNodes(c.env, db, domain.serviceId, domain.environmentId);
    }
    const [out] = await presentDomains(db, project.workspaceId, [row]);
    return c.json(out!, 200);
  })
  .openapi(recheckDomain, async (c) => {
    const { domainId } = c.req.valid("param");
    const { domain, project, caller } = await domainScope(
      c,
      domainId,
      policyOf(recheckDomain).action!,
      true,
    );
    if (domain.type !== "custom") throw conflict("Generated domains are always verified");
    const now = Date.now();
    if (domain.lastCheckedAt && now - +domain.lastCheckedAt < CHECK_COOLDOWN_MS) {
      const wait = Math.ceil((CHECK_COOLDOWN_MS - (now - +domain.lastCheckedAt)) / 1000);
      throw new ApiError(429, "rate_limited", `Checked moments ago; try again in ${wait}s`);
    }
    const db = c.get("db");
    let row = domain;
    if (domain.status === "failed") {
      // A fresh 72-hour window; the token stays, so records already created keep working.
      [row] = (await db
        .update(domains)
        .set({
          status: "pending_dns",
          verificationStatus: "pending",
          pendingSince: new Date(now),
          checkAttempts: 0,
          updatedAt: new Date(now),
        })
        .where(eq(domains.id, domain.id))
        .returning()) as [DomainRow];
    }
    const checked = await checkDomain(
      { db, env: c.env, now },
      row,
      project.workspaceId,
      caller.actor,
    );
    const [out] = await presentDomains(db, project.workspaceId, [checked]);
    return c.json(out!, 200);
  })
  .openapi(removeDomain, async (c) => {
    const { domainId } = c.req.valid("param");
    const { domain, project, caller } = await domainScope(
      c,
      domainId,
      policyOf(removeDomain).action!,
      true,
    );
    if (domain.type !== "custom") {
      throw conflict("Turn off the generated domain under Networking instead");
    }
    const db = c.get("db");
    const [gone] = await db.delete(domains).where(eq(domains.id, domain.id)).returning();
    if (!gone) throw notFound("Domain");
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "domain.removed",
      targetType: "domain",
      targetId: domain.id,
      metadata: {
        hostname: domain.hostname,
        service_id: domain.serviceId,
        environment_id: domain.environmentId,
      },
      ip: clientIp(c),
    });
    if (domain.verificationStatus === "verified") {
      await refreshServiceNodes(c.env, db, domain.serviceId, domain.environmentId);
    }
    return c.body(null, 204);
  });
