/**
 * MSW handlers for the custom-domain routes (`apps/api/src/routes/domains.ts`) against
 * the in-memory {@link db}. `contract.test.ts` validates every response against the
 * API's schemas.
 *
 * There is no DNS here, so hostnames steer the checker: each `POST …/check` moves a
 * domain one step, `pending_dns → pending_verification → active`; names starting
 * `ready.` are found at once (active on add), and names starting `fail-` fail on their
 * first check. Responses carry the workspace's servers as `routing_nodes`, each serving
 * when it holds a placement of a live deployment of the service, and an issued
 * certificate's per-node states on those servers.
 *
 * @module
 */
import {
  acmeDelegationName,
  acmeDelegationTarget,
  CUSTOM_HOSTNAME_PROBLEM_MESSAGES,
  customHostnameProblem,
  DEFAULT_HSTS,
  type DeploymentStatus,
  hstsProblems,
  isWildcardHostname,
  MAX_CUSTOM_DOMAINS_PER_SERVICE,
  normalizeHostname,
  ownershipRecordName,
  ownershipRecordValue,
} from "@roundhouse/shared";
import { HttpResponse, http } from "msw";
import {
  AddDomainBody,
  DOMAIN_ROUTES,
  policyOf,
  UpdateDomainBody,
} from "../../../api/src/contracts";
import type { Domain } from "../lib/api/deploy-types";
import type { DnsRecord } from "../lib/api/domains-client";
import {
  apiError,
  currentUser,
  invalid,
  notFound,
  recordAudit,
  requireWorkspace,
  unauthorized,
} from "./common";
import { db, nextId } from "./db";
import { mockTls } from "./domains-db";
import { syncCertificates, wildcardDomainsAllowed } from "./tls-mock";

type RouteName = keyof typeof DOMAIN_ROUTES;

function mswPath(name: RouteName): string {
  return `*${DOMAIN_ROUTES[name].path.replace(/\{([^}]+)\}/g, ":$1")}`;
}

const actionOf = (name: RouteName) => policyOf(DOMAIN_ROUTES[name]).action!;

function workspaceOfService(serviceId: string) {
  const service = db.deploy.services.find((row) => row.id === serviceId && !row.deleted);
  const project = service
    ? db.deploy.projects.find((row) => row.id === service.project_id && !row.deleted)
    : undefined;
  return project ? { service: service!, workspaceId: project.workspace_id } : undefined;
}

/** The API's order: 401, then 404 for missing rows and non-members, then 403. */
function authorizeService(serviceId: string, name: RouteName, what = "Service") {
  if (!currentUser()) return { ok: false as const, response: unauthorized() };
  const found = workspaceOfService(serviceId);
  if (!found) return { ok: false as const, response: notFound(what) };
  const guard = requireWorkspace(found.workspaceId, actionOf(name));
  if (!guard.ok) {
    return {
      ok: false as const,
      response: guard.response.status === 404 ? notFound(what) : guard.response,
    };
  }
  return { ok: true as const, ...found, guard };
}

function authorizeDomain(domainId: string, name: RouteName) {
  if (!currentUser()) return { ok: false as const, response: unauthorized() };
  const domain = db.deploy.domains.find((row) => row.id === domainId);
  if (!domain) return { ok: false as const, response: notFound("Domain") };
  const found = authorizeService(domain.service_id, name, "Domain");
  return found.ok ? { ...found, domain } : found;
}

const LIVE: ReadonlySet<DeploymentStatus> = new Set(["deploying", "active"]);

function routingNodes(domain: Domain): Domain["routing_nodes"] {
  const workspaceId = workspaceOfService(domain.service_id)?.workspaceId;
  const live = new Set(
    db.deploy.deployments
      .filter(
        (row) =>
          row.service_id === domain.service_id &&
          row.environment_id === domain.environment_id &&
          LIVE.has(row.status),
      )
      .map((row) => row.id),
  );
  const serving = new Set(
    db.deploy.placements.filter((row) => live.has(row.deployment_id)).map((row) => row.node_id),
  );
  return db.nodes
    .filter((node) => node.workspace_id === workspaceId)
    .map((node) => ({
      id: node.id,
      name: node.name,
      public_ip: node.public_ip,
      serves: serving.has(node.id),
    }));
}

/**
 * A stored domain as the API presents it: its workspace's servers, and its
 * certificate's state on each one serving it.
 *
 * @param domain - A row of `db.deploy.domains`.
 * @returns The wire shape.
 */
export function presentDomain(domain: Domain): Domain {
  const routing = routingNodes(domain);
  const state = domain.tls.status;
  const nodes =
    state === "disabled"
      ? []
      : routing
          .filter((node) => node.serves)
          .map((node) => ({
            node_id: node.id,
            name: node.name,
            state,
            error: state === "failed" ? domain.tls.error : null,
          }));
  return { ...domain, routing_nodes: routing, tls: { ...domain.tls, nodes } };
}

