/**
 * Whether a service may run on Cloudflare Containers (ADR 0011
 * "Eligibility and settings"), with real facts:
 * - {@link cloudflareFactsFor} gathers what `cloudflareEligibility` needs
 *   (kind, port, volume, TCP proxy, custom domains and their mode,
 *   resources, image architectures);
 * - {@link cloudflareProblems} adds the instance-level precondition
 *   (`not_configured`: no account, apps domain not proxied, no apps zone);
 * - {@link assertCloudflareEligible} turns failures into
 *   `422 provider_ineligible` naming every failing rule;
 * - {@link databaseUrlWarnings}: non-fatal, a reference to a database's
 *   `DATABASE_URL` that a Cloudflare container cannot reach (TCP).
 *
 * @module
 */
import { type Db, domains, services, tcpProxies } from "@roundhouse/db";
import {
  type CloudflareEligibilityFailure,
  type CloudflareEligibilityInput,
  cloudflareEligibility,
  type ServiceConfigSpec,
  type ServiceKind,
} from "@roundhouse/shared";
import { and, eq, isNull } from "drizzle-orm";
import { ApiError } from "../errors";
import type { KeyEnv } from "../keyring";
import { loadEnvironmentVariables, projectKey } from "../variables";
import { volumeOf } from "../volumes";
import { readCloudflareAccount } from "./settings";

/** A failed rule: the shared ones plus `not_configured` (the instance setting). */
export interface ProviderProblem {
  rule: CloudflareEligibilityFailure["rule"] | "not_configured";
  message: string;
}

/** Changes a staged apply makes that the database does not show yet. */
export interface PendingFacts {
  /** A staged `volume.set` creates (`true`) or a `volume.delete` removes (`false`) the volume. */
  volume?: boolean;
  /** Custom hostnames a staged `domain.add` adds; they start in `direct` mode. */
  addedDomains?: readonly string[];
  /** Domain IDs a staged `domain.remove` removes. */
  removedDomainIds?: readonly string[];
}

/**
 * Collects the eligibility facts of one service in one environment.
 *
 * @param db - Database client.
 * @param service - The service's ID and kind.
 * @param environmentId - The environment.
 * @param spec - The config to check (the one an apply leaves).
 * @param pending - Staged changes not in the database yet.
 * @returns Input for `cloudflareEligibility`.
 */
export async function cloudflareFactsFor(
  db: Db,
  service: { id: string; kind: ServiceKind },
  environmentId: string,
  spec: ServiceConfigSpec,
  pending: PendingFacts = {},
): Promise<CloudflareEligibilityInput> {
  const [volume, proxy, custom] = await Promise.all([
    volumeOf(db, service.id, environmentId),
    db
      .select({ id: tcpProxies.id })
      .from(tcpProxies)
      .where(and(eq(tcpProxies.serviceId, service.id), eq(tcpProxies.environmentId, environmentId)))
      .limit(1),
    db
      .select({ id: domains.id, hostname: domains.hostname, mode: domains.mode })
      .from(domains)
      .where(
        and(
          eq(domains.serviceId, service.id),
          eq(domains.environmentId, environmentId),
          eq(domains.type, "custom"),
        ),
      ),
  ]);
  const removed = new Set(pending.removedDomainIds ?? []);
  const customDomains = [
    ...custom
      .filter((d) => !removed.has(d.id))
      .map((d) => ({ hostname: d.hostname, saas: d.mode === "cloudflare_saas" })),
    ...(pending.addedDomains ?? []).map((hostname) => ({ hostname, saas: false })),
  ];
  const instanceType = spec.placement.cloudflare?.instance_type;
  return {
    kind: service.kind,
    port: spec.networking.port,
    resources: spec.resources,
    ...(instanceType !== undefined ? { instanceType } : {}),
    hasVolume: pending.volume ?? volume !== undefined,
    hasTcpProxy: proxy.length > 0,
    customDomains,
    // NOTE: builders record only the image digest today, not its
    // platforms; the push step checks amd64 when it copies the image.
    imageArchitectures: null,
  };
}

