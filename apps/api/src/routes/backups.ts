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
 *   skipped, then runs `RestoreWorkflow`. With `target_node_id` it
 *   recovers a lost node's volume onto another node instead
 *   (`../lib/backups/recovery`).
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
  recoveryPolicies,
  restores,
  type services,
} from "@roundhouse/db";
import {
  DEFAULT_BACKUP_KEEP_LAST,
  DEFAULT_BACKUP_SCHEDULE,
  DEFAULT_RECOVERY_GRACE_MINUTES,
  type InstanceAction,
  newId,
  nextCronRuns,
} from "@roundhouse/shared";
import { and, desc, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import {
  type AppContext,
  type Caller,
  clientIp,
  createRouter,
  requireInstanceAction,
} from "../context";
import {
  createBackup,
  downloadBackup,
  getBackup,
  getBackupDecryptionKey,
  getBackupPolicy,
  getBackupStorage,
  getPitrStatus,
  getRecoveryPolicy,
  getRestore,
  listBackups,
  policyOf,
  putBackupPolicy,
  putBackupStorage,
  putRecoveryPolicy,
  removeBackup,
  restoreBackup,
  restorePitr,
} from "../contracts";
import { ageRecipientOf } from "../lib/age";
import { auditInsert } from "../lib/audit";
import { toApiRecoveryPolicy } from "../lib/backups/auto-recovery";
import {
  type BackupRow,
  backupMethodFor,
  createBackupRow,
  deleteBackup,
  startBackupWorkflow,
} from "../lib/backups/backups";
import { loadBackupIdentity } from "../lib/backups/keys";
import {
  activeWalStream,
  ensureWalStream,
  pitrIneligibility,
  pitrWindows,
  planPitrRestore,
  requestBaseBackup,
  retireWalStreams,
} from "../lib/backups/pitr";
import { startVolumeRecovery } from "../lib/backups/recovery";
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
import { refreshNodes } from "../lib/desired-state";
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
    target_node_id: r.targetNodeId,
    trigger: r.trigger,
    target_time: ms(r.targetTime),
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
    pitr: p?.pitr ?? false,
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
    pitr: PitrTarget | null;
  },
): Promise<RestoreRow> {
  const { backup, service, body, pitr } = input;
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
  // NOTE: a base backup carries the source's passwords too, but the agent
  // puts the new service's own back once it has recovered.
  if (!engine || backup.method === "snapshot") {
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
        ...pitrColumns(pitr),
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
        ...(pitr ? { target_time: pitr.targetTime } : {}),
      },
      ip: clientIp(c),
    }),
  ]);
  await startRestoreWorkflow(c.env, id);
  return restore!;
}

/** A point-in-time restore's plan, as the restore row records it. */
interface PitrTarget {
  targetTime: number;
  walFiles: number;
  walEnd: string;
}

/** The `restores` columns of a point-in-time restore. */
function pitrColumns(pitr: PitrTarget | null) {
  return pitr
    ? { targetTime: new Date(pitr.targetTime), walFiles: pitr.walFiles, walEnd: pitr.walEnd }
    : {};
}

/**
 * Starts a restore of a succeeded backup once the route has checked the
 * caller, the fresh session and the confirmation: into a new service, in
 * place (with a safety backup unless skipped), or onto another server for
 * a lost one. A point-in-time restore passes its plan along.
 */
async function startRestore(
  c: AppContext,
  input: {
    backup: BackupRow;
    service: ServiceRow;
    project: ProjectRow;
    caller: Caller;
    body: {
      mode: "in_place" | "new_service";
      target_environment_id?: string | undefined;
      slug?: string | undefined;
      skip_safety_backup?: boolean | undefined;
      target_node_id?: string | undefined;
    };
    pitr: PitrTarget | null;
  },
): Promise<RestoreRow> {
  const { backup, service, project, caller, body, pitr } = input;
  if (body.target_node_id !== undefined && body.mode !== "in_place") {
    throw new ApiError(400, "invalid_request", "target_node_id applies to in_place restores only");
  }
  if (body.mode === "new_service") {
    return startNewServiceRestore(c, { backup, service, project, body, pitr });
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

  if (body.target_node_id !== undefined) {
    const restore = await startVolumeRecovery(c, {
      backup,
      service,
      project,
      caller,
      targetNodeId: body.target_node_id,
    });
    await startRestoreWorkflow(c.env, restore.id);
    return restore;
  }

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
        backupId: backup.id,
        mode: "in_place",
        targetServiceId: backup.serviceId,
        targetEnvironmentId: backup.environmentId,
        safetyBackupId: safety?.id ?? null,
        ...pitrColumns(pitr),
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
        backup_id: backup.id,
        mode: "in_place",
        service_id: backup.serviceId,
        environment_id: backup.environmentId,
        safety_backup_id: safety?.id ?? null,
        ...(pitr ? { target_time: pitr.targetTime } : {}),
      },
      ip: clientIp(c),
    }),
  ]);
  if (safety) await startBackupWorkflow(c.env, safety.id);
  await startRestoreWorkflow(c.env, id);
  return restore!;
}