function token(): string {
  let out = "";
  for (let i = 0; i < 64; i++) out += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return out;
}

function withStates(domain: Domain, routing: DnsRecord["state"], ownership: DnsRecord["state"]) {
  domain.records = domain.records.map((r) => ({
    ...r,
    state: r.purpose === "ownership" ? ownership : routing,
  }));
}

/** Moves a domain one step, as one real check would after the customer adds a record. */
function advance(domain: Domain) {
  const now = Date.now();
  domain.last_checked_at = now;
  if (domain.hostname.startsWith("fail-")) {
    Object.assign(domain, {
      status: "failed",
      verification_status: "failed",
      next_check_at: null,
      error: `Not verified within 72 hours. No CNAME or A/AAAA record found for ${domain.hostname}. Fix the records, then check again.`,
    });
    withStates(domain, "missing", "missing");
    return;
  }
  if (domain.status === "pending_dns" || domain.status === "failed") {
    Object.assign(domain, {
      status: "pending_verification",
      verification_status: "pending",
      next_check_at: now + 60_000,
      error: `TXT ${ownershipRecordName(domain.hostname)} not found.`,
    });
    withStates(domain, "ok", "missing");
    return;
  }
  if (domain.status === "pending_verification") {
    const off = db.deploy.instance.tls_mode === "off";
    Object.assign(domain, {
      status: "active",
      verification_status: "verified",
      tls_status: off ? "disabled" : "issued",
      tls: mockTls(off ? "disabled" : "issued", now),
      verified_at: now,
      next_check_at: now + 24 * 3600_000,
      error: null,
    });
    withStates(domain, "ok", "ok");
    syncCertificates(now);
  }
}

