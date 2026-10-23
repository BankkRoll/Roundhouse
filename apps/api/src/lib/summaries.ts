/**
 * Project summaries: each service's latest config version, first domain and
 * newest deployment in one environment, for the home page, the sidebar and
 * the project page.
 *
 * Every lookup is one query over the whole scope (a project's environment, or
 * every project's production environment in a workspace), joined rather than
 * filtered with `IN (…)` lists, so the cost doesn't grow with the number of
 * services and D1's bound-parameter limit never applies.
 *
 * @module
 */
import {
  builds,
  type Db,
  deployments,
  domains,
  environments,
  projects,
  serviceConfigs,
  services,
} from "@openrail/db";
import type { TlsMode } from "@openrail/shared";
import { and, asc, eq, isNull, type SQL, sql } from "drizzle-orm";
import {
  toApiDeployment,
  toApiDomain,
  toApiEnvironment,
  toApiProject,
  toApiService,
} from "./serialize";

/** What to summarise: one environment of one project, or every project's production. */
export type SummaryScope =
  | { kind: "project"; projectId: string; environmentId: string }
  | { kind: "workspace"; workspaceId: string };

const productionFirst = sql`CASE WHEN ${environments.kind} = 'production' THEN 0 ELSE 1 END`;

/** Conditions selecting the summarised projects and environments. */
function scopeFilter(scope: SummaryScope): SQL {
  return scope.kind === "project"
    ? and(eq(projects.id, scope.projectId), eq(environments.id, scope.environmentId))!
    : and(
        eq(projects.workspaceId, scope.workspaceId),
        isNull(projects.deletedAt),
        eq(environments.kind, "production"),
      )!;
}

/**
 * Builds the summaries of every project in `scope`.
 *
 * @param db - Database client.
 * @param scope - Project environment, or a whole workspace.
 * @param tlsMode - Current TLS mode, for domain URLs.
 * @returns One summary per project, ordered by name; services in creation order.
 */
export async function projectSummaries(db: Db, scope: SummaryScope, tlsMode: TlsMode) {
  const where = scopeFilter(scope);
  const projectWhere =
    scope.kind === "project"
      ? eq(projects.id, scope.projectId)
      : and(eq(projects.workspaceId, scope.workspaceId), isNull(projects.deletedAt));
  const latestConfig = sql`(SELECT MAX(c2.version) FROM service_configs c2 WHERE c2.service_id = ${serviceConfigs.serviceId} AND c2.environment_id = ${serviceConfigs.environmentId})`;
  const latestDeployment = sql`(SELECT MAX(d2.id) FROM deployments d2 WHERE d2.service_id = ${deployments.serviceId} AND d2.environment_id = ${deployments.environmentId})`;

  const [projectRows, envRows, serviceRows, configRows, deploymentRows, domainRows] =
    await Promise.all([
      db.select().from(projects).where(projectWhere).orderBy(asc(projects.name), asc(projects.id)),
      db
        .select({ environment: environments })
        .from(environments)
        .innerJoin(projects, eq(projects.id, environments.projectId))
        .where(projectWhere)
        .orderBy(productionFirst, asc(environments.id)),
      db
        .select({ service: services })
        .from(services)
        .innerJoin(projects, eq(projects.id, services.projectId))
        .where(and(projectWhere, isNull(services.deletedAt)))
        .orderBy(asc(services.id)),
      db
        .select({
          serviceId: serviceConfigs.serviceId,
          version: serviceConfigs.version,
          source: serviceConfigs.source,
        })
        .from(serviceConfigs)
        .innerJoin(services, eq(services.id, serviceConfigs.serviceId))
        .innerJoin(projects, eq(projects.id, services.projectId))
        .innerJoin(environments, eq(environments.id, serviceConfigs.environmentId))
        .where(and(where, isNull(services.deletedAt), eq(serviceConfigs.version, latestConfig))),
      db
        .select({ deployment: deployments, build: builds, projectId: services.projectId })
        .from(deployments)
        .leftJoin(builds, eq(builds.id, deployments.buildId))
        .innerJoin(services, eq(services.id, deployments.serviceId))
        .innerJoin(projects, eq(projects.id, services.projectId))
        .innerJoin(environments, eq(environments.id, deployments.environmentId))
        .where(and(where, isNull(services.deletedAt), eq(deployments.id, latestDeployment))),
      db
        .select({ domain: domains })
        .from(domains)
        .innerJoin(services, eq(services.id, domains.serviceId))
        .innerJoin(projects, eq(projects.id, services.projectId))
        .innerJoin(environments, eq(environments.id, domains.environmentId))
        .where(and(where, isNull(services.deletedAt)))
        .orderBy(asc(domains.id)),
    ]);

  const configOf = new Map(configRows.map((r) => [r.serviceId, r]));
  const deploymentOf = new Map(
    deploymentRows.map((r) => [
      r.deployment.serviceId,
      toApiDeployment(r.deployment, r.build, r.projectId),
    ]),
  );
  const domainOf = new Map<string, { hostname: string; url: string }>();
  for (const { domain } of domainRows) {
    if (domainOf.has(domain.serviceId)) continue;
    const { hostname, url } = toApiDomain(domain, tlsMode);
    domainOf.set(domain.serviceId, { hostname, url });
  }

  return projectRows.map((project) => {
    const envs = envRows.filter((r) => r.environment.projectId === project.id);
    const summarised =
      scope.kind === "project"
        ? envs.find((r) => r.environment.id === scope.environmentId)
        : envs.find((r) => r.environment.kind === "production");
    return {
      ...toApiProject(project),
      environment: summarised ? toApiEnvironment(summarised.environment) : null,
      environments: envs.map((r) => toApiEnvironment(r.environment)),
      services: serviceRows
        .filter((r) => r.service.projectId === project.id)
        .map(({ service }) => {
          const config = summarised ? configOf.get(service.id) : undefined;
          return {
            service: toApiService(service),
            config_version: config?.version ?? null,
            source: config?.source ?? null,
            domain: (summarised && domainOf.get(service.id)) || null,
            latest_deployment: (summarised && deploymentOf.get(service.id)) || null,
          };
        }),
    };
  });
}
