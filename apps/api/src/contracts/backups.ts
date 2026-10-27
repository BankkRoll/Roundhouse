/**
 * Backup, restore and backup storage routes (ADR 0004, "Routes, RBAC,
 * audit"): a service's backup policy, its backups (list, take now, delete,
 * download, decryption key), restores, and the instance's backup bucket.
 *
 * Every route but the storage settings answers 409
 * `backup_storage_not_configured` when no bucket is set where it needs one.
 *
 * Deviations from the ADR's table:
 * - The decryption key needs `backups:restore` (the ADR names
 *   `variables:reveal`, which ADR 0014 removed) and a fresh session; it
 *   hands out a key that decrypts every backup of the project.
 * - `new_service` restores need `services:manage`, `variables:manage` and
 *   `deployments:create` in the target environment too (they add and
 *   deploy a database through a change set), and only database backups can
 *   be restored that way: 422 `restore_mode_unsupported` for a snapshot of
 *   any other service.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import {
  BACKUP_METHOD_NAMES,
  BACKUP_STATUSES,
  BACKUP_TRIGGERS,
  isValidCron,
  RESTORE_MODES,
  RESTORE_STATUSES,
} from "@roundhouse/shared";
import {
  body,
  CursorField,
  errors,
  json,
  LimitField,
  Millis,
  ServiceSlugField,
  sessionAuth,
  sessionOnlyAuth,
} from "../schemas";
import { EnvironmentQuery, ServiceParams } from "./params";
import { defineRoute, session, sessionOnly } from "./policy";

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

/** `{backupId}` path param. */
export const BackupIdParams = z.object({ backupId: z.string() });

/** `{restoreId}` path param. */
export const RestoreIdParams = z.object({ restoreId: z.string() });

/** A backup. Never carries the object's upload ID or any URL. */
export const BackupSchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
    service_id: z.string(),
    environment_id: z.string(),
    volume_id: z.string().nullable(),
    policy_id: z.string().nullable(),
    trigger: z.enum(BACKUP_TRIGGERS),
    method: z.enum(BACKUP_METHOD_NAMES),
    engine: z.string().nullable(),
    engine_version: z.string().nullable(),
    status: z.enum(BACKUP_STATUSES),
    node_id: z.string().nullable(),
    /** Exempt from `keep_last`; manual backups are pinned. */
    pinned: z.boolean(),
    part_count: z.number().int().nullable(),
    /** Source bytes before compression and encryption. */
    bytes_raw: z.number().int().nullable(),
    /** Bytes stored (compressed and encrypted). */
    bytes_stored: z.number().int().nullable(),
    /** SHA-256 of the stored object, hex. */
    sha256: z.string().nullable(),
    error: z.string().nullable(),
    requested_by: z.string().nullable(),
    scheduled_for: Millis.nullable(),
    started_at: Millis.nullable(),
    finished_at: Millis.nullable(),
    created_at: Millis,
  })
  .openapi("Backup");

/** A page of backups, newest first. */
export const BackupPageSchema = z
  .object({ backups: z.array(BackupSchema), next_cursor: z.string().nullable() })
  .openapi("BackupPage");

/** A five-field UTC cron expression. */
const ScheduleField = z
  .string()
  .trim()
  .max(120)
  .refine(isValidCron, { message: "expected a five-field cron expression" })
  .openapi({ example: "0 3 * * *" });

/** A database name to dump. */
const DatabaseNameField = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_$-]{0,63}$/);

/** A service's backup policy in one environment; defaults when none is stored. */
export const BackupPolicySchema = z
  .object({
    /** `null` until a policy is saved. */
    id: z.string().nullable(),
    service_id: z.string(),
    environment_id: z.string(),
    enabled: z.boolean(),
    method: z.enum(BACKUP_METHOD_NAMES),
    schedule: z.string(),
    /** Always `UTC`; schedules are evaluated in UTC. */
    timezone: z.string(),
    keep_last: z.number().int(),
    max_age_days: z.number().int().nullable(),
    quiesce: z.enum(["none", "stop"]),
    databases: z.array(z.string()).nullable(),
    next_run_at: Millis.nullable(),
    /** The next few slots, for a schedule preview. */
    next_runs: z.array(Millis),
  })
  .openapi("BackupPolicy");

/** Body of `PUT /v1/services/{serviceId}/backup-policy`; omitted fields keep their value. */
export const PutBackupPolicyBody = z
  .object({
    environment_id: z.string(),
    enabled: z.boolean().optional(),
    schedule: ScheduleField.optional(),
    keep_last: z.number().int().min(1).max(365).optional(),
    max_age_days: z.number().int().min(1).max(3650).nullable().optional(),
    /** `stop` only for snapshots (a service without a database engine). */
    quiesce: z.enum(["none", "stop"]).optional(),
    /** Databases to dump (database services only); `null` dumps all. */
    databases: z.array(DatabaseNameField).min(1).max(64).nullable().optional(),
  })
  .openapi("PutBackupPolicy");

