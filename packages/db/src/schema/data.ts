/**
 * Data services (ADR 0004): volumes, backup policies, backups and their
 * uploaded parts, restores, and moves of a volume between nodes.
 *
 * Nothing here holds a credential: backup objects are encrypted to the
 * project's age recipient (its identity is sealed in `project_keys`), and
 * database passwords live only in secret variables.
 *
 * @module
 */
import type { VolumeQuotaMode } from "@roundhouse/protocol";
import type {
  BackupMethodName,
  BackupStatusName,
  BackupTrigger,
  RestoreMode,
  RestoreStatusName,
  ServiceDatabaseEngine,
  VolumeStatusName,
} from "@roundhouse/shared";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { id, json, timestamp, timestamps } from "./columns";
import { nodes } from "./nodes";
import { environments, projects, services } from "./projects";

/** A service's persistent storage in one environment, held by one node. */
export const volumes = sqliteTable(
  "volumes",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    /** Absolute path in the container. */
    mountPath: text("mount_path").notNull(),
    /** Quota in MiB; grow-only. */
    sizeMb: integer("size_mb").notNull(),
    /**
     * The node holding the data. `NULL` until the first deployment places
     * the replica; every later deployment is pinned to it.
     */
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "set null" }),
    status: text("status").$type<VolumeStatusName>().notNull().default("pending"),
    /** How the node enforces the quota, from `volume_status`. */
    quotaMode: text("quota_mode").$type<VolumeQuotaMode>(),
    usedBytes: integer("used_bytes"),
    /** Agent's message for an `error` volume. */
    message: text("message"),
    reportedAt: timestamp("reported_at"),
    /** When the read-only data-browser principal was created in the engine. */
    readonlyProvisionedAt: timestamp("readonly_provisioned_at"),
    /** Set on delete: the data is removed after this, unless undeleted first. */
    deleteAfter: timestamp("delete_after"),
    /** When `volume_delete` was last sent, so the minute tick doesn't resend every minute. */
    deleteSentAt: timestamp("delete_sent_at"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("volumes_service_env_live_uq")
      .on(t.serviceId, t.environmentId)
      .where(sql`status NOT IN ('deleted', 'abandoned')`),
    index("volumes_node_idx").on(t.nodeId, t.status),
    index("volumes_delete_after_idx").on(t.status, t.deleteAfter),
  ],
);

/** A service's backup schedule and retention in one environment. */
export const backupPolicies = sqliteTable(
  "backup_policies",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    method: text("method").$type<BackupMethodName>().notNull(),
    /** Five-field cron, UTC. */
    schedule: text("schedule").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    /** Scheduled backups kept, 1..365. */
    keepLast: integer("keep_last").notNull().default(7),
    /** `NULL` keeps backups regardless of age. */
    maxAgeDays: integer("max_age_days"),
    /** `snapshot` only: `stop` stops the service around the archive. */
    quiesce: text("quiesce").$type<"none" | "stop">().notNull().default("none"),
    /** Databases to dump; `NULL` dumps all. */
    databases: json<string[] | null>("databases"),
    /** Next slot; `NULL` while disabled. The minute tick claims it. */
    nextRunAt: timestamp("next_run_at"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("backup_policies_svc_env_uq").on(t.serviceId, t.environmentId),
    index("backup_policies_next_run_idx").on(t.nextRunAt),
  ],
);

/** One backup of a volume, stored encrypted in object storage. */
export const backups = sqliteTable(
  "backups",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    volumeId: text("volume_id").references(() => volumes.id, { onDelete: "set null" }),
    policyId: text("policy_id").references(() => backupPolicies.id, { onDelete: "set null" }),
    trigger: text("trigger").$type<BackupTrigger>().notNull(),
    /** The schedule slot; unique with `policy_id`, so a slot runs once. */
    scheduledFor: timestamp("scheduled_for"),
    method: text("method").$type<BackupMethodName>().notNull(),
    engine: text("engine").$type<ServiceDatabaseEngine>(),
    engineVersion: text("engine_version"),
    status: text("status").$type<BackupStatusName>().notNull().default("queued"),
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "set null" }),
    objectKey: text("object_key").notNull(),
    uploadId: text("upload_id"),
    partSizeBytes: integer("part_size_bytes"),
    partCount: integer("part_count"),
    bytesRaw: integer("bytes_raw"),
    bytesStored: integer("bytes_stored"),
    /** SHA-256 of the stored (encrypted) object, hex. */
    sha256: text("sha256"),
    /** Exempt from `keep_last`; manual backups are pinned. */
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    error: text("error"),
    requestedBy: text("requested_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("backups_policy_slot_uq")
      .on(t.policyId, t.scheduledFor)
      .where(sql`policy_id IS NOT NULL`),
    index("backups_svc_env_id_idx").on(t.serviceId, t.environmentId, t.id),
    index("backups_status_idx").on(t.status),
  ],
);

/** A part of a backup's multipart upload, for `CompleteMultipartUpload`. */
export const backupParts = sqliteTable(
  "backup_parts",
  {
    backupId: text("backup_id")
      .notNull()
      .references(() => backups.id, { onDelete: "cascade" }),
    partNumber: integer("part_number").notNull(),
    etag: text("etag").notNull(),
    size: integer("size").notNull(),
  },
  (t) => [primaryKey({ columns: [t.backupId, t.partNumber] })],
);

/** One restore of a backup, in place or into a new service. */
export const restores = sqliteTable(
  "restores",
  {
    id: id(),
    backupId: text("backup_id")
      .notNull()
      .references(() => backups.id, { onDelete: "cascade" }),
    mode: text("mode").$type<RestoreMode>().notNull(),
    targetServiceId: text("target_service_id").references(() => services.id, {
      onDelete: "set null",
    }),
    targetEnvironmentId: text("target_environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    // backups and restores reference each other; the annotation breaks the type cycle.
    safetyBackupId: text("safety_backup_id").references((): AnySQLiteColumn => backups.id, {
      onDelete: "set null",
    }),
    /**
     * The node `restore_job` went to; only its `restore_result` is accepted.
     * `NULL` until the job is sent.
     */
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "set null" }),
    status: text("status").$type<RestoreStatusName>().notNull().default("queued"),
    error: text("error"),
    requestedBy: text("requested_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    ...timestamps,
  },
  (t) => [
    index("restores_backup_idx").on(t.backupId),
    index("restores_target_idx").on(t.targetServiceId),
  ],
);

/** One move of a volume to another node through object storage. */
export const volumeMigrations = sqliteTable(
  "volume_migrations",
  {
    id: id(),
    volumeId: text("volume_id")
      .notNull()
      .references(() => volumes.id, { onDelete: "cascade" }),
    sourceNodeId: text("source_node_id").references(() => nodes.id, { onDelete: "set null" }),
    targetNodeId: text("target_node_id").references(() => nodes.id, { onDelete: "set null" }),
    /** The quiesced snapshot that carries the data. */
    backupId: text("backup_id").references(() => backups.id, { onDelete: "set null" }),
    /** The volume created on the target node. */
    targetVolumeId: text("target_volume_id").references((): AnySQLiteColumn => volumes.id, {
      onDelete: "set null",
    }),
    status: text("status").$type<RestoreStatusName>().notNull().default("queued"),
    error: text("error"),
    requestedBy: text("requested_by").references(() => users.id, { onDelete: "set null" }),
    finishedAt: timestamp("finished_at"),
    ...timestamps,
  },
  (t) => [index("volume_migrations_volume_idx").on(t.volumeId)],
);
