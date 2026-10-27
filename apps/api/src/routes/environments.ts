/**
 * Environment lifecycle routes (ADR 0007): create (blank or cloned), diff,
 * promote, delete. Listing stays with the project routes.
 *
 * - **Create/clone** writes the environment, its configs, its variables
 *   (database credentials always fresh) and empty volumes in one batch,
 *   then generated domains and paused cron schedules, and with
 *   `volumes: latest_backup` restores each database from the source's latest
 *   dump.
 * - **Diff** compares secrets by fingerprint only.
 * - **Promote** stages a change set in the target; it never applies it.
 * - **Delete** retires the environment (see `retireEnvironment`) and closes a
 *   linked preview. Production is never created or deleted here.
 *
 * @module
 */
import {
  changeSets,
  deployments,
  environments,
  previewEnvironments,
  previewSettings,
  variables,
  volumes,
} from "@roundhouse/db";
import {
  CONFIG_PATCH_PARTS,
  databaseVersion,
  newId,
  type ServiceConfigPatch,
  type ServiceConfigSpec,
} from "@roundhouse/shared";
import { and, desc, eq } from "drizzle-orm";
import { type AppContext, clientIp, createRouter, requireKeys } from "../context";
import {
  createEnvironment,
  deleteEnvironment,
  diffEnvironments,
  policyOf,
  promoteEnvironment,
} from "../contracts";
import { recordAudit } from "../lib/audit";
import { type StageInput, type StagingContext, stageIntoSet } from "../lib/changes/staging";
import { environmentScope, openChangeSet, presentChangeSet } from "../lib/changes/store";
import { databaseVariables } from "../lib/databases";
import {
  environmentDiff,
  finishEnvironment,
  planEnvironmentCopy,
  retireEnvironment,
  seedDatabasesFromBackups,
} from "../lib/environments";
import { ApiError, conflict, notFound } from "../lib/errors";
import {
  configInsert,
  insertWithFreeSlug,
  latestConfig,
  liveServices,
  slugFor,
  specOf,
} from "../lib/projects";
import { environmentOf, projectScope } from "../lib/scope";
import { toApiEnvironment } from "../lib/serialize";
import { openVariable, projectKey } from "../lib/variables";

/** A live environment of a project by ID, or 404. */
async function liveEnvironment(
  c: AppContext,
  environmentId: string,
  action: Parameters<typeof environmentScope>[2],
) {
  const scope = await environmentScope(c, environmentId, action);
  if (scope.environment.retiredAt) throw notFound("Environment");
  return scope;
}

