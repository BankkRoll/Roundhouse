/**
 * Project, environment and service bookkeeping shared by their routes: slug
 * allocation, config versions (merge and validation), generated domains, and
 * tearing a service's deployments down when it is deleted.
 *
 * @module
 */
import { type Db, deployments, domains, serviceConfigs } from "@roundhouse/db";
import {
  CANCELLABLE_DEPLOYMENT_STATUSES,
  type CronConfig,
  DEFAULT_CRON_CONFIG,
  type DomainTlsStatus,
  freeSlug as freeSharedSlug,
  generatedHostname,
  newId,
  type ServiceConfigSpec,
  scheduleError,
  slugify,
  type TlsMode,
} from "@roundhouse/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  BuildConfigSchema,
  CronConfigSchema,
  DeployConfigSchema,
  HealthcheckConfigSchema,
  NetworkingConfigSchema,
  PlacementConfigSchema,
  ResourcesConfigSchema,
  ServiceSourceSchema,
} from "../schemas";
import {
  cancelDeployment,
  IllegalTransitionError,
  type LifecycleContext,
  retireDeployments,
  transitionDeployment,
} from "./deployments";
import { refreshNodes } from "./desired-state";
import { ApiError, conflict, type ErrorDetail, isUniqueViolation } from "./errors";
import { retireServiceVolumes } from "./volumes";

/** Longest slug the API accepts. */
export const SLUG_MAX_LENGTH = 40;

/**
 * Picks `base`, or `base-2`, `base-3`, … if taken or reserved.
 *
 * @param taken - Slugs already in use in the scope.
 * @param base - Preferred slug.
 * @param reserved - Slugs never handed out.
 * @returns A free slug.
 */
export function freeSlug(
  taken: ReadonlySet<string>,
  base: string,
  reserved: readonly string[] = [],
): string {
  return freeSharedSlug(taken, base, reserved, SLUG_MAX_LENGTH);
}

/** Inserts that conflict on a slug get this many fresh attempts. */
const SLUG_ATTEMPTS = 4;

/**
 * Inserts a row under the first free slug, re-reading the scope and retrying
 * when a concurrent insert takes the slug in between.
 *
 * @param input.base - Preferred slug.
 * @param input.reserved - Slugs never handed out, e.g. reference namespaces.
 * @param input.taken - Reads the slugs in use in the scope.
 * @param input.insert - Inserts with the chosen slug.
 * @param input.uniqueOn - Table name in the UNIQUE violation message.
 * @returns The slug used and the insert's result.
 * @throws {ApiError} 409 when every attempt collided.
 */
export async function insertWithFreeSlug<T>(input: {
  base: string;
  reserved?: readonly string[];
  taken: () => Promise<readonly string[]>;
  insert: (slug: string) => Promise<T>;
  uniqueOn: string;
}): Promise<{ slug: string; result: T }> {
  for (let attempt = 1; ; attempt++) {
    const slug = freeSlug(new Set(await input.taken()), input.base, input.reserved);
    try {
      return { slug, result: await input.insert(slug) };
    } catch (err) {
      if (!isUniqueViolation(err, input.uniqueOn)) throw err;
      if (attempt >= SLUG_ATTEMPTS) throw conflict(`Could not allocate a slug like ${input.base}`);
    }
  }
}

/**
 * Derives a slug from a display name.
 *
 * @param name - Display name.
 * @param fallback - Used when the name has no usable characters.
 * @returns A lowercase slug.
 */
export function slugFor(name: string, fallback: string): string {
  return slugify(name, SLUG_MAX_LENGTH, fallback);
}

// -----------------------------------------------------------------------------
// Config versions
// -----------------------------------------------------------------------------

/** A config change: parts shallow-merge, `source` and `healthcheck` replace whole. */
export interface ConfigPatch {
  source?: ServiceConfigSpec["source"];
  build?: Partial<ServiceConfigSpec["build"]>;
  deploy?: Partial<ServiceConfigSpec["deploy"]>;
  resources?: Partial<ServiceConfigSpec["resources"]>;
  healthcheck?: ServiceConfigSpec["healthcheck"];
  networking?: Partial<ServiceConfigSpec["networking"]>;
  placement?: Partial<ServiceConfigSpec["placement"]>;
  /** Merged into the current part or the defaults; `null` removes it. */
  cron?: Partial<CronConfig> | null;
}

