/**
 * Adding and removing custom domains (ADR 0009, direct mode), shared by the
 * domain routes and change set apply so both enforce the same rules:
 *
 * - {@link checkCustomHostname}: normalisation and the names the install owns.
 * - {@link assertServesTraffic}: cron services (ADR 0010) take no domains.
 * - {@link domainPort} / {@link assertDomainCapacity}: a service needs a port,
 *   and at most `MAX_CUSTOM_DOMAINS_PER_SERVICE` domains per environment.
 * - {@link hostnameHolder}: instance-wide uniqueness, with takeover of a
 *   hostname that failed long ago or whose service is gone.
 * - {@link addCustomDomain} / {@link removeCustomDomain}: the writes, their
 *   audit records, the first DNS check and the route refresh on removal.
 *
 * @module
 */
import { type Db, domains, projects, services } from "@roundhouse/db";
import {
  CUSTOM_HOSTNAME_PROBLEM_MESSAGES,
  customHostnameProblem,
  DOMAIN_TAKEOVER_AFTER_MS,
  MAX_CUSTOM_DOMAINS_PER_SERVICE,
  newId,
  normalizeHostname,
} from "@roundhouse/shared";
import { and, count, eq } from "drizzle-orm";
import { type AppContext, type AuditActor, clientIp } from "../../context";
import { recordAudit } from "../audit";
import { ApiError, conflict, isUniqueViolation, notFound } from "../errors";
import { publicOrigin } from "../origin";
import { latestConfig } from "../projects";
import { getIngressSettings, getSetting } from "../settings";
import { checkDomain, refreshServiceNodes } from "./check";
import { type DnsLookupError, type Resolution, resolveDomain } from "./dns";
import { INGRESS_HOSTNAME_SETTING } from "./records";

/** A `domains` row. */
export type DomainRow = typeof domains.$inferSelect;

/**
 * Refuses a domain for a service that serves no traffic.
 *
 * @param service - The service the domain would route to.
 * @throws {ApiError} 422 `cron_has_no_endpoint` for a cron service.
 */
export function assertServesTraffic(service: { kind: string }): void {
  if (service.kind === "cron") {
    throw new ApiError(422, "cron_has_no_endpoint", "A cron service serves no traffic");
  }
}

/**
 * Normalises a hostname and refuses names that can't be a custom domain:
 * wildcards, IPs, non-public names, and the install's own names.
 *
 * @param c - Request context (for the public origin).
 * @param db - Database client.
 * @param input - The hostname as given.
 * @returns The normalised hostname.
 * @throws {ApiError} 400 for an invalid name, 422 `hostname_not_allowed`.
 */
export async function checkCustomHostname(c: AppContext, db: Db, input: string): Promise<string> {
  const hostname = normalizeHostname(input);
  if (!hostname) {
    throw new ApiError(400, "invalid_request", CUSTOM_HOSTNAME_PROBLEM_MESSAGES.invalid);
  }
  const ingress = await getIngressSettings(db);
  const ingressHostname = await getSetting<unknown>(db, INGRESS_HOSTNAME_SETTING);
  const problem = customHostnameProblem(hostname, {
    appsDomain: ingress.appsDomain,
    exact: [
      new URL(publicOrigin(c)).hostname,
      typeof ingressHostname === "string" ? ingressHostname : null,
    ],
  });
  if (problem === "invalid") {
    throw new ApiError(400, "invalid_request", CUSTOM_HOSTNAME_PROBLEM_MESSAGES.invalid);
  }
  if (problem) {
    throw new ApiError(422, "hostname_not_allowed", CUSTOM_HOSTNAME_PROBLEM_MESSAGES[problem]);
  }
  return hostname;
}

/**
 * The port a new domain routes to.
 *
 * @param port - `networking.port` of the service's config in the environment.
 * @param names - Service and environment names for the message.
 * @returns The port.
 * @throws {ApiError} 409 when the service has no port.
 */
export function domainPort(
  port: number | null | undefined,
  names: { service: string; environment: string },
): number {
  if (!port) {
    throw conflict(
      `${names.service} has no port in ${names.environment}; set one under Networking first`,
    );
  }
  return port;
}

/**
 * Refuses a domain past the per-service, per-environment limit.
 *
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @param adding - How many more are about to be added.
 * @throws {ApiError} 409 at the limit.
 */
export async function assertDomainCapacity(
  db: Db,
  serviceId: string,
  environmentId: string,
  adding = 1,
): Promise<void> {
  const [{ n }] = (await db
    .select({ n: count() })
    .from(domains)
    .where(
      and(
        eq(domains.serviceId, serviceId),
        eq(domains.environmentId, environmentId),
        eq(domains.type, "custom"),
      ),
    )) as [{ n: number }];
  if (n + adding > MAX_CUSTOM_DOMAINS_PER_SERVICE) {
    throw conflict(
      `A service can have at most ${MAX_CUSTOM_DOMAINS_PER_SERVICE} custom domains per environment`,
    );
  }
}

/** Who holds a hostname, and whether it may be taken over. */
export type HostnameHolder =
  | { taken: false }
  | { taken: true; stale: boolean; row: DomainRow; workspaceId: string };

