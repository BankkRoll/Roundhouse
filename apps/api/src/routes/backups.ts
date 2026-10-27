/**
 * Backup, restore and backup storage routes (ADR 0004): `BACKUP_ROUTES` in
 * `../contracts/backups`.
 *
 * - Policies: one per service and environment, upserted; `next_run_at` is
 *   recomputed on every save and claimed by the minute tick.
 * - Backups: listed newest first; a manual backup is pinned and runs in
 *   `BackupWorkflow`; deleting removes the S3 object, then marks the row.
 * - Download and decryption key: a 15-minute presigned `GET`, and the
 *   project's age identity (fresh session); both audited without values.
 * - Restores: `confirm` must equal the service slug and the session must be
 *   fresh; `in_place` takes a `pre_restore` safety backup first unless
 *   skipped, then runs `RestoreWorkflow`.
 * - Storage: instance admins set the bucket from a browser session; the
 *   credentials are checked with a `HeadObject` before they are stored.
 *
 * SECURITY: no response but the download carries a URL, only the
 * decryption-key route returns key material, and no audit entry holds a URL,
 * a key or a credential.
 *
 * @module
 */
import {
  backupPolicies,
  backups,
  credentialRotations,
  restores,
  type services,
} from "@roundhouse/db";
import {
  DEFAULT_BACKUP_KEEP_LAST,
  DEFAULT_BACKUP_SCHEDULE,
  type InstanceAction,
  newId,
  nextCronRuns,
} from "@roundhouse/shared";
import { and, desc, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import { type AppContext, clientIp, createRouter, requireInstanceAction } from "../context";
import {
  createBackup,
  downloadBackup,
  getBackup,
  getBackupDecryptionKey,
  getBackupPolicy,
  getBackupStorage,
  getRestore,
  listBackups,
  policyOf,
  putBackupPolicy,
  putBackupStorage,
  removeBackup,
  restoreBackup,
} from "../contracts";
import { ageRecipientOf } from "../lib/age";
import { auditInsert } from "../lib/audit";
import {
  type BackupRow,
  backupMethodFor,
  createBackupRow,
  deleteBackup,
  startBackupWorkflow,
} from "../lib/backups/backups";
import { loadBackupIdentity } from "../lib/backups/keys";
import { type RestoreRow, restoreServiceSlug, startRestoreWorkflow } from "../lib/backups/restores";
import { nextBackupSlot } from "../lib/backups/schedule";
import {
  getBackupStorageView,
  isBackupStorageConfigured,
  normalizeEndpoint,
  prepareBackupStorage,
  requireBackupStorage,
  storageNotConfigured,
  putBackupStorage as storeBackupStorage,
} from "../lib/backups/storage";
import { addDatabaseService } from "../lib/changes/database";
import type { ProjectRow } from "../lib/changes/store";
import { ApiError, conflict, notFound } from "../lib/errors";
import { requireFreshSession } from "../lib/fresh-session";
import { DOWNLOAD_URL_TTL_S, headObject, presignGet, S3Error } from "../lib/s3";
import { environmentOf, projectScope, serviceScope } from "../lib/scope";
import { volumeOf } from "../lib/volumes";

type Action = NonNullable<ReturnType<typeof policyOf>["action"]>;
type PolicyRow = typeof backupPolicies.$inferSelect;
type ServiceRow = typeof services.$inferSelect;

const ms = (d: Date | null) => (d ? +d : null);

function toApiBackup(b: BackupRow) {
  return {
    id: b.id,
    project_id: b.projectId,
    service_id: b.serviceId,
    environment_id: b.environmentId,
    volume_id: b.volumeId,
    policy_id: b.policyId,
    trigger: b.trigger,
    method: b.method,
    engine: b.engine,
    engine_version: b.engineVersion,
    status: b.status,
    node_id: b.nodeId,
    pinned: b.pinned,
    part_count: b.partCount,
    bytes_raw: b.bytesRaw,
    bytes_stored: b.bytesStored,
    sha256: b.sha256,
    error: b.error,
    requested_by: b.requestedBy,
    scheduled_for: ms(b.scheduledFor),
    started_at: ms(b.startedAt),
    finished_at: ms(b.finishedAt),
    created_at: +b.createdAt,
  };
}

function toApiRestore(r: RestoreRow) {
  return {
    id: r.id,
    backup_id: r.backupId,
    mode: r.mode,
    target_service_id: r.targetServiceId,
    target_environment_id: r.targetEnvironmentId,
    safety_backup_id: r.safetyBackupId,
    status: r.status,
    error: r.error,
    requested_by: r.requestedBy,
    started_at: ms(r.startedAt),
    finished_at: ms(r.finishedAt),
    created_at: +r.createdAt,
  };
}

function toApiPolicy(
  serviceId: string,
  environmentId: string,
  engine: string | null,
  p: PolicyRow | undefined,
  now: number,
) {
  const enabled = p?.enabled ?? false;
  const schedule = p?.schedule ?? DEFAULT_BACKUP_SCHEDULE;
  return {
    id: p?.id ?? null,
    service_id: serviceId,
    environment_id: environmentId,
    enabled,
    method: p?.method ?? backupMethodFor(engine),
    schedule,
    timezone: p?.timezone ?? "UTC",
    keep_last: p?.keepLast ?? DEFAULT_BACKUP_KEEP_LAST,
    max_age_days: p?.maxAgeDays ?? null,
    quiesce: p?.quiesce ?? "none",
    databases: p?.databases ?? null,
    next_run_at: ms(p?.nextRunAt ?? null),
    next_runs: enabled ? nextCronRuns(schedule, now, 3) : [],
  };
}

/**
 * Starts a `new_service` restore (ADR 0004, "Restore"): adds a database of
 * the backup's engine and version, with fresh write-only credentials and its
 * own volume, through a change set applied in the target environment, then
 * hands the restore to `RestoreWorkflow`, which waits for it to run healthy
 * before restoring into it. The backed-up service is not touched.
 *
 * Only dumps qualify: a snapshot carries the source's data directory, and
 * with it the source's passwords, which the new service's credentials
 * would not match.
 */
async function startNewServiceRestore(
  c: AppContext,
  input: {
    backup: BackupRow;
    service: ServiceRow;
    project: ProjectRow;
    body: { target_environment_id?: string | undefined; slug?: string | undefined };
  },
): Promise<RestoreRow> {
  const { backup, service, body } = input;
  const db = c.get("db");
  const targetEnvId = body.target_environment_id ?? backup.environmentId;
  const inTarget = await projectScope(c, input.project.id, "services:manage", targetEnvId);
  for (const action of ["variables:manage", "deployments:create"] as const) {
    if (!inTarget.caller.allows(action)) {
      throw new ApiError(
        403,
        "forbidden",
        `Restoring into a new service creates and deploys a database: it needs ${action}`,
      );
    }
  }
  const engine = backup.engine ?? service.databaseEngine;
  if (!engine || backup.method !== "dump") {
    throw new ApiError(
      422,
      "restore_mode_unsupported",
      engine
        ? "A snapshot of a database carries its passwords; restore it in place, or restore a dump into a new service"
        : "Only a database backup can be restored into a new service; restore this snapshot in place",
    );
  }
  if (backup.status !== "succeeded") throw conflict("Only a succeeded backup can be restored");
  if (!(await isBackupStorageConfigured(db))) throw storageNotConfigured();
  const { project, caller } = await projectScope(c, input.project.id, "projects:read");
  const environment = await environmentOf(c, project.id, targetEnvId);
  const source = await volumeOf(db, backup.serviceId, backup.environmentId);
  const now = Date.now();
  const { service: created } = await addDatabaseService(
    c,
    { project, environment, caller },
    {
      engine,
      ...((backup.engineVersion ?? service.databaseVersion)
        ? { version: (backup.engineVersion ?? service.databaseVersion)! }
        : {}),
      ...(source ? { sizeMb: source.sizeMb } : {}),
      name: `${service.name} restore ${new Date(now).toISOString().slice(0, 10)}`.slice(0, 100),
      slug: body.slug ?? restoreServiceSlug(service.slug, now),
      deploy: true,
      title: `Restore ${service.name} into a new service`,
      auditMetadata: { backup_id: backup.id },
    },
  );
  const id = newId("restore");
  const at = new Date();
  const [[restore]] = await db.batch([
    db
      .insert(restores)
      .values({
        id,
        backupId: backup.id,
        mode: "new_service",
        targetServiceId: created.id,
        targetEnvironmentId: environment.id,
        safetyBackupId: null,
        status: "queued",
        requestedBy: caller.user.id,
        createdAt: at,
        updatedAt: at,
      })
      .returning(),
    auditInsert(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "restore.started",
      targetType: "restore",
      targetId: id,
      metadata: {
        project_id: project.id,
        backup_id: backup.id,
        mode: "new_service",
        source_service_id: backup.serviceId,
        service_id: created.id,
        environment_id: environment.id,
      },
      ip: clientIp(c),
    }),
  ]);
  await startRestoreWorkflow(c.env, id);
  return restore!;
}