const FullConfigSchema = z.object({
  source: ServiceSourceSchema,
  build: BuildConfigSchema,
  deploy: DeployConfigSchema,
  resources: ResourcesConfigSchema,
  healthcheck: HealthcheckConfigSchema.nullable(),
  networking: NetworkingConfigSchema,
  placement: PlacementConfigSchema,
  cron: CronConfigSchema.nullable(),
});

/**
 * Applies a patch to a config and validates the result as a whole, so
 * cross-field rules hold after the merge.
 *
 * @param base - Latest version (or defaults).
 * @param patch - Requested changes.
 * @returns The merged config.
 * @throws {ApiError} 400 when the merged config is invalid.
 */
export function mergeConfig(base: ServiceConfigSpec, patch: ConfigPatch): ServiceConfigSpec {
  const merged = {
    source: patch.source ?? base.source,
    build: { ...base.build, ...stripUndefined(patch.build) },
    deploy: { ...base.deploy, ...stripUndefined(patch.deploy) },
    resources: { ...base.resources, ...stripUndefined(patch.resources) },
    healthcheck: patch.healthcheck === undefined ? base.healthcheck : patch.healthcheck,
    networking: { ...base.networking, ...stripUndefined(patch.networking) },
    placement: { ...base.placement, ...stripUndefined(patch.placement) },
    cron:
      patch.cron === null
        ? null
        : patch.cron === undefined
          ? (base.cron ?? null)
          : { ...DEFAULT_CRON_CONFIG, ...base.cron, ...stripUndefined(patch.cron) },
  };
  if (merged.build.builder !== "dockerfile") delete merged.build.dockerfile_path;
  const parsed = FullConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const details: ErrorDetail[] = parsed.error.issues.map((i) => ({
      field: i.path.join("."),
      code: "invalid",
      message: i.message,
    }));
    throw new ApiError(
      400,
      "invalid_request",
      `${details[0]!.field}: ${details[0]!.message}`,
      details,
    );
  }
  const cron = parsed.data.cron;
  const problem = cron ? scheduleError(cron.schedule, cron.timezone) : null;
  if (problem) {
    throw new ApiError(
      422,
      "invalid_schedule",
      `cron.${problem.code === "invalid_timezone" ? "timezone" : "schedule"}: ${problem.message}`,
      [
        {
          field: problem.code === "invalid_timezone" ? "cron.timezone" : "cron.schedule",
          code: problem.code,
          message: problem.message,
          start: problem.start,
          end: problem.end,
        },
      ],
    );
  }
  return parsed.data as ServiceConfigSpec;
}

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * The newest config version of a service in an environment.
 *
 * @param db - Database client.
 * @param serviceId - Service.
 * @param environmentId - Environment.
 * @returns The row, or `undefined` when there is none.
 */
export async function latestConfig(db: Db, serviceId: string, environmentId: string) {
  const [row] = await db
    .select()
    .from(serviceConfigs)
    .where(
      and(eq(serviceConfigs.serviceId, serviceId), eq(serviceConfigs.environmentId, environmentId)),
    )
    .orderBy(desc(serviceConfigs.version))
    .limit(1);
  return row;
}

/**
 * Splits a config row into the stored spec.
 *
 * @param row - A `service_configs` row.
 * @returns Its parts.
 */
export function specOf(row: typeof serviceConfigs.$inferSelect): ServiceConfigSpec {
  return {
    source: row.source,
    build: row.build,
    deploy: row.deploy,
    resources: row.resources,
    healthcheck: row.healthcheck ?? null,
    networking: row.networking,
    placement: row.placement,
    cron: row.cron ?? null,
  };
}

/**
 * Builds the insert for a config version.
 *
 * @param db - Database client.
 * @param input - Owner, version, author and spec.
 * @returns The insert statement (returning the row).
 */
export function configInsert(
  db: Db,
  input: {
    serviceId: string;
    environmentId: string;
    version: number;
    createdBy: string | null;
    spec: ServiceConfigSpec;
  },
) {
  return db
    .insert(serviceConfigs)
    .values({
      id: newId("serviceConfig"),
      serviceId: input.serviceId,
      environmentId: input.environmentId,
      version: input.version,
      createdBy: input.createdBy,
      ...input.spec,
    })
    .returning();
}

// -----------------------------------------------------------------------------
// Domains
// -----------------------------------------------------------------------------

