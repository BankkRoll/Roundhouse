/**
 * Database and volume routes (ADR 0004).
 *
 * - `POST /v1/projects/{projectId}/databases` opens a change set, stages a
 *   `service.create` op with `database`, and applies it, so a database gets
 *   the same authorization, validation and audit as any reviewed change.
 * - Volume routes read a service's volume and grow, soft-delete or undelete
 *   it, then push the holding node's desired state.
 *
 * SECURITY: a database's generated credentials are written as `secret`
 * variables by the apply; this module only ever reports their keys.
 *
 * @module
 */
import { changeSets, type Db, nodes, services, variables, volumes } from "@roundhouse/db";
import { DATABASE_ENGINE_SPECS } from "@roundhouse/shared";
import { and, asc, eq, isNull } from "drizzle-orm";
import { type AppContext, clientIp, createRouter, requireKeys } from "../context";
import {
  createDatabase,
  deleteVolume,
  getServiceVolume,
  policyOf,
  resizeVolume,
  undeleteVolume,
} from "../contracts";
import { recordAudit } from "../lib/audit";
import { applySet } from "../lib/changes/apply";
import { type StagingContext, stageIntoSet } from "../lib/changes/staging";
import { openChangeSet } from "../lib/changes/store";
import { refreshNodes } from "../lib/desired-state";
import { ApiError, notFound } from "../lib/errors";
import { environmentOf, projectScope, serviceScope } from "../lib/scope";
import { toApiService } from "../lib/serialize";
import {
  resizeVolume as growVolume,
  undeleteVolume as restoreVolume,
  deleteVolume as softDeleteVolume,
  toApiVolume,
  type VolumeRow,
  volumeOf,
} from "../lib/volumes";

async function nodeName(db: Db, nodeId: string | null): Promise<string | null> {
  if (!nodeId) return null;
  const row = await db.query.nodes.findFirst({
    where: eq(nodes.id, nodeId),
    columns: { name: true },
  });
  return row?.name ?? null;
}

async function present(db: Db, v: VolumeRow) {
  return toApiVolume(v, await nodeName(db, v.nodeId));
}

/**
 * Loads a volume of a live service and authorizes the caller in its
 * environment, so protection rules apply.
 */
async function volumeScope(c: AppContext, volumeId: string, action: "services:manage") {
  const db = c.get("db");
  const [row] = await db
    .select({ volume: volumes })
    .from(volumes)
    .innerJoin(services, eq(services.id, volumes.serviceId))
    .where(and(eq(volumes.id, volumeId), isNull(services.deletedAt)))
    .limit(1);
  if (!row) throw notFound("Volume");
  const scope = await serviceScope(c, row.volume.serviceId, action, row.volume.environmentId);
  return { volume: row.volume, ...scope };
}

const forbidden = (action: string) =>
  new ApiError(403, "forbidden", `Adding a database needs ${action}, which you lack here`);