/**
 * Loads a backup and authorizes the caller on its service. Callers who
 * can't see the service get the same 404 as for a missing backup.
 */
async function backupScope(c: AppContext, backupId: string, action: Action) {
  const [backup] = await c
    .get("db")
    .select()
    .from(backups)
    .where(eq(backups.id, backupId))
    .limit(1);
  if (!backup) throw notFound("Backup");
  try {
    return { backup, ...(await serviceScope(c, backup.serviceId, action, backup.environmentId)) };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) throw notFound("Backup");
    throw err;
  }
}

/** Backup routes. */
export const backupRoutes = createRouter()
  .openapi(getBackupPolicy, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    const { service, project } = await serviceScope(
      c,
      serviceId,
      policyOf(getBackupPolicy).action!,
      environment_id,
    );
    const env = await environmentOf(c, project.id, environment_id);
    const [policy] = await c
      .get("db")
      .select()
      .from(backupPolicies)
      .where(and(eq(backupPolicies.serviceId, serviceId), eq(backupPolicies.environmentId, env.id)))
      .limit(1);
    return c.json(toApiPolicy(serviceId, env.id, service.databaseEngine, policy, Date.now()), 200);
  })
  .openapi(putBackupPolicy, async (c) => {
    const { serviceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { service, project, caller } = await serviceScope(
      c,
      serviceId,
      policyOf(putBackupPolicy).action!,
      body.environment_id,
    );
    const env = await environmentOf(c, project.id, body.environment_id);
    const db = c.get("db");
    if (!(await volumeOf(db, serviceId, env.id))) {
      throw conflict(`${service.name} has no volume in ${env.name} to back up`);
    }
    const method = backupMethodFor(service.databaseEngine);
    if (method === "dump" && body.quiesce === "stop") {
      throw new ApiError(422, "invalid_request", "quiesce: stop applies to snapshots only");
    }
    if (method === "snapshot" && body.databases) {
      throw new ApiError(422, "invalid_request", "databases applies to database services only");
    }
    const [current] = await db
      .select()
      .from(backupPolicies)
      .where(and(eq(backupPolicies.serviceId, serviceId), eq(backupPolicies.environmentId, env.id)))
      .limit(1);
    const now = Date.now();
    const enabled = body.enabled ?? current?.enabled ?? true;
    if (enabled && !(await isBackupStorageConfigured(db))) throw storageNotConfigured();
    const schedule = body.schedule ?? current?.schedule ?? DEFAULT_BACKUP_SCHEDULE;
    const next = enabled ? nextBackupSlot(schedule, now) : null;
    const values = {
      enabled,
      method,
      schedule,
      timezone: "UTC",
      keepLast: body.keep_last ?? current?.keepLast ?? DEFAULT_BACKUP_KEEP_LAST,
      maxAgeDays:
        body.max_age_days !== undefined ? body.max_age_days : (current?.maxAgeDays ?? null),
      quiesce: body.quiesce ?? current?.quiesce ?? "none",
      databases: body.databases !== undefined ? body.databases : (current?.databases ?? null),
      nextRunAt: next === null ? null : new Date(next),
      updatedAt: new Date(now),
    };
    const changed = Object.keys(body).filter((k) => k !== "environment_id");
    const [[saved]] = await db.batch([
      db
        .insert(backupPolicies)
        .values({
          id: newId("backupPolicy"),
          serviceId,
          environmentId: env.id,
          createdAt: new Date(now),
          ...values,
        })
        .onConflictDoUpdate({
          target: [backupPolicies.serviceId, backupPolicies.environmentId],
          set: values,
        })
        .returning(),
      auditInsert(db, {
        workspaceId: project.workspaceId,
        ...caller.actor,
        action: "backup.policy_updated",
        targetType: "service",
        targetId: serviceId,
        metadata: {
          project_id: project.id,
          environment_id: env.id,
          changed,
          enabled,
          schedule,
          keep_last: values.keepLast,
          max_age_days: values.maxAgeDays,
        },
        ip: clientIp(c),
      }),
    ]);
    return c.json(toApiPolicy(serviceId, env.id, service.databaseEngine, saved, now), 200);
  })
  .openapi(listBackups, async (c) => {
    const { serviceId } = c.req.valid("param");
    const query = c.req.valid("query");
    const { project } = await serviceScope(
      c,
      serviceId,
      policyOf(listBackups).action!,
      query.environment_id,
    );
    const env = await environmentOf(c, project.id, query.environment_id);
    const rows = await c
      .get("db")
      .select()
      .from(backups)
      .where(
        and(
          eq(backups.serviceId, serviceId),
          eq(backups.environmentId, env.id),
          ne(backups.status, "deleted"),
          query.cursor ? lt(backups.id, query.cursor) : undefined,
        ),
      )
      .orderBy(desc(backups.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    return c.json(
      {
        backups: page.map(toApiBackup),
        next_cursor: rows.length > query.limit ? page.at(-1)!.id : null,
      },
      200,
    );
  })
  .openapi(createBackup, async (c) => {
    const { serviceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { service, project, caller } = await serviceScope(
      c,
      serviceId,
      policyOf(createBackup).action!,
      body.environment_id,
    );
    const env = await environmentOf(c, project.id, body.environment_id);
    const db = c.get("db");
    if (!(await isBackupStorageConfigured(db))) throw storageNotConfigured();
    const volume = await volumeOf(db, serviceId, env.id);
    if (!volume) throw conflict(`${service.name} has no volume in ${env.name} to back up`);
    const row = await createBackupRow(db, {
      projectId: project.id,
      serviceId,
      environmentId: env.id,
      trigger: "manual",
      method: backupMethodFor(service.databaseEngine),
      engine: service.databaseEngine,
      engineVersion: service.databaseVersion,
      volumeId: volume.id,
      pinned: true,
      requestedBy: caller.user.id,
    });
    await auditInsert(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "backup.requested",
      targetType: "backup",
      targetId: row.id,
      metadata: { project_id: project.id, service_id: serviceId, environment_id: env.id },
      ip: clientIp(c),
    });
    try {
      await startBackupWorkflow(c.env, row.id);
    } catch (err) {
      // NOTE: the minute tick re-starts `queued` backups, so this one still runs.
      console.error("backup workflow start failed", err instanceof Error ? err.name : "error");
    }
    return c.json(toApiBackup(row), 202);
  })
  .openapi(getBackup, async (c) => {
    const { backupId } = c.req.valid("param");
    const { backup } = await backupScope(c, backupId, policyOf(getBackup).action!);
    return c.json(toApiBackup(backup), 200);
  })
  .openapi(removeBackup, async (c) => {
    const { backupId } = c.req.valid("param");
    const { backup, project, caller } = await backupScope(
      c,
      backupId,
      policyOf(removeBackup).action!,
    );
    if (backup.status === "deleted") return c.body(null, 204);
    if (backup.status === "queued" || backup.status === "running") {
      throw conflict("The backup is still running");
    }
    const db = c.get("db");
    const [reading] = await db
      .select({ id: restores.id })
      .from(restores)
      .where(and(eq(restores.backupId, backupId), inArray(restores.status, ["queued", "running"])))
      .limit(1);
    if (reading) throw conflict(`Restore ${reading.id} is reading this backup`);
    const s3 = await requireBackupStorage(db, c.env);
    if (await deleteBackup(db, s3, backup)) {
      await auditInsert(db, {
        workspaceId: project.workspaceId,
        ...caller.actor,
        action: "backup.deleted",
        targetType: "backup",
        targetId: backupId,
        metadata: {
          project_id: project.id,
          service_id: backup.serviceId,
          environment_id: backup.environmentId,
          trigger: backup.trigger,
        },
        ip: clientIp(c),
      });
    }
    return c.body(null, 204);
  })
  .openapi(downloadBackup, async (c) => {
    const { backupId } = c.req.valid("param");
    const { backup, project, caller } = await backupScope(
      c,
      backupId,
      policyOf(downloadBackup).action!,
    );
    if (backup.status !== "succeeded") throw conflict("Only a succeeded backup can be downloaded");
    const db = c.get("db");
    const s3 = await requireBackupStorage(db, c.env);
    const url = await presignGet(s3, backup.objectKey, DOWNLOAD_URL_TTL_S);
    await auditInsert(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "backup.downloaded",
      targetType: "backup",
      targetId: backupId,
      metadata: {
        project_id: project.id,
        service_id: backup.serviceId,
        environment_id: backup.environmentId,
      },
      ip: clientIp(c),
    });
    return c.json(
      {
        url,
        expires_at: Date.now() + DOWNLOAD_URL_TTL_S * 1000,
        filename: `${backup.id}.rhbk.zst.age`,
        sha256: backup.sha256,
      },
      200,
    );
  })
  .openapi(getBackupDecryptionKey, async (c) => {
    const { backupId } = c.req.valid("param");
    const { backup, project, caller } = await backupScope(
      c,
      backupId,
      policyOf(getBackupDecryptionKey).action!,
    );
    await requireFreshSession(c);
    const db = c.get("db");
    const identity = await loadBackupIdentity(db, c.env, project.id);
    if (!identity) throw conflict("This project has no backup key yet");
    const recipient = await ageRecipientOf(identity);
    await auditInsert(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "backup.key_revealed",
      targetType: "backup",
      targetId: backupId,
      metadata: { project_id: project.id, service_id: backup.serviceId },
      ip: clientIp(c),
    });
    return c.json({ identity, recipient }, 200);
  })
  .openapi(restoreBackup, async (c) => {
    const { backupId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { backup, service, project, caller } = await backupScope(
      c,
      backupId,
      policyOf(restoreBackup).action!,
    );
    await requireFreshSession(c);
    if (body.confirm !== service.slug) {
      throw new ApiError(400, "invalid_request", "confirm must equal the service's slug");
    }
    if (body.mode === "new_service") {
      const restore = await startNewServiceRestore(c, { backup, service, project, body });
      return c.json(toApiRestore(restore), 202);
    }
    if (body.target_environment_id && body.target_environment_id !== backup.environmentId) {
      throw new ApiError(400, "invalid_request", "in_place restores into the backup's environment");
    }
    if (backup.status !== "succeeded") throw conflict("Only a succeeded backup can be restored");
    const db = c.get("db");
    if (!(await isBackupStorageConfigured(db))) throw storageNotConfigured();
    if (service.databaseEngine && backup.method === "snapshot") {
      // SECURITY: a snapshot puts back the passwords the data directory had;
      // after a rotation the variables no longer match them, and nothing
      // (the control plane included) could sign in to change them back.
      const [rotated] = await db
        .select({ id: credentialRotations.id })
        .from(credentialRotations)
        .where(
          and(
            eq(credentialRotations.serviceId, backup.serviceId),
            eq(credentialRotations.environmentId, backup.environmentId),
            gt(credentialRotations.createdAt, backup.startedAt ?? backup.createdAt),
            sql`${credentialRotations.applied} <> '[]'`,
          ),
        )
        .limit(1);
      if (rotated) {
        throw conflict(
          "The credentials were rotated after this snapshot; restoring it would bring back passwords nothing knows. Restore a later backup, or a dump",
        );
      }
    }
    const [busy] = await db
      .select({ id: restores.id })
      .from(restores)
      .where(
        and(
          eq(restores.targetServiceId, backup.serviceId),
          eq(restores.targetEnvironmentId, backup.environmentId),
          inArray(restores.status, ["queued", "running"]),
        ),
      )
      .limit(1);
    if (busy) throw conflict(`Restore ${busy.id} is already running for this service`);

    const safety = body.skip_safety_backup
      ? null
      : await createBackupRow(db, {
          projectId: project.id,
          serviceId: backup.serviceId,
          environmentId: backup.environmentId,
          trigger: "pre_restore",
          method: backupMethodFor(service.databaseEngine),
          engine: service.databaseEngine,
          engineVersion: service.databaseVersion,
          volumeId: null,
          pinned: false,
          requestedBy: caller.user.id,
        });
    const now = new Date();
    const id = newId("restore");
    const [[restore]] = await db.batch([
      db
        .insert(restores)
        .values({
          id,
          backupId,
          mode: "in_place",
          targetServiceId: backup.serviceId,
          targetEnvironmentId: backup.environmentId,
          safetyBackupId: safety?.id ?? null,
          status: "queued",
          requestedBy: caller.user.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning(),
      auditInsert(db, {
        workspaceId: project.workspaceId,
        ...caller.actor,
        action: "restore.started",
        targetType: "restore",
        targetId: id,
        metadata: {
          project_id: project.id,
          backup_id: backupId,
          mode: "in_place",
          service_id: backup.serviceId,
          environment_id: backup.environmentId,
          safety_backup_id: safety?.id ?? null,
        },
        ip: clientIp(c),
      }),
    ]);
    if (safety) await startBackupWorkflow(c.env, safety.id);
    await startRestoreWorkflow(c.env, id);
    return c.json(toApiRestore(restore!), 202);
  })
  .openapi(getRestore, async (c) => {
    const { restoreId } = c.req.valid("param");
    const [restore] = await c
      .get("db")
      .select()
      .from(restores)
      .where(eq(restores.id, restoreId))
      .limit(1);
    if (!restore) throw notFound("Restore");
    try {
      await backupScope(c, restore.backupId, policyOf(getRestore).action!);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw notFound("Restore");
      throw err;
    }
    return c.json(toApiRestore(restore), 200);
  })
  .openapi(getBackupStorage, async (c) => {
    await requireInstanceAction(c, policyOf(getBackupStorage).action as InstanceAction);
    return c.json(await getBackupStorageView(c.get("db")), 200);
  })
  .openapi(putBackupStorage, async (c) => {
    const user = await requireInstanceAction(
      c,
      policyOf(putBackupStorage).action as InstanceAction,
    );
    await requireFreshSession(c);
    const body = c.req.valid("json");
    const endpoint = normalizeEndpoint(body.endpoint, c.env.ROUNDHOUSE_DEV === "1");
    if (!endpoint) {
      throw new ApiError(
        400,
        "invalid_request",
        "endpoint must be an https:// origin with no path, query or credentials",
      );
    }
    const db = c.get("db");
    const before = await getBackupStorageView(db);
    const { stored, config } = await prepareBackupStorage(db, c.env, { ...body, endpoint });
    try {
      // Any answer but 403/5xx proves the endpoint, bucket and key work together.
      await headObject(config, `roundhouse-probe/${newId("message")}`);
    } catch (err) {
      throw new ApiError(
        422,
        "backup_storage_unreachable",
        err instanceof S3Error ? err.message : "The bucket could not be reached",
      );
    }
    const changed = (["endpoint", "bucket", "region", "access_key_id"] as const).filter(
      (k) => before[k] !== stored[k],
    );
    await db.batch([
      storeBackupStorage(db, stored),
      auditInsert(db, {
        workspaceId: null,
        actorType: "user",
        actorId: user.id,
        action: "instance.settings_updated",
        targetType: "instance",
        metadata: {
          setting: "backup_storage",
          changed:
            body.secret_access_key !== undefined ? [...changed, "secret_access_key"] : changed,
        },
        ip: clientIp(c),
      }),
    ]);
    return c.json(await getBackupStorageView(db), 200);
  });