/** Custom-domain handlers. */
export const domainHandlers = [
  http.post(mswPath("addDomain"), async ({ request, params }) => {
    const access = authorizeService(String(params.serviceId), "addDomain");
    if (!access.ok) return access.response;
    const parsed = AddDomainBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return invalid("hostname: Invalid input");
    const body = parsed.data;
    const environment = db.deploy.environments.find(
      (row) => row.id === body.environment_id && row.project_id === access.service.project_id,
    );
    if (!environment) return notFound("Environment");
    const hostname = normalizeHostname(body.hostname);
    const appsDomain = db.deploy.instance.apps_domain;
    const problem = hostname
      ? customHostnameProblem(
          hostname,
          { appsDomain, exact: [location.hostname, db.deploy.tls.ingress_hostname] },
          { allowWildcard: wildcardDomainsAllowed() },
        )
      : "invalid";
    if (!hostname || problem === "invalid")
      return invalid(CUSTOM_HOSTNAME_PROBLEM_MESSAGES.invalid);
    if (problem) {
      return apiError(422, "hostname_not_allowed", CUSTOM_HOSTNAME_PROBLEM_MESSAGES[problem]);
    }
    const config = db.deploy.configs
      .filter(
        (row) => row.service_id === access.service.id && row.environment_id === environment.id,
      )
      .sort((a, b) => b.version - a.version)[0];
    const port = config?.networking.port ?? null;
    if (port === null) {
      return apiError(
        409,
        "conflict",
        `${access.service.name} has no port in ${environment.name}; set one under Networking first`,
      );
    }
    const siblings = db.deploy.domains.filter(
      (row) =>
        row.service_id === access.service.id &&
        row.environment_id === environment.id &&
        row.type === "custom",
    );
    if (siblings.length >= MAX_CUSTOM_DOMAINS_PER_SERVICE) {
      return apiError(409, "conflict", "Too many custom domains");
    }
    if (db.deploy.domains.some((row) => row.hostname === hostname)) {
      return apiError(
        409,
        "domain_taken",
        `${hostname} is already added to a service on this install`,
      );
    }
    const generated = db.deploy.domains.find(
      (row) =>
        row.service_id === access.service.id &&
        row.environment_id === environment.id &&
        row.type === "generated",
    );
    const now = Date.now();
    const ingressHostname = db.deploy.tls.ingress_hostname;
    const target =
      ingressHostname ??
      generated?.hostname ??
      (appsDomain ? `ingress.${appsDomain}` : "203.0.113.10");
    const id = nextId("dom");
    const wildcard = isWildcardHostname(hostname);
    const delegation: DnsRecord[] =
      wildcard && appsDomain
        ? [
            {
              type: "CNAME",
              name: acmeDelegationName(hostname),
              value: acmeDelegationTarget(id, appsDomain),
              purpose: "acme_delegation",
              state: "missing",
              note: "Lets this install answer the DNS-01 challenges of the wildcard certificate.",
            },
          ]
        : [];
    const domain: Domain = {
      id,
      service_id: access.service.id,
      environment_id: environment.id,
      hostname,
      url: `${db.deploy.instance.tls_mode === "off" ? "http" : "https"}://${hostname}`,
      type: "custom",
      target_port: port,
      verification_status: "pending",
      tls_status: db.deploy.instance.tls_mode === "off" ? "disabled" : "pending",
      status: "pending_dns",
      apex: !wildcard && hostname.split(".").length === 2,
      wildcard,
      hsts: { ...DEFAULT_HSTS },
      tls: mockTls(db.deploy.instance.tls_mode === "off" ? "disabled" : "pending", now),
      routing_nodes: [],
      records: [
        {
          type: ingressHostname || generated || appsDomain ? "CNAME" : "A",
          name: hostname,
          value: target,
          purpose: "routing",
          state: "missing",
          note: null,
        },
        {
          type: "TXT",
          name: ownershipRecordName(hostname),
          value: ownershipRecordValue(token()),
          purpose: "ownership",
          state: "missing",
          note: null,
        },
        ...delegation,
      ],
      error: `No CNAME or A/AAAA record found for ${hostname}. TXT ${ownershipRecordName(hostname)} not found.`,
      last_checked_at: now,
      next_check_at: now + 60_000,
      verified_at: null,
      created_at: now,
    };
    if (hostname.startsWith("ready.")) {
      advance(domain);
      advance(domain);
    }
    db.deploy.domains.push(domain);
    syncCertificates(now);
    recordAudit({
      workspaceId: access.workspaceId,
      actorType: "user",
      actorId: access.guard.user.id,
      action: "domain.added",
      targetType: "domain",
      targetId: domain.id,
      metadata: { hostname, service_id: domain.service_id, environment_id: domain.environment_id },
    });
    return HttpResponse.json(presentDomain(domain), { status: 201 });
  }),

  http.get(mswPath("getDomain"), ({ params }) => {
    const access = authorizeDomain(String(params.domainId), "getDomain");
    if (!access.ok) return access.response;
    return HttpResponse.json(presentDomain(access.domain));
  }),

  http.patch(mswPath("updateDomain"), async ({ request, params }) => {
    const parsed = UpdateDomainBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return invalid("hsts: Invalid input");
    const access = authorizeDomain(String(params.domainId), "updateDomain");
    if (!access.ok) return access.response;
    const { domain } = access;
    if (domain.type !== "custom") {
      return apiError(409, "conflict", "Generated domains use the default HSTS policy");
    }
    const { hsts, confirm_preload } = parsed.data;
    const problems = hstsProblems(hsts, domain.hostname, domain.apex);
    if (problems.length) {
      return apiError(
        422,
        "invalid_hsts",
        problems.join(" "),
        problems.map((message) => ({ field: "hsts", code: "invalid_hsts", message })),
      );
    }
    if (hsts.preload && !domain.hsts.preload && confirm_preload !== domain.hostname) {
      return apiError(
        422,
        "preload_confirmation_required",
        `Preloading is effectively irreversible. Type ${domain.hostname} to confirm.`,
      );
    }
    const before = domain.hsts;
    domain.hsts = { ...hsts };
    recordAudit({
      workspaceId: access.workspaceId,
      actorType: "user",
      actorId: access.guard.user.id,
      action: "domain.updated",
      targetType: "domain",
      targetId: domain.id,
      metadata: { hostname: domain.hostname, before: { hsts: before }, after: { hsts } },
    });
    return HttpResponse.json(presentDomain(domain));
  }),

  http.post(mswPath("recheckDomain"), ({ params }) => {
    const access = authorizeDomain(String(params.domainId), "recheckDomain");
    if (!access.ok) return access.response;
    if (access.domain.type !== "custom") {
      return apiError(409, "conflict", "Generated domains are always verified");
    }
    const before = access.domain.verification_status;
    advance(access.domain);
    if (before !== "verified" && access.domain.verification_status === "verified") {
      recordAudit({
        workspaceId: access.workspaceId,
        actorType: "user",
        actorId: access.guard.user.id,
        action: "domain.verified",
        targetType: "domain",
        targetId: access.domain.id,
        metadata: { hostname: access.domain.hostname },
      });
    }
    return HttpResponse.json(presentDomain(access.domain));
  }),

  http.delete(mswPath("removeDomain"), ({ params }) => {
    const access = authorizeDomain(String(params.domainId), "removeDomain");
    if (!access.ok) return access.response;
    if (access.domain.type !== "custom") {
      return apiError(409, "conflict", "Turn off the generated domain under Networking instead");
    }
    db.deploy.domains = db.deploy.domains.filter((row) => row.id !== access.domain.id);
    syncCertificates();
    recordAudit({
      workspaceId: access.workspaceId,
      actorType: "user",
      actorId: access.guard.user.id,
      action: "domain.removed",
      targetType: "domain",
      targetId: access.domain.id,
      metadata: { hostname: access.domain.hostname },
    });
    return new HttpResponse(null, { status: 204 });
  }),
];