/** Database and volume routes. */
export const databaseRoutes = createRouter()
  .openapi(createDatabase, async (c) => {
    const { projectId } = c.req.valid("param");
    const input = c.req.valid("json");
    const db = c.get("db");
    const inEnv = await projectScope(
      c,
      projectId,
      policyOf(createDatabase).action!,
      input.environment_id,
    );
    if (!inEnv.caller.allows("variables:manage")) throw forbidden("variables:manage");
    if (input.deploy && !inEnv.caller.allows("deployments:create")) {
      throw forbidden("deployments:create");
    }
    const { project, caller } = await projectScope(c, projectId, "projects:read");
    const environment = await environmentOf(c, project.id, input.environment_id);
    const ctx: StagingContext = { c, db, keys: requireKeys(c), project, environment, caller };

    let set = await openChangeSet(db, {
      projectId: project.id,
      environmentId: environment.id,
      source: "api",
      isDraft: false,
      caller,
      title: `Add a ${input.engine} database`,
    });
    try {
      set = await stageIntoSet(ctx, set, {
        type: "service.create",
        ref: "new:1",
        kind: "database",
        name: input.name ?? DATABASE_ENGINE_SPECS[input.engine].name,
        ...(input.slug !== undefined ? { slug: input.slug } : {}),
        database: {
          engine: input.engine,
          ...(input.version !== undefined ? { version: input.version } : {}),
          ...(input.size_mb !== undefined ? { size_mb: input.size_mb } : {}),
        },
      });
    } catch (err) {
      await db.delete(changeSets).where(eq(changeSets.id, set.id));
      throw err;
    }
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "change_set.created",
      targetType: "change_set",
      targetId: set.id,
      metadata: {
        project_id: project.id,
        environment_id: environment.id,
        source: "api",
        ops: 1,
        engine: input.engine,
      },
      ip: clientIp(c),
    });

    const applied = await applySet({ c, db, env: c.env, project, environment }, set, {
      expectedRevision: set.revision,
      deploy: input.deploy ? "affected" : "none",
      direct: true,
    });
    const [op] = await db.query.stagedChanges.findMany({
      where: (t, { eq: e }) => e(t.changeSetId, set.id),
    });
    const serviceId = String(op?.result?.service_id ?? "");
    const service = await db.query.services.findFirst({ where: eq(services.id, serviceId) });
    if (!service) throw new ApiError(500, "internal", "The database was not created");
    const vols = await db
      .select()
      .from(volumes)
      .where(eq(volumes.serviceId, service.id))
      .orderBy(asc(volumes.environmentId));
    const vars = await db
      .select({ key: variables.key, tier: variables.tier })
      .from(variables)
      .where(and(eq(variables.serviceId, service.id), eq(variables.environmentId, environment.id)))
      .orderBy(asc(variables.key));
    return c.json(
      {
        change_set_id: applied.set.id,
        service: toApiService(service),
        engine: service.databaseEngine!,
        version: service.databaseVersion!,
        volumes: await Promise.all(vols.map((v) => present(db, v))),
        variables: vars.map((v) => ({ key: v.key, secret: v.tier === "secret" })),
        deployment_ids: applied.deploymentIds,
        skipped: applied.skipped,
      },
      201,
    );
  })
  .openapi(getServiceVolume, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    const { project } = await serviceScope(c, serviceId, policyOf(getServiceVolume).action!);
    await environmentOf(c, project.id, environment_id);
    const db = c.get("db");
    const volume = await volumeOf(db, serviceId, environment_id);
    if (!volume) throw notFound("Volume");
    return c.json(await present(db, volume), 200);
  })
  .openapi(resizeVolume, async (c) => {
    const { volumeId } = c.req.valid("param");
    const { size_mb } = c.req.valid("json");
    const { volume, project, caller } = await volumeScope(c, volumeId, "services:manage");
    const db = c.get("db");
    const row = await growVolume(db, volume, size_mb);
    if (row.nodeId) await refreshNodes(c.env, db, [row.nodeId]);
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "volume.resized",
      targetType: "volume",
      targetId: row.id,
      metadata: {
        service_id: row.serviceId,
        environment_id: row.environmentId,
        from_mb: volume.sizeMb,
        to_mb: row.sizeMb,
      },
      ip: clientIp(c),
    });
    return c.json(await present(db, row), 200);
  })
  .openapi(deleteVolume, async (c) => {
    const { volumeId } = c.req.valid("param");
    const { volume, project, caller } = await volumeScope(c, volumeId, "services:manage");
    const db = c.get("db");
    const row = await softDeleteVolume(db, volume);
    if (row.nodeId) await refreshNodes(c.env, db, [row.nodeId]);
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "volume.deleted",
      targetType: "volume",
      targetId: row.id,
      metadata: {
        service_id: row.serviceId,
        environment_id: row.environmentId,
        delete_after: row.deleteAfter ? +row.deleteAfter : null,
      },
      ip: clientIp(c),
    });
    return c.json(await present(db, row), 200);
  })
  .openapi(undeleteVolume, async (c) => {
    const { volumeId } = c.req.valid("param");
    const { volume, project, caller } = await volumeScope(c, volumeId, "services:manage");
    const db = c.get("db");
    const row = await restoreVolume(db, volume);
    if (row.nodeId) await refreshNodes(c.env, db, [row.nodeId]);
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "volume.undeleted",
      targetType: "volume",
      targetId: row.id,
      metadata: { service_id: row.serviceId, environment_id: row.environmentId },
      ip: clientIp(c),
    });
    return c.json(await present(db, row), 200);
  });
