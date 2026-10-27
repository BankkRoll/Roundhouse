/**
 * Services, their immutable config versions, and their domains.
 *
 * - Creating a service writes config version 1 (`defaultServiceConfig`
 *   merged with the body) in every environment and, when enabled and an
 *   apps domain is set, a generated hostname.
 * - A config change always inserts version N+1 and never deploys; the next
 *   deployment picks it up.
 * - A git source naming a GitHub installation is only stored when the
 *   service's workspace claimed that installation and it can read the
 *   github.com repository (`assertSourceInstallation`).
 * - Deleting a service is a soft delete that stops its deployments and pulls
 *   its replicas from nodes.
 * - The slug is the `${{slug.VAR}}` namespace: on create, a taken or reserved
 *   slug (`shared`) is suffixed -2, -3, …; a rename is exact (409 when taken)
 *   except that a reserved slug is suffixed the same way.
 *
 * @module
 */
import { type Db, environments, serviceConfigs, services } from "@roundhouse/db";
import {
  defaultServiceConfig,
  newId,
  RESERVED_SERVICE_SLUGS,
  type ServiceProvider,
  type ServiceSource,
  serviceProvider,
} from "@roundhouse/shared";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { type AppContext, clientIp, createRouter, requireMasterKey } from "../context";
import {
  createService,
  deleteService,
  getService,
  getServiceConfig,
  listDomains,
  listServices,
  policyOf,
  updateService,
} from "../contracts";
import { recordAudit } from "../lib/audit";
import { assertCloudflareEligible } from "../lib/cloudflare/eligibility";
import { pauseCloudflareRuntime } from "../lib/cloudflare/runtime";
import { presentDomains, serviceDomains } from "../lib/domains/present";
import { conflict, isUniqueViolation, notFound } from "../lib/errors";
import { assertSourceInstallation } from "../lib/github";
import {
  type ConfigPatch,
  configInsert,
  freeSlug,
  insertWithFreeSlug,
  latestConfig,
  liveServices,
  mergeConfig,
  slugFor,
  specOf,
  syncGeneratedDomain,
  tearDownServices,
} from "../lib/projects";
import { publish } from "../lib/realtime";
import { environmentOf, projectScope, serviceScope } from "../lib/scope";
import { toApiConfig, toApiService } from "../lib/serialize";
import { getIngressSettings } from "../lib/settings";
import { assertPlainBuildArgs } from "../lib/variables";
import { assertSingleReplica } from "../lib/volumes";
import { SERVICE_CONFIG_PARTS } from "../schemas";

async function liveSlugs(db: Db, projectId: string): Promise<string[]> {
  const rows = await db
    .select({ slug: services.slug })
    .from(services)
    .where(and(eq(services.projectId, projectId), isNull(services.deletedAt)));
  return rows.map((r) => r.slug);
}

/** {@link assertSourceInstallation}, unsealing the App only for sources that name an installation. */
async function checkSource(c: AppContext, workspaceId: string, source: ServiceSource) {
  if (source.type !== "git" || !source.github_installation_id) return;
  requireMasterKey(c);
  await assertSourceInstallation(c.get("db"), c.env, workspaceId, source);
}

