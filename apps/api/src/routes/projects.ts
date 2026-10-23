/**
 * Projects and their environments.
 *
 * - Creating a project creates its `production` environment and its data
 *   key in the same batch.
 * - Deleting one is a soft delete that also stops every deployment and
 *   pulls its replicas from nodes; the slug is free again at once.
 * - Creating an environment gives every service config version 1 there,
 *   copied from another environment when asked (variables included).
 * - Summaries return every service's state in one environment in a fixed
 *   number of queries.
 * - A taken slug on create is suffixed (-2, -3, …), never refused.
 *
 * @module
 */
import { environments, projectKeys, projects, services, variables } from "@roundhouse/db";
import {
  DEFAULT_ENVIRONMENT,
  defaultServiceConfig,
  newId,
  type ProjectAction,
  type ServiceConfigSpec,
} from "@roundhouse/shared";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  clientIp,
  createRouter,
  requireMasterKey,
  requireWorkspace,
  visibleProjects,
} from "../context";
import {
  createEnvironment,
  createProject,
  deleteProject,
  getProject,
  getProjectSummary,
  listEnvironments,
  listProjectSummaries,
  listProjects,
  policyOf,
  updateProject,
} from "../contracts";
import { recordAudit } from "../lib/audit";
import { conflict, isUniqueViolation, notFound } from "../lib/errors";
import {
  configInsert,
  insertWithFreeSlug,
  latestConfig,
  liveServices,
  slugFor,
  specOf,
  syncGeneratedDomain,
  tearDownServices,
} from "../lib/projects";
import { revalidateProjects } from "../lib/realtime";
import { environmentOf, projectScope } from "../lib/scope";
import { toApiEnvironment, toApiProject, toApiService } from "../lib/serialize";
import { getIngressSettings } from "../lib/settings";
import { projectSummaries } from "../lib/summaries";
import { copiedVariableRows, newProjectKeyRow, projectKey } from "../lib/variables";

const productionFirst = sql`CASE WHEN ${environments.kind} = 'production' THEN 0 ELSE 1 END`;

