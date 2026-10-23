/**
 * Database and volume routes (ADR 0004).
 *
 * - `POST /v1/projects/{projectId}/databases` opens a change set, stages a
 *   `service.create` op with `database`, and applies it, so a database gets
 *   the same authorization, validation and audit as any reviewed change.
 * - Volume routes read a service's volume and grow, soft-delete or undelete
 *   it, then push the holding node's desired state.
 * - Migration routes list where a volume can move, start the move in
 *   `VolumeMigrationWorkflow`, and report on it.
 * - TCP proxy routes publish a service's port behind a source allowlist, or
 *   stop publishing it, and push the replica's node.
 *
 * SECURITY: a database's generated credentials are written as `secret`
 * variables by the apply; this module only ever reports their keys.
 *
 * @module
 */
import {
  changeSets,
  type Db,
  nodes,
  services,
  tcpProxies,
  variables,
  volumeMigrations,
  volumes,
} from "@roundhouse/db";
import { BACKUPS_PROTOCOL_VERSION } from "@roundhouse/protocol";
import { DATABASE_ENGINE_SPECS, newId } from "@roundhouse/shared";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { type AppContext, clientIp, createRouter, requireKeys } from "../context";
import {
  createDatabase,
  deleteTcpProxy,
  deleteVolume,
  getServiceVolume,
  getTcpProxy,
  getVolumeMigration,
  listMigrationTargets,
  listVolumeMigrations,
  migrateVolume,
  policyOf,
  putTcpProxy,
  resizeVolume,
  undeleteVolume,
} from "../contracts";
import { auditInsert, recordAudit } from "../lib/audit";
import { isBackupStorageConfigured, storageNotConfigured } from "../lib/backups/storage";
import { applySet } from "../lib/changes/apply";
import { configAt, type StagingContext, stageIntoSet } from "../lib/changes/staging";
import { openChangeSet } from "../lib/changes/store";
import { refreshNodes } from "../lib/desired-state";
import { ApiError, conflict, notFound } from "../lib/errors";
import { effectiveStatus } from "../lib/nodes";
import { publicOrigin } from "../lib/origin";
import { environmentOf, projectScope, serviceScope } from "../lib/scope";
import { toApiService } from "../lib/serialize";
import {
  allocatePublicPort,
  defaultContainerPort,
  enforcesTcpProxy,
  normalizeAllowlist,
  presentTcpProxy,
  replicaNode,
  tcpProxyOf,
} from "../lib/tcp-proxies";
import {
  createMigrationRow,
  eligibilityContext,
  MIGRATABLE_VOLUME_STATUSES,
  migrationTargets,
  startVolumeMigration,
  targetIneligibility,
  toApiMigration,
} from "../lib/volume-migrations";
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
async function volumeScope(
  c: AppContext,
  volumeId: string,
  action: "services:manage" | "services:read",
) {
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

/** Whether an insert failed on a unique index. */
const isUniqueViolation = (err: unknown) =>
  err instanceof Error && /UNIQUE constraint failed/i.test(err.message);

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
    const ctx: StagingContext = { db, keys: requireKeys(c), project, environment, caller };

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
  })
  .openapi(listMigrationTargets, async (c) => {
    const { volumeId } = c.req.valid("param");
    const { volume, project } = await volumeScope(c, volumeId, "services:read");
    return c.json(await migrationTargets(c.get("db"), volume, project.workspaceId), 200);
  })
  .openapi(migrateVolume, async (c) => {
    const { volumeId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { volume, service, project, caller } = await volumeScope(c, volumeId, "services:manage");
    if (!caller.allows("deployments:create")) {
      throw new ApiError(403, "forbidden", "Moving a volume redeploys its service: it needs deployments:create");
    }
    if (body.confirm !== service.slug) {
      throw new ApiError(400, "invalid_request", "confirm must equal the service's slug");
    }
    const db = c.get("db");
    if (!(await isBackupStorageConfigured(db))) throw storageNotConfigured();
    if (!volume.nodeId || !MIGRATABLE_VOLUME_STATUSES.includes(volume.status)) {
      throw conflict(`The volume is ${volume.status.replace(/_/g, " ")}; only a ready volume moves`);
    }
    const [target] = await db
      .select()
      .from(nodes)
      .where(
        and(
          eq(nodes.id, body.target_node_id),
          eq(nodes.workspaceId, project.workspaceId),
          isNull(nodes.deletedAt),
        ),
      )
      .limit(1);
    if (!target) throw notFound("Node");
    const [source] = await db.select().from(nodes).where(eq(nodes.id, volume.nodeId)).limit(1);
    if (!source || source.deletedAt || effectiveStatus(source) !== "online") {
      throw conflict(
        `The volume's node ${source?.name ?? volume.nodeId} is offline; the copy runs there, so bring it back first`,
      );
    }
    if (source.protocolVersion < BACKUPS_PROTOCOL_VERSION) {
      throw new ApiError(409, "agent_outdated", `Upgrade the agent on ${source.name} to move volumes`);
    }
    const reason = targetIneligibility(target, await eligibilityContext(db, volume));
    if (reason) throw new ApiError(422, "migration_target_ineligible", `${target.name}: ${reason}`);
    let row: Awaited<ReturnType<typeof createMigrationRow>>;
    try {
      row = await createMigrationRow(db, {
        volume,
        targetNodeId: target.id,
        requestedBy: caller.user.id,
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("This volume is already moving");
      throw err;
    }
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "volume.migration_started",
      targetType: "volume",
      targetId: volume.id,
      metadata: {
        project_id: project.id,
        service_id: volume.serviceId,
        environment_id: volume.environmentId,
        migration_id: row.id,
        source_node_id: source.id,
        target_node_id: target.id,
        size_mb: volume.sizeMb,
      },
      ip: clientIp(c),
    });
    await startVolumeMigration(c.env, { migrationId: row.id, origin: publicOrigin(c) });
    return c.json(toApiMigration(row, volume), 202);
  })
  .openapi(listVolumeMigrations, async (c) => {
    const { volumeId } = c.req.valid("param");
    const { volume } = await volumeScope(c, volumeId, "services:read");
    const rows = await c
      .get("db")
      .select()
      .from(volumeMigrations)
      .where(eq(volumeMigrations.volumeId, volume.id))
      .orderBy(desc(volumeMigrations.id))
      .limit(20);
    return c.json({ migrations: rows.map((m) => toApiMigration(m, volume)) }, 200);
  })
  .openapi(getVolumeMigration, async (c) => {
    const { migrationId } = c.req.valid("param");
    const db = c.get("db");
    const [row] = await db
      .select()
      .from(volumeMigrations)
      .where(eq(volumeMigrations.id, migrationId))
      .limit(1);
    if (!row) throw notFound("Volume migration");
    let volume: VolumeRow;
    try {
      ({ volume } = await volumeScope(c, row.volumeId, "services:read"));
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw notFound("Volume migration");
      throw err;
    }
    return c.json(toApiMigration(row, volume), 200);
  })
  .openapi(getTcpProxy, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    const { project } = await serviceScope(c, serviceId, "services:read", environment_id);
    await environmentOf(c, project.id, environment_id);
    const db = c.get("db");
    const proxy = await tcpProxyOf(db, serviceId, environment_id);
    if (!proxy) throw notFound("TCP proxy");
    return c.json(await presentTcpProxy(db, proxy), 200);
  })
  .openapi(putTcpProxy, async (c) => {
    const { serviceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { service, project, caller } = await serviceScope(
      c,
      serviceId,
      "services:manage",
      body.environment_id,
    );
    const env = await environmentOf(c, project.id, body.environment_id);
    const db = c.get("db");
    const allowed = normalizeAllowlist(body.allowed_cidrs, body.acknowledge_open ?? false);
    const config = await configAt(db, service.id, env.id);
    if (!config) throw conflict(`${service.name} has no config in ${env.name}`);
    if (config.deploy.replicas > 1) {
      throw new ApiError(
        422,
        "volume_requires_single_replica",
        "Only a single-replica service can publish a TCP port; scale it to one replica first",
      );
    }
    const containerPort = body.container_port ?? defaultContainerPort(service, config.networking.port);
    const node = await replicaNode(db, service.id, env.id);
    if (node && !enforcesTcpProxy(node)) {
      throw new ApiError(
        409,
        "tcp_proxy_unsupported",
        `The agent on ${node.name} can't enforce a source allowlist; upgrade it to publish ports`,
      );
    }
    const existing = await tcpProxyOf(db, service.id, env.id);
    const now = new Date();
    let saved: typeof tcpProxies.$inferSelect | undefined;
    if (existing) {
      [saved] = await db
        .update(tcpProxies)
        .set({ containerPort, allowedCidrs: allowed, updatedAt: now })
        .where(eq(tcpProxies.id, existing.id))
        .returning();
    } else {
      for (let attempt = 0; attempt < 3 && !saved; attempt++) {
        try {
          [saved] = await db
            .insert(tcpProxies)
            .values({
              id: newId("tcpProxy"),
              projectId: project.id,
              serviceId: service.id,
              environmentId: env.id,
              containerPort,
              publicPort: await allocatePublicPort(db),
              allowedCidrs: allowed,
              createdBy: caller.user.id,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          // A concurrent PUT for this service won, or took the port; read again.
          const raced = await tcpProxyOf(db, service.id, env.id);
          if (raced) throw conflict("The TCP proxy changed at the same time; reload and retry");
        }
      }
      if (!saved) throw conflict("Could not allocate a public port; retry");
    }
    await auditInsert(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: existing ? "tcp_proxy.updated" : "tcp_proxy.enabled",
      targetType: "service",
      targetId: service.id,
      metadata: {
        project_id: project.id,
        environment_id: env.id,
        tcp_proxy_id: saved!.id,
        container_port: containerPort,
        public_port: saved!.publicPort,
        allowed_cidrs: allowed,
        open_to_all: allowed.some((x) => x.endsWith("/0")),
        ...(existing ? { previous_cidrs: existing.allowedCidrs } : {}),
      },
      ip: clientIp(c),
    });
    if (node) await refreshNodes(c.env, db, [node.id]);
    return c.json(await presentTcpProxy(db, saved!), 200);
  })
  .openapi(deleteTcpProxy, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    const { project, caller } = await serviceScope(c, serviceId, "services:manage", environment_id);
    await environmentOf(c, project.id, environment_id);
    const db = c.get("db");
    const proxy = await tcpProxyOf(db, serviceId, environment_id);
    if (!proxy) throw notFound("TCP proxy");
    const node = await replicaNode(db, serviceId, environment_id);
    await db.batch([
      db.delete(tcpProxies).where(eq(tcpProxies.id, proxy.id)),
      auditInsert(db, {
        workspaceId: project.workspaceId,
        ...caller.actor,
        action: "tcp_proxy.disabled",
        targetType: "service",
        targetId: serviceId,
        metadata: {
          project_id: project.id,
          environment_id,
          tcp_proxy_id: proxy.id,
          public_port: proxy.publicPort,
        },
        ip: clientIp(c),
      }),
    ]);
    if (node) await refreshNodes(c.env, db, [node.id]);
    return c.body(null, 204);
  });