/** Service, config and domain routes. */
export const serviceRoutes = createRouter()
  .openapi(listServices, async (c) => {
    const { projectId } = c.req.valid("param");
    await projectScope(c, projectId, policyOf(listServices).action!);
    const rows = await liveServices(c.get("db"), projectId);
    return c.json({ services: rows.map(toApiService) }, 200);
  })
  .openapi(createService, async (c) => {
    const { projectId } = c.req.valid("param");
    const { project, caller } = await projectScope(c, projectId, policyOf(createService).action!);
    const body = c.req.valid("json");
    const db = c.get("db");
    const spec = mergeConfig(defaultServiceConfig(body.source), body.config ?? {});
    await checkSource(c, project.workspaceId, spec.source);

    const envs = await db
      .select()
      .from(environments)
      .where(and(eq(environments.projectId, projectId), isNull(environments.retiredAt)))
      .orderBy(asc(environments.id));
    for (const e of envs) {
      await assertPlainBuildArgs(db, c.env, {
        projectId,
        environmentId: e.id,
        serviceSlug: null,
        build: spec.build,
      });
    }
    const id = newId("service");
    const { slug } = await insertWithFreeSlug({
      base: body.slug ?? slugFor(body.name, "service"),
      reserved: RESERVED_SERVICE_SLUGS,
      uniqueOn: "services",
      taken: () => liveSlugs(db, projectId),
      insert: (slug) =>
        db.batch([
          db.insert(services).values({
            id,
            projectId,
            name: body.name,
            slug,
            kind: body.kind,
            icon: body.icon ?? null,
          }),
          ...envs.map((e) =>
            configInsert(db, {
              serviceId: id,
              environmentId: e.id,
              version: 1,
              createdBy: caller.user.id,
              spec,
            }),
          ),
        ]),
    });
    const ingress = await getIngressSettings(db);
    for (const e of envs) {
      await syncGeneratedDomain(
        db,
        { serviceId: id, serviceSlug: slug, environmentId: e.id, environmentSlug: e.slug, spec },
        ingress,
      );
    }
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "service.created",
      targetType: "service",
      targetId: id,
      metadata: { project_id: projectId, name: body.name, slug, source: body.source.type },
      ip: clientIp(c),
    });
    const service = (await db.query.services.findFirst({ where: eq(services.id, id) }))!;
    const configs = await db
      .select()
      .from(serviceConfigs)
      .where(eq(serviceConfigs.serviceId, id))
      .orderBy(asc(serviceConfigs.environmentId));
    await publish(c.env, projectId, { type: "service.updated", service: toApiService(service) });
    return c.json({ service: toApiService(service), configs: configs.map(toApiConfig) }, 201);
  })
  .openapi(getService, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { service } = await serviceScope(c, serviceId, policyOf(getService).action!);
    return c.json(toApiService(service), 200);
  })
  .openapi(updateService, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { service, project, caller } = await serviceScope(
      c,
      serviceId,
      policyOf(updateService).action!,
    );
    const body = c.req.valid("json");
    const db = c.get("db");
    // A rename is exact, except that a reserved slug gets the suffix it would on create.
    const newSlug =
      body.slug === undefined
        ? undefined
        : (RESERVED_SERVICE_SLUGS as readonly string[]).includes(body.slug)
          ? freeSlug(
              new Set((await liveSlugs(db, project.id)).filter((s) => s !== service.slug)),
              body.slug,
              RESERVED_SERVICE_SLUGS,
            )
          : body.slug;

    const patch: ConfigPatch = {};
    for (const part of SERVICE_CONFIG_PARTS) {
      if (body[part] !== undefined) (patch as Record<string, unknown>)[part] = body[part];
    }
    const changesConfig = Object.keys(patch).length > 0;
    let config: typeof serviceConfigs.$inferSelect | null = null;
    let providerChange: { from: ServiceProvider; to: ServiceProvider } | null = null;
    if (changesConfig) {
      const env = await environmentOf(c, project.id, body.environment_id!);
      const latest = await latestConfig(db, serviceId, env.id);
      if (!latest) throw notFound("Service config");
      if (body.expected_version !== undefined && body.expected_version !== latest.version) {
        throw conflict(
          `Config changed since version ${body.expected_version}; the latest is ${latest.version}`,
        );
      }
      const spec = mergeConfig(specOf(latest), patch);
      if (patch.deploy) await assertSingleReplica(db, service, spec.deploy.replicas);
      const from = serviceProvider(latest.placement);
      const to = serviceProvider(spec.placement);
      if (to === "cloudflare") await assertCloudflareEligible(db, service, env.id, spec);
      if (from !== to) providerChange = { from, to };
      if (patch.source) await checkSource(c, project.workspaceId, spec.source);
      if (patch.build) {
        await assertPlainBuildArgs(db, c.env, {
          projectId: project.id,
          environmentId: env.id,
          serviceSlug: newSlug ?? service.slug,
          build: spec.build,
        });
      }
      try {
        [config = null] = await configInsert(db, {
          serviceId,
          environmentId: env.id,
          version: latest.version + 1,
          createdBy: caller.user.id,
          spec,
        });
      } catch (err) {
        if (isUniqueViolation(err, "service_configs")) {
          throw conflict("Someone else changed this config at the same time; reload and retry");
        }
        throw err;
      }
      await syncGeneratedDomain(
        db,
        {
          serviceId,
          serviceSlug: newSlug ?? service.slug,
          environmentId: env.id,
          environmentSlug: env.slug,
          spec,
        },
        await getIngressSettings(db),
      );
    }

    let updated = service;
    if (body.name !== undefined || newSlug !== undefined || body.icon !== undefined || config) {
      try {
        const [row] = await db
          .update(services)
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(newSlug !== undefined ? { slug: newSlug } : {}),
            ...(body.icon !== undefined ? { icon: body.icon } : {}),
            updatedAt: new Date(),
          })
          .where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
          .returning();
        if (!row) throw notFound("Service");
        updated = row;
      } catch (err) {
        if (isUniqueViolation(err, "services")) {
          throw conflict(`A service with slug ${newSlug} exists`);
        }
        throw err;
      }
    }
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "service.updated",
      targetType: "service",
      targetId: serviceId,
      metadata: {
        changes: Object.keys(body).filter((k) => body[k as keyof typeof body] !== undefined),
        ...(config ? { environment_id: config.environmentId, version: config.version } : {}),
      },
      ip: clientIp(c),
    });
    // `deploy.replicas = 0` on Cloudflare stops serving without deleting anything (ADR 0011).
    if (
      config &&
      serviceProvider(config.placement) === "cloudflare" &&
      config.deploy.replicas === 0
    ) {
      await pauseCloudflareRuntime(c.env, db, serviceId, config.environmentId);
    }
    if (providerChange && config) {
      await recordAudit(db, {
        workspaceId: project.workspaceId,
        ...caller.actor,
        action: "service.provider_changed",
        targetType: "service",
        targetId: serviceId,
        metadata: {
          environment_id: config.environmentId,
          version: config.version,
          ...providerChange,
        },
        ip: clientIp(c),
      });
    }
    await publish(c.env, project.id, { type: "service.updated", service: toApiService(updated) });
    return c.json(
      { service: toApiService(updated), config: config ? toApiConfig(config) : null },
      200,
    );
  })
  .openapi(deleteService, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { service, project, caller } = await serviceScope(
      c,
      serviceId,
      policyOf(deleteService).action!,
    );
    const db = c.get("db");
    await tearDownServices({ db, env: c.env }, project.id, [serviceId]);
    const now = new Date();
    const [row] = await db
      .update(services)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(services.id, serviceId), isNull(services.deletedAt)))
      .returning();
    if (!row) throw notFound("Service");
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "service.deleted",
      targetType: "service",
      targetId: serviceId,
      metadata: { name: service.name, slug: service.slug, project_id: project.id },
      ip: clientIp(c),
    });
    await publish(c.env, project.id, { type: "service.updated", service: toApiService(row) });
    return c.body(null, 204);
  })
  .openapi(getServiceConfig, async (c) => {
    const { serviceId } = c.req.valid("param");
    const query = c.req.valid("query");
    const { project } = await serviceScope(c, serviceId, policyOf(getServiceConfig).action!);
    const env = await environmentOf(c, project.id, query.environment_id);
    const [row] = await c
      .get("db")
      .select()
      .from(serviceConfigs)
      .where(
        and(
          eq(serviceConfigs.serviceId, serviceId),
          eq(serviceConfigs.environmentId, env.id),
          ...(query.version !== undefined ? [eq(serviceConfigs.version, query.version)] : []),
        ),
      )
      .orderBy(desc(serviceConfigs.version))
      .limit(1);
    if (!row) throw notFound("Service config");
    return c.json(toApiConfig(row), 200);
  })
  .openapi(listDomains, async (c) => {
    const { serviceId } = c.req.valid("param");
    const query = c.req.valid("query");
    const { project } = await serviceScope(c, serviceId, policyOf(listDomains).action!);
    if (query.environment_id) await environmentOf(c, project.id, query.environment_id);
    const db = c.get("db");
    const rows = await serviceDomains(db, serviceId, query.environment_id);
    return c.json({ domains: await presentDomains(db, project.workspaceId, rows) }, 200);
  });