/**
 * Starts or stops archiving after a policy's `pitr` changed: on, the live
 * volume gets its stream and a first base backup at once; off, the stream
 * is retired (kept for restores until retention). Either way the volume's
 * node gets a new desired state, which restarts the database once with or
 * without the archive settings.
 */
async function applyPitrChange(
  c: AppContext,
  service: ServiceRow,
  policy: PolicyRow,
  now: number,
): Promise<void> {
  const db = c.get("db");
  const volume = await volumeOf(db, service.id, policy.environmentId);
  const nodeId = volume?.nodeId ?? null;
  if (policy.pitr) {
    if (volume?.nodeId && volume.status === "ready") {
      const { stream, started } = await ensureWalStream(db, volume, now);
      if (started) {
        try {
          await requestBaseBackup(c.env, db, { policy, service, stream, volumeId: volume.id }, now);
        } catch (err) {
          // NOTE: the minute tick asks again for a stream without a base backup.
          console.warn(
            "first base backup failed to start",
            err instanceof Error ? err.name : "error",
          );
        }
      }
    }
  } else {
    await retireWalStreams(db, service.id, policy.environmentId, now);
  }
  if (nodeId) await refreshNodes(c.env, db, [nodeId]);
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
    const dumpOrSnapshot = backupMethodFor(service.databaseEngine);
    if (dumpOrSnapshot === "dump" && body.quiesce === "stop") {
      throw new ApiError(422, "invalid_request", "quiesce: stop applies to snapshots only");
    }
    if (dumpOrSnapshot === "snapshot" && body.databases) {
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
    const pitr = body.pitr ?? current?.pitr ?? false;
    if (pitr && !enabled) {
      throw new ApiError(
        422,
        "invalid_request",
        "Point-in-time recovery needs scheduled backups: its base backups follow the schedule",
      );
    }
    if (pitr && !current?.pitr) {
      const unavailable = await pitrIneligibility(db, service, env.id);
      if (unavailable) throw conflict(unavailable);
    }
    const method = pitr ? "base" : dumpOrSnapshot;
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
      pitr,
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
          pitr,
        },
        ip: clientIp(c),
      }),
    ]);
    if (pitr !== (current?.pitr ?? false)) await applyPitrChange(c, service, saved!, now);
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
    const restore = await startRestore(c, { backup, service, project, caller, body, pitr: null });
    return c.json(toApiRestore(restore), 202);
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
  .openapi(getPitrStatus, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    const { service, project } = await serviceScope(
      c,
      serviceId,
      policyOf(getPitrStatus).action!,
      environment_id,
    );
    const env = await environmentOf(c, project.id, environment_id);
    const db = c.get("db");
    const [policy] = await db
      .select({ pitr: backupPolicies.pitr })
      .from(backupPolicies)
      .where(and(eq(backupPolicies.serviceId, serviceId), eq(backupPolicies.environmentId, env.id)))
      .limit(1);
    const stream = await activeWalStream(db, serviceId, env.id);
    const [bases] = await db
      .select({ n: sql<number>`count(*)` })
      .from(backups)
      .where(
        and(
          eq(backups.serviceId, serviceId),
          eq(backups.environmentId, env.id),
          eq(backups.method, "base"),
          eq(backups.status, "succeeded"),
        ),
      );
    return c.json(
      {
        service_id: serviceId,
        environment_id: env.id,
        enabled: policy?.pitr ?? false,
        unavailable_reason: await pitrIneligibility(db, service, env.id),
        stream: stream
          ? {
              id: stream.id,
              status: stream.status,
              segment_count: stream.segmentCount,
              bytes_stored: stream.bytesStored,
              first_archived_at: ms(stream.firstArchivedAt),
              last_archived_at: ms(stream.lastArchivedAt),
              created_at: +stream.createdAt,
            }
          : null,
        windows: await pitrWindows(db, serviceId, env.id),
        base_backups: Number(bases?.n ?? 0),
      },
      200,
    );
  })
  .openapi(restorePitr, async (c) => {
    const { serviceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { service, project, caller } = await serviceScope(
      c,
      serviceId,
      policyOf(restorePitr).action!,
      body.environment_id,
    );
    const env = await environmentOf(c, project.id, body.environment_id);
    await requireFreshSession(c);
    if (body.confirm !== service.slug) {
      throw new ApiError(400, "invalid_request", "confirm must equal the service's slug");
    }
    if (body.target_time > Date.now()) {
      throw new ApiError(400, "invalid_request", "target_time is in the future");
    }
    const db = c.get("db");
    const plan = await planPitrRestore(db, serviceId, env.id, body.target_time);
    if (!plan) {
      const windows = await pitrWindows(db, serviceId, env.id);
      throw new ApiError(
        422,
        "pitr_target_unavailable",
        windows.length
          ? `No base backup and archived WAL cover that time; restorable: ${windows
              .map((w) => `${new Date(w.from).toISOString()} to ${new Date(w.to).toISOString()}`)
              .join(", ")}`
          : "Nothing is restorable to a point in time yet: point-in-time recovery needs a base backup and WAL archived after it",
      );
    }
    const restore = await startRestore(c, {
      backup: plan.backup,
      service,
      project,
      caller,
      body,
      pitr: { targetTime: body.target_time, walFiles: plan.walFiles, walEnd: plan.walEnd },
    });
    return c.json(toApiRestore(restore), 202);
  })
  .openapi(getRecoveryPolicy, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    const { project } = await serviceScope(
      c,
      serviceId,
      policyOf(getRecoveryPolicy).action!,
      environment_id,
    );
    const env = await environmentOf(c, project.id, environment_id);
    const [policy] = await c
      .get("db")
      .select()
      .from(recoveryPolicies)
      .where(
        and(eq(recoveryPolicies.serviceId, serviceId), eq(recoveryPolicies.environmentId, env.id)),
      )
      .limit(1);
    return c.json(
      toApiRecoveryPolicy(policy, serviceId, env.id, DEFAULT_RECOVERY_GRACE_MINUTES),
      200,
    );
  })
  .openapi(putRecoveryPolicy, async (c) => {
    const { serviceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { project, caller } = await serviceScope(
      c,
      serviceId,
      policyOf(putRecoveryPolicy).action!,
      body.environment_id,
    );
    const env = await environmentOf(c, project.id, body.environment_id);
    await requireFreshSession(c);
    // SECURITY: a policy recovers with its enabler's access, so turning it
    // on needs everything a manual recovery does.
    for (const action of ["services:manage", "deployments:create"] as const) {
      if (!caller.allows(action)) {
        throw new ApiError(
          403,
          "forbidden",
          `Automatic recovery replaces the volume and redeploys: it needs ${action}`,
        );
      }
    }
    const db = c.get("db");
    if (!(await volumeOf(db, serviceId, env.id))) {
      throw conflict("The service has no volume in this environment to recover");
    }
    const [current] = await db
      .select()
      .from(recoveryPolicies)
      .where(
        and(eq(recoveryPolicies.serviceId, serviceId), eq(recoveryPolicies.environmentId, env.id)),
      )
      .limit(1);
    const enabled = body.enabled ?? current?.enabled ?? false;
    if (enabled && !(await isBackupStorageConfigured(db))) throw storageNotConfigured();
    const now = new Date();
    const turnedOn = enabled && !current?.enabled;
    const values = {
      enabled,
      graceMinutes: body.grace_minutes ?? current?.graceMinutes ?? DEFAULT_RECOVERY_GRACE_MINUTES,
      // The person who last saves it enabled is whose access it runs with.
      enabledBy: enabled ? caller.user.id : (current?.enabledBy ?? null),
      ...(turnedOn || !enabled ? { status: "idle" as const, message: null, lostNodeId: null } : {}),
      updatedAt: now,
    };
    const [[saved]] = await db.batch([
      db
        .insert(recoveryPolicies)
        .values({
          id: newId("recoveryPolicy"),
          projectId: project.id,
          serviceId,
          environmentId: env.id,
          createdAt: now,
          ...values,
        })
        .onConflictDoUpdate({
          target: [recoveryPolicies.serviceId, recoveryPolicies.environmentId],
          set: values,
        })
        .returning(),
      auditInsert(db, {
        workspaceId: project.workspaceId,
        ...caller.actor,
        action: "recovery.policy_updated",
        targetType: "service",
        targetId: serviceId,
        metadata: {
          project_id: project.id,
          environment_id: env.id,
          enabled,
          grace_minutes: values.graceMinutes,
        },
        ip: clientIp(c),
      }),
    ]);
    return c.json(
      toApiRecoveryPolicy(saved, serviceId, env.id, DEFAULT_RECOVERY_GRACE_MINUTES),
      200,
    );
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