/** Environment lifecycle routes. */
export const environmentRoutes = createRouter()
  .openapi(createEnvironment, async (c) => {
    const { projectId } = c.req.valid("param");
    const { project, caller } = await projectScope(
      c,
      projectId,
      policyOf(createEnvironment).action!,
    );
    const body = c.req.valid("json");
    const db = c.get("db");
    const keys = requireKeys(c);
    const clone =
      body.clone ??
      (body.copy_from_environment_id
        ? {
            from_environment_id: body.copy_from_environment_id,
            variables: "all" as const,
            volumes: "empty" as const,
          }
        : undefined);
    const from = clone ? await environmentOf(c, projectId, clone.from_environment_id) : null;
    const live = await liveServices(db, projectId);
    if (clone?.services) {
      const unknown = clone.services.filter((id) => !live.some((s) => s.id === id));
      if (unknown.length) {
        throw new ApiError(
          400,
          "invalid_request",
          `clone.services: ${unknown.join(", ")} not found`,
        );
      }
    }
    if (clone?.volumes === "latest_backup" && !caller.allows("backups:restore")) {
      // SECURITY: restoring copies the source's data; it needs the restore right.
      throw new ApiError(
        403,
        "forbidden",
        "Restoring the source's data into a clone needs backups:restore",
      );
    }
    const [production] = await db
      .select()
      .from(environments)
      .where(and(eq(environments.projectId, projectId), eq(environments.kind, "production")))
      .limit(1);

    const envId = newId("environment");
    const copy = await planEnvironmentCopy(db, keys, {
      projectId,
      environmentId: envId,
      source: from,
      services: clone?.services ?? null,
      variables: clone?.variables ?? "none",
      fallback: production ?? null,
    });
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
          ...copy.configs.map((cfg) =>
            configInsert(db, {
              serviceId: cfg.service.id,
              environmentId: envId,
              version: 1,
              createdBy: caller.user.id,
              spec: cfg.spec,
            }),
          ),
          ...copy.variableRows.map((row) =>
            db.insert(variables).values({ ...row, updatedBy: caller.user.id }),
          ),
          ...copy.volumeRows.map((row) => db.insert(volumes).values(row)),
        ]),
    });
    await finishEnvironment(db, projectId, envId);
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "environment.created",
      targetType: "environment",
      targetId: envId,
      metadata: { project_id: projectId, environment: slug, kind: body.kind },
      ip: clientIp(c),
    });
    if (from && clone) {
      await recordAudit(db, {
        workspaceId: project.workspaceId,
        ...caller.actor,
        action: "environment.cloned",
        targetType: "environment",
        targetId: envId,
        metadata: {
          project_id: projectId,
          environment: slug,
          from_environment_id: from.id,
          variables: clone.variables,
          volumes: clone.volumes,
          services: clone.services ?? null,
        },
        ip: clientIp(c),
      });
      if (clone.volumes === "latest_backup") {
        await seedDatabasesFromBackups(
          { db, env: c.env },
          {
            projectId,
            workspaceId: project.workspaceId,
            fromEnvironmentId: from.id,
            environmentId: envId,
            actor: caller.actor,
            requestedBy: caller.user.id,
            auditMetadata: { mode: "clone_seed" },
          },
        );
      }
    }
    const env = (await db.query.environments.findFirst({ where: eq(environments.id, envId) }))!;
    return c.json(toApiEnvironment(env), 201);
  })
  .openapi(diffEnvironments, async (c) => {
    const { projectId } = c.req.valid("param");
    const { base, target } = c.req.valid("query");
    await projectScope(c, projectId, policyOf(diffEnvironments).action!);
    const [b, t] = [
      await environmentOf(c, projectId, base),
      await environmentOf(c, projectId, target),
    ];
    return c.json(await environmentDiff(c.get("db"), projectId, b, t), 200);
  })
  .openapi(promoteEnvironment, async (c) => {
    const { environmentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const {
      environment: target,
      project,
      caller,
    } = await liveEnvironment(c, environmentId, policyOf(promoteEnvironment).action!);
    const db = c.get("db");
    const from = await environmentOf(c, project.id, body.from_environment_id);
    if (from.id === target.id) {
      throw new ApiError(
        400,
        "invalid_request",
        "from_environment_id: promote from another environment",
      );
    }
    const ops = await promotionOps(c, { projectId: project.id, from, target, body });
    if (!ops.length) throw conflict(`Nothing differs between ${from.name} and ${target.name}`);
    const ctx: StagingContext = {
      c,
      db,
      keys: requireKeys(c),
      project,
      environment: target,
      caller,
    };
    let set = await openChangeSet(db, {
      projectId: project.id,
      environmentId: target.id,
      source: "promote",
      isDraft: false,
      caller,
      title: `Promote ${from.name} to ${target.name}`.slice(0, 200),
    });
    try {
      for (const op of ops) set = await stageIntoSet(ctx, set, op);
    } catch (err) {
      // The caller gets the whole proposal or nothing.
      await db.delete(changeSets).where(eq(changeSets.id, set.id));
      throw err;
    }
    for (const action of ["change_set.created", "environment.promote_proposed"] as const) {
      await recordAudit(db, {
        workspaceId: project.workspaceId,
        ...caller.actor,
        action,
        targetType: action === "change_set.created" ? "change_set" : "environment",
        targetId: action === "change_set.created" ? set.id : target.id,
        metadata: {
          project_id: project.id,
          environment_id: target.id,
          environment: target.slug,
          from_environment_id: from.id,
          change_set_id: set.id,
          source: "promote",
          ops: ops.length,
        },
        ip: clientIp(c),
      });
    }
    return c.json(await presentChangeSet(db, set), 201);
  })
  .openapi(deleteEnvironment, async (c) => {
    const { environmentId } = c.req.valid("param");
    const { confirm } = c.req.valid("query");
    const { environment, project, caller } = await liveEnvironment(
      c,
      environmentId,
      policyOf(deleteEnvironment).action!,
    );
    if (environment.kind === "production") {
      throw conflict("A production environment can never be deleted");
    }
    if (confirm !== environment.slug) {
      throw new ApiError(400, "invalid_request", "confirm must equal the environment's slug");
    }
    if (environment.protected && !caller.allows("access:manage")) {
      throw new ApiError(403, "forbidden", "Deleting a protected environment needs access:manage");
    }
    const db = c.get("db");
    const [base] = await db
      .select({ projectId: previewSettings.projectId })
      .from(previewSettings)
      .where(
        and(
          eq(previewSettings.baseEnvironmentId, environment.id),
          eq(previewSettings.enabled, true),
        ),
      )
      .limit(1);
    if (base) throw conflict("Previews copy this environment; pick another base for them first");
    const now = Date.now();
    if (environment.previewId) {
      await db
        .update(previewEnvironments)
        .set({
          status: "closed",
          environmentId: null,
          expiresAt: null,
          closedAt: new Date(now),
          updatedAt: new Date(now),
        })
        .where(eq(previewEnvironments.id, environment.previewId));
    }
    await retireEnvironment(
      { db, env: c.env },
      project.id,
      environment.id,
      "The environment was deleted",
      now,
    );
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "environment.deleted",
      targetType: "environment",
      targetId: environment.id,
      metadata: {
        project_id: project.id,
        environment: environment.slug,
        kind: environment.kind,
        preview_id: environment.previewId,
      },
      ip: clientIp(c),
    });
    return c.body(null, 204);
  });