/**
 * Who holds a hostname on this install. A holder is `stale` (may give it up)
 * when it is a custom domain that failed long ago, or whose service or
 * project is gone. Generated domains are never taken over (their names are
 * under the apps domain, which {@link checkCustomHostname} refuses anyway).
 *
 * @param db - Database client.
 * @param hostname - A normalised hostname.
 * @param now - Unix ms.
 * @returns The holder, if any.
 */
export async function hostnameHolder(
  db: Db,
  hostname: string,
  now: number,
): Promise<HostnameHolder> {
  const [row] = await db
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
  if (!row) return { taken: false };
  const d = row.domain;
  const stale =
    d.type === "custom" &&
    (row.serviceDeleted !== null ||
      row.projectDeleted !== null ||
      (d.status === "failed" && now - +d.updatedAt > DOMAIN_TAKEOVER_AFTER_MS));
  return { taken: true, stale, row: d, workspaceId: row.workspaceId };
}

/**
 * 409 `domain_taken`.
 *
 * @param hostname - The hostname.
 * @returns The error to throw.
 */
export const domainTaken = (hostname: string) =>
  new ApiError(409, "domain_taken", `${hostname} is already added to a service on this install`);

/**
 * Refuses a hostname another live service holds.
 *
 * @param db - Database client.
 * @param hostname - A normalised hostname.
 * @param now - Unix ms.
 * @returns The (stale or absent) holder, for {@link addCustomDomain}.
 * @throws {ApiError} 409 `domain_taken`.
 */
export async function assertHostnameFree(
  db: Db,
  hostname: string,
  now: number,
): Promise<HostnameHolder> {
  const holder = await hostnameHolder(db, hostname, now);
  if (holder.taken && !holder.stale) throw domainTaken(hostname);
  return holder;
}

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** What {@link addCustomDomain} adds, and on whose behalf. */
export interface AddDomainInput {
  workspaceId: string;
  service: { id: string; name: string };
  environment: { id: string; name: string };
  /** Already checked with {@link checkCustomHostname}. */
  hostname: string;
  actor: AuditActor;
  /** Extra audit metadata, e.g. `{ change_set_id }`. */
  auditMetadata?: Record<string, unknown>;
}

/**
 * Adds a custom hostname to a service in an environment and checks its DNS
 * once: the port, limit and uniqueness checks, the takeover of a stale
 * holder, the insert, its audit record and the first check.
 *
 * @param c - Request context.
 * @param input - Service, environment, hostname and actor.
 * @returns The domain after its first check.
 * @throws {ApiError} 409 without a port, at the limit, or when taken.
 */
export async function addCustomDomain(c: AppContext, input: AddDomainInput): Promise<DomainRow> {
  const db = c.get("db");
  const { hostname, service, environment } = input;
  const config = await latestConfig(db, service.id, environment.id);
  const port = domainPort(config?.networking.port, {
    service: service.name,
    environment: environment.name,
  });
  await assertDomainCapacity(db, service.id, environment.id);
  const now = Date.now();
  const existing = await assertHostnameFree(db, hostname, now);
  const ingress = await getIngressSettings(db);

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
      serviceId: service.id,
      environmentId: environment.id,
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
    if (isUniqueViolation(err, "domains.hostname")) throw domainTaken(hostname);
    throw err;
  }
  await recordAudit(db, {
    workspaceId: input.workspaceId,
    ...input.actor,
    action: "domain.added",
    targetType: "domain",
    targetId: id,
    metadata: {
      hostname,
      service_id: service.id,
      environment_id: environment.id,
      ...input.auditMetadata,
    },
    ip: clientIp(c),
  });
  return checkDomain(
    { db, env: c.env, now },
    row,
    input.workspaceId,
    input.actor,
    resolution ? { resolution } : {},
  );
}

/**
 * Removes a custom domain and pulls its route from the service's nodes.
 *
 * @param c - Request context.
 * @param input - The domain, its workspace and the actor.
 * @throws {ApiError} 409 for a generated domain, 404 when already gone.
 */
export async function removeCustomDomain(
  c: AppContext,
  input: {
    workspaceId: string;
    domain: DomainRow;
    actor: AuditActor;
    auditMetadata?: Record<string, unknown>;
  },
): Promise<void> {
  const { domain } = input;
  if (domain.type !== "custom") {
    throw conflict("Turn off the generated domain under Networking instead");
  }
  const db = c.get("db");
  const [gone] = await db.delete(domains).where(eq(domains.id, domain.id)).returning();
  if (!gone) throw notFound("Domain");
  await recordAudit(db, {
    workspaceId: input.workspaceId,
    ...input.actor,
    action: "domain.removed",
    targetType: "domain",
    targetId: domain.id,
    metadata: {
      hostname: domain.hostname,
      service_id: domain.serviceId,
      environment_id: domain.environmentId,
      ...input.auditMetadata,
    },
    ip: clientIp(c),
  });
  if (domain.verificationStatus === "verified") {
    await refreshServiceNodes(c.env, db, domain.serviceId, domain.environmentId);
  }
}