/** Project and environment routes. */
export const projectRoutes = createRouter()
  .openapi(listProjects, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { slug } = c.req.valid("query");
    const visible = await visibleProjects(
      c,
      workspaceId,
      policyOf(listProjects).action as ProjectAction,
    );
    const rows = await c
      .get("db")
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, workspaceId),
          isNull(projects.deletedAt),
          slug !== undefined ? eq(projects.slug, slug) : undefined,
        ),
      )
      .orderBy(asc(projects.name), asc(projects.id));
    return c.json({ projects: rows.filter((p) => visible.has(p.id)).map(toApiProject) }, 200);
  })
  .openapi(listProjectSummaries, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const visible = await visibleProjects(
      c,
      workspaceId,
      policyOf(listProjectSummaries).action as ProjectAction,
    );
    const db = c.get("db");
    const { tlsMode } = await getIngressSettings(db);
    const all = await projectSummaries(db, { kind: "workspace", workspaceId }, tlsMode);
    return c.json({ projects: all.filter((p) => visible.has(p.id)) }, 200);
  })
  .openapi(getProjectSummary, async (c) => {
    const { projectId } = c.req.valid("param");
    const query = c.req.valid("query");
    await projectScope(c, projectId, policyOf(getProjectSummary).action!);
    const db = c.get("db");
    const [environment] = query.environment_id
      ? [await environmentOf(c, projectId, query.environment_id)]
      : await db
          .select()
          .from(environments)
          .where(and(eq(environments.projectId, projectId), eq(environments.kind, "production")))
          .limit(1);
    if (!environment) throw notFound("Environment");
    const { tlsMode } = await getIngressSettings(db);
    const [summary] = await projectSummaries(
      db,
      { kind: "project", projectId, environmentId: environment.id },
      tlsMode,
    );
    if (!summary) throw notFound("Project");
    return c.json(summary, 200);
  })
  .openapi(createProject, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const m = await requireWorkspace(c, workspaceId, policyOf(createProject).action!);
    const masterKey = requireMasterKey(c);
    const body = c.req.valid("json");
    const db = c.get("db");

    const id = newId("project");
    const envId = newId("environment");
    const keyRow = await newProjectKeyRow(masterKey, id, workspaceId);
    const { slug } = await insertWithFreeSlug({
      base: body.slug ?? slugFor(body.name, "project"),
      uniqueOn: "projects",
      taken: async () =>
        (
          await db
            .select({ slug: projects.slug })
            .from(projects)
            .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)))
        ).map((t) => t.slug),
      insert: (slug) =>
        db.batch([
          db.insert(projects).values({
            id,
            workspaceId,
            name: body.name,
            slug,
            description: body.description || null,
          }),
          db.insert(environments).values({
            id: envId,
            projectId: id,
            name: DEFAULT_ENVIRONMENT.name,
            slug: DEFAULT_ENVIRONMENT.slug,
            kind: "production",
            // ADR 0014: production starts protected (DEFAULT_PROTECTION_RULES).
            protected: true,
          }),
          db.insert(projectKeys).values(keyRow),
        ]),
    });
    await recordAudit(db, {
      workspaceId,
      ...m.actor,
      action: "project.created",
      targetType: "project",
      targetId: id,
      metadata: { name: body.name, slug },
      ip: clientIp(c),
    });
    const project = (await db.query.projects.findFirst({ where: eq(projects.id, id) }))!;
    const env = (await db.query.environments.findFirst({ where: eq(environments.id, envId) }))!;
    return c.json(
      { ...toApiProject(project), environments: [toApiEnvironment(env)], services: [] },
      201,
    );
  })
  .openapi(getProject, async (c) => {
    const { projectId } = c.req.valid("param");
    const { project } = await projectScope(c, projectId, policyOf(getProject).action!);
    const db = c.get("db");
    const [envs, svcs] = await Promise.all([
      db
        .select()
        .from(environments)
        .where(eq(environments.projectId, projectId))
        .orderBy(productionFirst, asc(environments.id)),
      liveServices(db, projectId),
    ]);
    return c.json(
      {
        ...toApiProject(project),
        environments: envs.map(toApiEnvironment),
        services: svcs.map(toApiService),
      },
      200,
    );
  })
  .openapi(updateProject, async (c) => {
    const { projectId } = c.req.valid("param");
    const { caller } = await projectScope(c, projectId, policyOf(updateProject).action!);
    const body = c.req.valid("json");
    let row: typeof projects.$inferSelect | undefined;
    try {
      [row] = await c
        .get("db")
        .update(projects)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.slug !== undefined ? { slug: body.slug } : {}),
          ...(body.description !== undefined ? { description: body.description || null } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)))
        .returning();
    } catch (err) {
      if (isUniqueViolation(err, "projects"))
        throw conflict(`A project with slug ${body.slug} exists`);
      throw err;
    }
    if (!row) throw notFound("Project");
    await recordAudit(c.get("db"), {
      workspaceId: row.workspaceId,
      ...caller.actor,
      action: "project.updated",
      targetType: "project",
      targetId: projectId,
      metadata: {
        changes: Object.keys(body).filter((k) => body[k as keyof typeof body] !== undefined),
      },
      ip: clientIp(c),
    });
    return c.json(toApiProject(row), 200);
  })
  .openapi(deleteProject, async (c) => {
    const { projectId } = c.req.valid("param");
    const { project, caller } = await projectScope(c, projectId, policyOf(deleteProject).action!);
    const db = c.get("db");
    const now = new Date();
    const live = await liveServices(db, projectId);
    // Deployments stop before the soft delete so their timeline events and
    // realtime messages still reach the project.
    await tearDownServices(
      { db, env: c.env },
      projectId,
      live.map((s) => s.id),
    );
    await db.batch([
      db
        .update(services)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(services.projectId, projectId), isNull(services.deletedAt))),
      db.update(projects).set({ deletedAt: now, updatedAt: now }).where(eq(projects.id, projectId)),
    ]);
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "project.deleted",
      targetType: "project",
      targetId: projectId,
      metadata: { name: project.name, slug: project.slug },
      ip: clientIp(c),
    });
    await revalidateProjects(c.env, [projectId]);
    return c.body(null, 204);
  })
  .openapi(listEnvironments, async (c) => {
    const { projectId } = c.req.valid("param");
    await projectScope(c, projectId, policyOf(listEnvironments).action!);
    const rows = await c
      .get("db")
      .select()
      .from(environments)
      .where(eq(environments.projectId, projectId))
      .orderBy(productionFirst, asc(environments.id));
    return c.json({ environments: rows.map(toApiEnvironment) }, 200);
  })
  .openapi(createEnvironment, async (c) => {
    const { projectId } = c.req.valid("param");
    const { project, caller } = await projectScope(
      c,
      projectId,
      policyOf(createEnvironment).action!,
    );
    const body = c.req.valid("json");
    const db = c.get("db");
    const from = body.copy_from_environment_id
      ? await environmentOf(c, projectId, body.copy_from_environment_id)
      : null;
    const [production] = await db
      .select()
      .from(environments)
      .where(and(eq(environments.projectId, projectId), eq(environments.kind, "production")))
      .limit(1);

    const envId = newId("environment");
    const live = await liveServices(db, projectId);
    const configs: { service: (typeof live)[number]; spec: ServiceConfigSpec }[] = [];
    for (const s of live) {
      const copied = from ? await latestConfig(db, s.id, from.id) : undefined;
      const fallback =
        copied ?? (production ? await latestConfig(db, s.id, production.id) : undefined);
      if (!fallback) continue;
      configs.push({
        service: s,
        spec: copied ? specOf(copied) : defaultServiceConfig(fallback.source),
      });
    }
    const variableRows = from
      ? await copiedVariableRows(
          db,
          await projectKey(db, requireMasterKey(c), projectId),
          projectId,
          from.id,
          envId,
        )
      : [];
    const { slug } = await insertWithFreeSlug({
      base: body.slug ?? slugFor(body.name, "env"),
      uniqueOn: "environments",
      taken: async () =>
        (
          await db
            .select({ slug: environments.slug })
            .from(environments)
            .where(eq(environments.projectId, projectId))
        ).map((t) => t.slug),
      insert: (slug) =>
        db.batch([
          db.insert(environments).values({
            id: envId,
            projectId,
            name: body.name,
            slug,
            kind: body.kind,
            prNumber: body.pr_number ?? null,
            sourceBranch: body.source_branch ?? null,
          }),
          ...configs.map((cfg) =>
            configInsert(db, {
              serviceId: cfg.service.id,
              environmentId: envId,
              version: 1,
              createdBy: caller.user.id,
              spec: cfg.spec,
            }),
          ),
          ...(variableRows.length ? [db.insert(variables).values(variableRows)] : []),
        ]),
    });
    const ingress = await getIngressSettings(db);
    for (const cfg of configs) {
      await syncGeneratedDomain(
        db,
        {
          serviceId: cfg.service.id,
          serviceSlug: cfg.service.slug,
          environmentId: envId,
          environmentSlug: slug,
          spec: cfg.spec,
        },
        ingress,
      );
    }
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "project.updated",
      targetType: "project",
      targetId: projectId,
      metadata: { environment_id: envId, environment: slug, copied_from: from?.id ?? null },
      ip: clientIp(c),
    });
    const env = (await db.query.environments.findFirst({ where: eq(environments.id, envId) }))!;
    return c.json(toApiEnvironment(env), 201);
  });
