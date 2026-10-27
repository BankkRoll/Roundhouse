/**
 * Custom domain routes (ADR 0009, direct mode). The rules for adding and
 * removing live in `lib/domains/manage`, shared with change set apply.
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
import { domains } from "@roundhouse/db";
import { hstsProblems } from "@roundhouse/shared";
import { eq } from "drizzle-orm";
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
import { checkDomain, refreshServiceNodes } from "../lib/domains/check";
import {
  addCustomDomain,
  assertServesTraffic,
  checkCustomHostname,
  removeCustomDomain,
} from "../lib/domains/manage";
import { presentDomains } from "../lib/domains/present";
import { ApiError, conflict, notFound } from "../lib/errors";
import { environmentOf, serviceScope } from "../lib/scope";

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
    assertServesTraffic(service);
    const hostname = await checkCustomHostname(c, db, body.hostname);
    const checked = await addCustomDomain(c, {
      workspaceId: project.workspaceId,
      service,
      environment: env,
      hostname,
      actor: caller.actor,
    });
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
    await removeCustomDomain(c, {
      workspaceId: project.workspaceId,
      domain,
      actor: caller.actor,
    });
    return c.body(null, 204);
  });