/** Attempts at a fresh random suffix before giving up on a generated hostname. */
const HOSTNAME_RETRIES = 5;

/**
 * TLS status a new domain starts in.
 *
 * @param tlsMode - Install TLS mode.
 * @returns `disabled` for plain HTTP, else `pending` until ingress issues one.
 */
export function initialTlsStatus(tlsMode: TlsMode): DomainTlsStatus {
  return tlsMode === "off" ? "disabled" : "pending";
}

/**
 * Gives a service a generated hostname in an environment if it should have
 * one and doesn't yet; keeps existing hostnames' target port in sync.
 *
 * @param db - Database client.
 * @param input - Service, environment and port.
 * @param ingress - Apps domain and TLS mode; no apps domain means no generated domains.
 * @returns Whether a domain was created.
 */
export async function syncGeneratedDomain(
  db: Db,
  input: {
    serviceId: string;
    serviceSlug: string;
    environmentId: string;
    environmentSlug: string;
    spec: ServiceConfigSpec;
  },
  ingress: { appsDomain: string | null; tlsMode: TlsMode },
): Promise<boolean> {
  const port = input.spec.networking.port;
  const where = and(
    eq(domains.serviceId, input.serviceId),
    eq(domains.environmentId, input.environmentId),
    eq(domains.type, "generated"),
  );
  const existing = await db.select().from(domains).where(where);
  if (port && existing.some((d) => d.targetPort !== port)) {
    await db.update(domains).set({ targetPort: port, updatedAt: new Date() }).where(where);
  }
  if (existing.length || !port || !input.spec.networking.generated_domain || !ingress.appsDomain) {
    return false;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await db.insert(domains).values({
        id: newId("domain"),
        serviceId: input.serviceId,
        environmentId: input.environmentId,
        hostname: generatedHostname(
          input.serviceSlug,
          input.environmentSlug,
          ingress.appsDomain,
          () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32,
        ),
        type: "generated",
        targetPort: port,
        verificationStatus: "verified",
        tlsStatus: initialTlsStatus(ingress.tlsMode),
      });
      return true;
    } catch (err) {
      if (attempt >= HOSTNAME_RETRIES || !isUniqueViolation(err, "domains.hostname")) throw err;
    }
  }
}

// -----------------------------------------------------------------------------
// Teardown
// -----------------------------------------------------------------------------

/**
 * Stops every deployment of the given services: in-flight ones are
 * cancelled, live ones removed, and their replicas pulled from nodes. Their
 * volumes are soft-deleted (ADR 0004), so the data stays on its node for
 * the grace period.
 *
 * @param ctx - Database and bindings.
 * @param projectId - Owning project.
 * @param serviceIds - Services being deleted.
 */
export async function tearDownServices(
  ctx: LifecycleContext,
  projectId: string,
  serviceIds: readonly string[],
): Promise<void> {
  if (!serviceIds.length) return;
  const rows = await ctx.db
    .select({ id: deployments.id, status: deployments.status })
    .from(deployments)
    .where(
      and(
        inArray(deployments.serviceId, [...serviceIds]),
        inArray(deployments.status, [...CANCELLABLE_DEPLOYMENT_STATUSES, "active", "crashed"]),
      ),
    );
  for (const d of rows) {
    try {
      if (CANCELLABLE_DEPLOYMENT_STATUSES.includes(d.status)) {
        await cancelDeployment(ctx, projectId, d.id, "The service was deleted");
      } else {
        await transitionDeployment(ctx, projectId, d.id, "removed", {
          reason: "The service was deleted",
        });
      }
    } catch (err) {
      if (!(err instanceof IllegalTransitionError)) throw err;
    }
  }
  // Before the deployments retire, so the desired state they push no longer lists the volumes.
  const holders = await retireServiceVolumes(ctx.db, serviceIds);
  await retireDeployments(
    ctx,
    rows.map((d) => d.id),
  );
  if (holders.length) await refreshNodes(ctx.env, ctx.db, holders);
}

/**
 * Live services of a project.
 *
 * @param db - Database client.
 * @param projectId - The project.
 * @returns Service rows ordered by creation.
 */
export function liveServices(db: Db, projectId: string) {
  return db.query.services.findMany({
    where: (s, { and: a, eq: e, isNull: n }) => a(e(s.projectId, projectId), n(s.deletedAt)),
    orderBy: (s, { asc }) => [asc(s.id)],
  });
}
