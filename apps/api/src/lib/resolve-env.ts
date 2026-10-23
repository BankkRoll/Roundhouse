/**
 * Resolves one service's runtime environment outside a deployment, for
 * `POST /v1/services/{serviceId}/variables/resolve` (`roundhouse run`).
 *
 * It builds the same inputs the deploy workflow's `resolveEnv` step builds
 * (every live service's variables and built-ins, the environment's shared
 * variables) and runs the same `resolveVariables`, so a value resolves here
 * exactly as it would in a deployment started now. The deployment-specific
 * built-ins come from the service's live deployment, if any.
 *
 * The deploy workflow calls it too, with {@link ResolveOptions.deployment}
 * naming the deployment being rolled out, so the route and the pipeline
 * cannot drift apart.
 *
 * @module
 */
import {
  builds,
  type Db,
  deployments,
  domains,
  type environments,
  serviceConfigs,
  services,
} from "@roundhouse/db";
import {
  type BuiltinVariable,
  type ResolveVariablesResult,
  resolveVariables,
} from "@roundhouse/shared";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { LIVE_DEPLOYMENT_STATUSES, privateDomain } from "./desired-state";
import { loadEnvironmentVariables } from "./variables";

/** Which service to resolve, and where. */
export interface ResolveTarget {
  projectId: string;
  serviceId: string;
  environment: typeof environments.$inferSelect;
}

/** How {@link resolveServiceEnvironment} resolves for a deployment in flight. */
export interface ResolveOptions {
  /**
   * The deployment being rolled out, instead of the service's live one: its
   * ID and commit become the built-ins, and the service's own `PORT` comes
   * from the config version it runs with rather than the latest one.
   */
  deployment?: { id: string; commitSha: string | null; configVersion: number };
  /**
   * More variables of the service itself, resolved exactly like its own
   * (the deploy workflow passes the build args this way, so they may
   * reference variables). Their keys must not collide with real variables.
   */
  extra?: Record<string, string>;
}

/**
 * Resolves a service's environment as a deployment would get it.
 *
 * @param db - Database client.
 * @param key - Project DEK.
 * @param target - Project, service and environment.
 * @param options - Resolve for a specific deployment; see {@link ResolveOptions}.
 * @returns The environment, or every resolution error.
 */
export async function resolveServiceEnvironment(
  db: Db,
  key: CryptoKey,
  target: ResolveTarget,
  options: ResolveOptions = {},
): Promise<ResolveVariablesResult> {
  const { projectId, serviceId, environment } = target;
  const [vars, live, configs, hosts, [current]] = await Promise.all([
    loadEnvironmentVariables(db, key, projectId, environment.id),
    db
      .select({ id: services.id, slug: services.slug, name: services.name })
      .from(services)
      .where(and(eq(services.projectId, projectId), isNull(services.deletedAt))),
    db
      .select({
        serviceId: serviceConfigs.serviceId,
        version: serviceConfigs.version,
        networking: serviceConfigs.networking,
      })
      .from(serviceConfigs)
      .innerJoin(services, eq(services.id, serviceConfigs.serviceId))
      .where(
        and(eq(serviceConfigs.environmentId, environment.id), eq(services.projectId, projectId)),
      )
      .orderBy(desc(serviceConfigs.version)),
    db
      .select({ serviceId: domains.serviceId, hostname: domains.hostname })
      .from(domains)
      .where(eq(domains.environmentId, environment.id))
      .orderBy(domains.id),
    db
      .select({ id: deployments.id, commitSha: builds.commitSha })
      .from(deployments)
      .leftJoin(builds, eq(builds.id, deployments.buildId))
      .where(
        and(
          eq(deployments.serviceId, serviceId),
          eq(deployments.environmentId, environment.id),
          inArray(deployments.status, [...LIVE_DEPLOYMENT_STATUSES]),
        ),
      )
      .orderBy(desc(deployments.id))
      .limit(1),
  ]);

  // Rows are newest version first, so the first one per service is the
  // latest; a deployment's own service uses exactly its config version.
  const pinned = options.deployment?.configVersion;
  const portOf = new Map<string, number | null>();
  for (const c of configs) {
    if (c.serviceId === serviceId && pinned !== undefined) {
      if (c.version === pinned) portOf.set(c.serviceId, c.networking.port);
    } else if (!portOf.has(c.serviceId)) portOf.set(c.serviceId, c.networking.port);
  }
  const hostOf = new Map<string, string>();
  for (const h of hosts) if (!hostOf.has(h.serviceId)) hostOf.set(h.serviceId, h.hostname);

  const builtins: Record<string, Partial<Record<BuiltinVariable, string>>> = {};
  let slug: string | undefined;
  for (const s of live) {
    const port = portOf.get(s.id);
    const host = hostOf.get(s.id);
    builtins[s.slug] = {
      ...(port ? { PORT: String(port) } : {}),
      ...(host ? { ROUNDHOUSE_PUBLIC_DOMAIN: host } : {}),
      ROUNDHOUSE_PRIVATE_DOMAIN: privateDomain(s.slug, environment.slug),
      ROUNDHOUSE_ENVIRONMENT: environment.slug,
      ROUNDHOUSE_SERVICE_NAME: s.name,
    };
    if (s.id === serviceId) slug = s.slug;
  }
  if (!slug) return { ok: true, env: {} };
  const deployment = options.deployment ?? current;
  if (deployment) {
    builtins[slug]!.ROUNDHOUSE_DEPLOYMENT_ID = deployment.id;
    if (deployment.commitSha) builtins[slug]!.ROUNDHOUSE_GIT_COMMIT_SHA = deployment.commitSha;
  }
  const variables = options.extra
    ? { ...vars.services, [slug]: { ...(vars.services[slug] ?? {}), ...options.extra } }
    : vars.services;
  return resolveVariables({
    service: slug,
    services: variables,
    shared: vars.shared,
    builtins,
  });
}