/** Body of `POST /v1/services/{serviceId}/backups`. */
export const CreateBackupBody = z.object({ environment_id: z.string() }).openapi("CreateBackup");

/** A presigned download of the encrypted object. */
export const BackupDownloadSchema = z
  .object({
    /** Presigned `GET`, valid for 15 minutes. The object is age-encrypted. */
    url: z.string(),
    expires_at: Millis,
    /** File name to save it under. */
    filename: z.string(),
    sha256: z.string().nullable(),
  })
  .openapi("BackupDownload");

/** The project's age identity, which decrypts every backup of the project. */
export const BackupDecryptionKeySchema = z
  .object({
    /** `AGE-SECRET-KEY-1…` */
    identity: z.string(),
    /** `age1…` the backups are encrypted to. */
    recipient: z.string(),
  })
  .openapi("BackupDecryptionKey");

/** Body of `POST /v1/backups/{backupId}/restore`. */
export const RestoreBackupBody = z
  .object({
    mode: z.enum(RESTORE_MODES),
    /** `new_service` only; the backup's environment by default. */
    target_environment_id: z.string().optional(),
    /**
     * `new_service` only: the new service's slug; `<slug>-restore-<yyyymmdd>`
     * (with a numeric suffix when taken) by default.
     */
    slug: ServiceSlugField.optional(),
    /** Must equal the backed-up service's slug. */
    confirm: z.string().min(1).max(100),
    /** `in_place` only: skip the `pre_restore` safety backup. */
    skip_safety_backup: z.boolean().optional(),
  })
  .openapi("RestoreBackup");

/** A restore. */
export const RestoreSchema = z
  .object({
    id: z.string(),
    backup_id: z.string(),
    mode: z.enum(RESTORE_MODES),
    target_service_id: z.string().nullable(),
    target_environment_id: z.string().nullable(),
    safety_backup_id: z.string().nullable(),
    status: z.enum(RESTORE_STATUSES),
    error: z.string().nullable(),
    requested_by: z.string().nullable(),
    started_at: Millis.nullable(),
    finished_at: Millis.nullable(),
    created_at: Millis,
  })
  .openapi("Restore");

/** The instance's backup bucket; the secret access key is never returned. */
export const BackupStorageSchema = z
  .object({
    configured: z.boolean(),
    endpoint: z.string().nullable(),
    bucket: z.string().nullable(),
    region: z.string().nullable(),
    access_key_id: z.string().nullable(),
    secret_access_key_set: z.boolean(),
  })
  .openapi("BackupStorage");

/** Body of `PUT /v1/instance/backup-storage`. */
export const PutBackupStorageBody = z
  .object({
    /** S3 API origin, e.g. `https://<account>.r2.cloudflarestorage.com`. */
    endpoint: z.string().min(1).max(300),
    bucket: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "expected an S3 bucket name")
      .openapi({ example: "roundhouse-backups" }),
    /** `auto` for R2 (the default). */
    region: z
      .string()
      .regex(/^[a-z0-9-]{1,32}$/)
      .optional(),
    access_key_id: z.string().min(1).max(128),
    /** Write-only. Omit to keep the stored one. */
    secret_access_key: z.string().min(1).max(256).optional(),
  })
  .openapi("PutBackupStorage");

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

/** The service's backup policy in an environment, or the defaults when none is saved. */
export const getBackupPolicy = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/services/{serviceId}/backup-policy",
  tags: ["backups"],
  summary: "Get a backup policy",
  security: sessionAuth,
  request: { params: ServiceParams, query: EnvironmentQuery },
  responses: { 200: json(BackupPolicySchema), ...errors(400, 401, 403, 404) },
});

/**
 * Creates or updates the policy. 409 when the service has no volume in the
 * environment; 422 for `quiesce: stop` on a database or `databases` on a
 * non-database service.
 */
export const putBackupPolicy = defineRoute(session("backups:manage", ["backup.policy_updated"]), {
  method: "put",
  path: "/v1/services/{serviceId}/backup-policy",
  tags: ["backups"],
  summary: "Set a backup policy",
  security: sessionAuth,
  request: { params: ServiceParams, ...body(PutBackupPolicyBody) },
  responses: { 200: json(BackupPolicySchema), ...errors(400, 401, 403, 404, 409, 422) },
});

/** The service's backups in an environment, newest first (deleted ones excluded). */
export const listBackups = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/services/{serviceId}/backups",
  tags: ["backups"],
  summary: "List backups",
  security: sessionAuth,
  request: {
    params: ServiceParams,
    query: EnvironmentQuery.extend({ cursor: CursorField, limit: LimitField }),
  },
  responses: { 200: json(BackupPageSchema), ...errors(400, 401, 403, 404) },
});

/**
 * Takes a manual (pinned) backup now. 409 without backup storage or a
 * volume; the backup itself fails later if the node is offline.
 */