/**
 * Every reason a service can't run on Cloudflare now, including the
 * instance setting.
 *
 * @param db - Database client.
 * @param facts - From {@link cloudflareFactsFor}.
 * @returns Failed rules; empty when eligible.
 */
export async function cloudflareProblems(
  db: Db,
  facts: CloudflareEligibilityInput,
): Promise<ProviderProblem[]> {
  const problems: ProviderProblem[] = [];
  const account = await readCloudflareAccount(db);
  if (!account) {
    problems.push({
      rule: "not_configured",
      message: "Connect a Cloudflare account under Settings → Cloudflare first",
    });
  } else if (!account.apps_domain_proxied) {
    problems.push({
      rule: "not_configured",
      message:
        "The apps domain must be proxied through Cloudflare (Settings → Cloudflare, apps_domain_proxied): Worker routes only run on proxied hostnames",
    });
  } else if (!account.apps_zone) {
    problems.push({
      rule: "not_configured",
      message:
        "The apps domain is not in a zone of the Cloudflare account; save the Cloudflare settings again after adding it",
    });
  }
  problems.push(...cloudflareEligibility(facts));
  return problems;
}

/**
 * The 422 for a refused provider switch.
 *
 * @param problems - Every failed rule.
 * @returns `422 provider_ineligible` with one detail per rule.
 */
export function providerIneligible(problems: readonly ProviderProblem[]): ApiError {
  return new ApiError(
    422,
    "provider_ineligible",
    `This service can't run on Cloudflare: ${problems.map((p) => p.message).join("; ")}`,
    problems.map((p) => ({ field: "placement.provider", code: p.rule, message: p.message })),
  );
}

/**
 * Refuses a config that selects `cloudflare` for a service that can't run there.
 *
 * @param db - Database client.
 * @param service - The service's ID and kind.
 * @param environmentId - The environment.
 * @param spec - The resulting config.
 * @param pending - Staged changes not in the database yet.
 * @throws {ApiError} 422 `provider_ineligible`.
 */
export async function assertCloudflareEligible(
  db: Db,
  service: { id: string; kind: ServiceKind },
  environmentId: string,
  spec: ServiceConfigSpec,
  pending: PendingFacts = {},
): Promise<void> {
  const facts = await cloudflareFactsFor(db, service, environmentId, spec, pending);
  const problems = await cloudflareProblems(db, facts);
  if (problems.length) throw providerIneligible(problems);
}

/**
 * Variables of a service that reference a database's `DATABASE_URL`: a
 * Cloudflare container has no TCP path to node databases (ADR 0011
 * "Reaching node services").
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @param input - Project, environment and the service's slug.
 * @returns One sentence per referencing variable.
 */
export async function databaseUrlWarnings(
  db: Db,
  keys: KeyEnv,
  input: { projectId: string; environmentId: string; serviceSlug: string },
): Promise<string[]> {
  const databases = await db
    .select({ slug: services.slug })
    .from(services)
    .where(
      and(
        eq(services.projectId, input.projectId),
        eq(services.kind, "database"),
        isNull(services.deletedAt),
      ),
    );
  if (!databases.length) return [];
  const key = await projectKey(db, keys, input.projectId);
  const vars = await loadEnvironmentVariables(db, key, input.projectId, input.environmentId);
  const own = vars.services[input.serviceSlug] ?? {};
  const warnings: string[] = [];
  for (const [name, value] of Object.entries(own)) {
    for (const { slug } of databases) {
      const ref = new RegExp(
        `\\$\\{\\{\\s*${slug.replace(/[-]/g, "\\-")}\\.DATABASE_URL\\s*\\}\\}`,
      );
      if (ref.test(value)) {
        warnings.push(
          `${name} references ${slug}.DATABASE_URL; Cloudflare containers can't reach databases on nodes over TCP`,
        );
      }
    }
  }
  return warnings;
}