// -----------------------------------------------------------------------------
// Promotion
// -----------------------------------------------------------------------------

/** Parts the target keeps by design: its own generated domain and node selector. */
function promotedPatch(
  source: ServiceConfigSpec,
  target: ServiceConfigSpec,
): ServiceConfigPatch | null {
  const patch: Record<string, unknown> = {};
  for (const part of CONFIG_PATCH_PARTS) {
    let next: unknown = source[part];
    if (part === "networking") {
      next = { ...source.networking, generated_domain: target.networking.generated_domain };
    }
    if (part === "placement") {
      next = { ...source.placement, node_selector: target.placement.node_selector };
    }
    if (JSON.stringify(next) !== JSON.stringify(target[part])) patch[part] = next;
  }
  return Object.keys(patch).length ? (patch as ServiceConfigPatch) : null;
}

/**
 * The ops promoting `from` into `target` (ADR 0007, "Promote"): config
 * patches, variable writes and deletes per `include.variables` (database
 * credentials never, secrets only with `all`; values compared by
 * fingerprint, never shown), and a `deployment.promote` per service whose
 * source runs an image the target doesn't.
 */
async function promotionOps(
  c: AppContext,
  input: {
    projectId: string;
    from: typeof environments.$inferSelect;
    target: typeof environments.$inferSelect;
    body: {
      services: "all" | string[];
      include: { config: boolean; variables: "none" | "non_secret" | "all"; image: boolean };
    };
  },
): Promise<StageInput[]> {
  const db = c.get("db");
  const { from, target, body } = input;
  const live = await liveServices(db, input.projectId);
  if (body.services !== "all") {
    const unknown = body.services.filter((id) => !live.some((s) => s.id === id));
    if (unknown.length)
      throw new ApiError(400, "invalid_request", `services: ${unknown.join(", ")} not found`);
  }
  const chosen = live.filter((s) => body.services === "all" || body.services.includes(s.id));
  const key = await projectKey(db, requireKeys(c), input.projectId);
  const [fromVars, targetVars] = await Promise.all(
    [from.id, target.id].map((environmentId) =>
      db
        .select()
        .from(variables)
        .where(
          and(eq(variables.projectId, input.projectId), eq(variables.environmentId, environmentId)),
        ),
    ),
  );
  const ops: StageInput[] = [];
  const variableOps = async (
    scope: "service" | "shared",
    service: (typeof live)[number] | null,
  ) => {
    if (body.include.variables === "none") return;
    const credentials = new Set<string>();
    if (service?.databaseEngine) {
      const v = databaseVersion(service.databaseEngine, service.databaseVersion);
      if (v)
        for (const e of databaseVariables(service.databaseEngine, v.version))
          credentials.add(e.key);
    }
    const of = (rows: typeof fromVars) =>
      rows!.filter((r) => r.scope === scope && (scope === "shared" || r.serviceId === service!.id));
    const src = new Map(of(fromVars!).map((r) => [r.key, r]));
    const dst = new Map(of(targetVars!).map((r) => [r.key, r]));
    const allowed = (tier: string) => body.include.variables === "all" || tier !== "secret";
    for (const [k, r] of src) {
      if (credentials.has(k) || !allowed(r.tier)) continue;
      const t = dst.get(k);
      if (
        t &&
        t.fingerprint !== null &&
        t.fingerprint === r.fingerprint &&
        t.tier === r.tier &&
        t.availableAtBuild === r.availableAtBuild &&
        t.mountAsFile === r.mountAsFile
      ) {
        continue;
      }
      if (t && !allowed(t.tier)) continue;
      ops.push({
        type: "variable.set",
        scope,
        ...(service ? { service: service.id } : {}),
        key: k,
        value: await openVariable(key, r),
        tier: r.tier,
        available_at_build: r.availableAtBuild,
        mount_as_file: r.mountAsFile,
        confirm_write_only: true,
        acknowledge_public: false,
      });
    }
    for (const [k, t] of dst) {
      if (credentials.has(k) || src.has(k) || !allowed(t.tier)) continue;
      ops.push({
        type: "variable.delete",
        scope,
        ...(service ? { service: service.id } : {}),
        key: k,
      });
    }
  };

  for (const s of chosen) {
    const [src, dst] = [
      await latestConfig(db, s.id, from.id),
      await latestConfig(db, s.id, target.id),
    ];
    if (!src || !dst) continue;
    if (body.include.config) {
      const patch = promotedPatch(specOf(src), specOf(dst));
      if (patch) ops.push({ type: "config.patch", service: s.id, patch });
    }
    await variableOps("service", s);
    if (body.include.image) {
      const [active] = await db
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.serviceId, s.id),
            eq(deployments.environmentId, from.id),
            eq(deployments.status, "active"),
          ),
        )
        .orderBy(desc(deployments.id))
        .limit(1);
      const [current] = await db
        .select({ image: deployments.image })
        .from(deployments)
        .where(
          and(
            eq(deployments.serviceId, s.id),
            eq(deployments.environmentId, target.id),
            eq(deployments.status, "active"),
          ),
        )
        .limit(1);
      if (active?.image && active.image !== current?.image) {
        ops.push({
          type: "deployment.promote",
          service_id: s.id,
          from_deployment_id: active.id,
          from_environment_id: from.id,
          image: active.image,
        });
      }
    }
  }
  if (body.services === "all") await variableOps("shared", null);
  return ops;
}