export const createBackup = defineRoute(session("backups:manage", ["backup.requested"]), {
  method: "post",
  path: "/v1/services/{serviceId}/backups",
  tags: ["backups"],
  summary: "Back up now",
  security: sessionAuth,
  request: { params: ServiceParams, ...body(CreateBackupBody) },
  responses: { 202: json(BackupSchema, "Queued"), ...errors(400, 401, 403, 404, 409) },
});

/** One backup. */
export const getBackup = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/backups/{backupId}",
  tags: ["backups"],
  summary: "Get a backup",
  security: sessionAuth,
  request: { params: BackupIdParams },
  responses: { 200: json(BackupSchema), ...errors(401, 403, 404) },
});

/**
 * Deletes a finished backup: its object, then the record (kept as
 * `deleted`). 409 while it runs or while a restore reads it.
 */
export const removeBackup = defineRoute(session("backups:manage", ["backup.deleted"]), {
  method: "delete",
  path: "/v1/backups/{backupId}",
  tags: ["backups"],
  summary: "Delete a backup",
  security: sessionAuth,
  request: { params: BackupIdParams },
  responses: { 204: { description: "Deleted" }, ...errors(401, 403, 404, 409) },
});

/** A 15-minute presigned download of the encrypted object. Audited. */
export const downloadBackup = defineRoute(session("backups:restore", ["backup.downloaded"]), {
  method: "get",
  path: "/v1/backups/{backupId}/download",
  tags: ["backups"],
  summary: "Download a backup",
  security: sessionAuth,
  request: { params: BackupIdParams },
  responses: { 200: json(BackupDownloadSchema), ...errors(401, 403, 404, 409) },
});

/**
 * The project's age identity, which decrypts this and every other backup of
 * the project. Needs a fresh session; audited.
 */
export const getBackupDecryptionKey = defineRoute(
  session("backups:restore", ["backup.key_revealed"], { reauth: true }),
  {
    method: "post",
    path: "/v1/backups/{backupId}/decryption-key",
    tags: ["backups"],
    summary: "Get a backup's decryption key",
    security: sessionAuth,
    request: { params: BackupIdParams },
    responses: { 200: json(BackupDecryptionKeySchema), ...errors(401, 403, 404, 409) },
  },
);

/**
 * Restores a succeeded backup. `confirm` must equal the service's slug.
 * `in_place` first takes a safety backup unless `skip_safety_backup`.
 * `new_service` adds a database of the same engine and version with fresh
 * credentials, waits for it to be healthy, and restores into it; the
 * original is not touched. Needs a fresh session; `new_service` also needs
 * `services:manage`, `variables:manage` and `deployments:create`.
 */
export const restoreBackup = defineRoute(
  session("backups:restore", ["restore.started"], { reauth: true }),
  {
    method: "post",
    path: "/v1/backups/{backupId}/restore",
    tags: ["backups"],
    summary: "Restore a backup",
    security: sessionAuth,
    request: { params: BackupIdParams, ...body(RestoreBackupBody) },
    responses: {
      202: json(RestoreSchema, "Started"),
      ...errors(400, 401, 403, 404, 409, 422),
    },
  },
);

/** One restore. */
export const getRestore = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/restores/{restoreId}",
  tags: ["backups"],
  summary: "Get a restore",
  security: sessionAuth,
  request: { params: RestoreIdParams },
  responses: { 200: json(RestoreSchema), ...errors(401, 403, 404) },
});

/** The instance's backup bucket, without its secret. */
export const getBackupStorage = defineRoute(sessionOnly("instance:manage"), {
  method: "get",
  path: "/v1/instance/backup-storage",
  tags: ["instance"],
  summary: "Get backup storage",
  security: sessionOnlyAuth,
  responses: { 200: json(BackupStorageSchema), ...errors(401, 403) },
});

/**
 * Sets the backup bucket after checking the credentials reach it (a
 * `HeadObject` that must answer 200 or 404). 422
 * `backup_storage_unreachable` otherwise. Audited without any value.
 */
export const putBackupStorage = defineRoute(
  sessionOnly("instance:manage", ["instance.settings_updated"], { reauth: true }),
  {
    method: "put",
    path: "/v1/instance/backup-storage",
    tags: ["instance"],
    summary: "Set backup storage",
    security: sessionOnlyAuth,
    request: body(PutBackupStorageBody),
    responses: { 200: json(BackupStorageSchema), ...errors(400, 401, 403, 422) },
  },
);

/** Every backup route, by name. */
export const BACKUP_ROUTES = {
  getBackupPolicy,
  putBackupPolicy,
  listBackups,
  createBackup,
  getBackup,
  removeBackup,
  downloadBackup,
  getBackupDecryptionKey,
  restoreBackup,
  getRestore,
  getBackupStorage,
  putBackupStorage,
} as const;

/** A backup. */
export type Backup = z.infer<typeof BackupSchema>;
/** A backup policy. */
export type BackupPolicy = z.infer<typeof BackupPolicySchema>;
/** A restore. */
export type Restore = z.infer<typeof RestoreSchema>;
/** Backup storage settings. */
export type BackupStorage = z.infer<typeof BackupStorageSchema>;
