/**
 * Data services (ADR 0004): volumes, backup policies, backups and their
 * uploaded parts, restores, moves of a volume between nodes, WAL archives
 * for point-in-time recovery, and automatic recovery policies.
 *
 * Nothing here holds a credential: backup objects are encrypted to the
 * project's age recipient (its identity is sealed in `project_keys`), and
 * database passwords live only in secret variables.
 *
 * @module
 */
import type { VolumeQuotaMode, VolumeState } from "@roundhouse/protocol";
import type {
  BackupMethodName,
  BackupStatusName,
  BackupTrigger,
  CredentialRotationStatus,
  DatabasePrincipal,
  RecoveryPolicyStatus,
  RestoreMode,
  RestoreStatusName,
  RestoreTrigger,
  ServiceDatabaseEngine,
  VolumeMigrationPhase,
  VolumeStatusName,
  WalStreamStatus,
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
import { changeSets } from "./changes";
import { id, json, timestamp, timestamps } from "./columns";
import { deployments } from "./deployments";
import { nodes } from "./nodes";
import { environments, projects, type SealedValue, services } from "./projects";

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
    /**
     * When a recovery replaced this volume with one on another node. The
     * copy left on its old node is deleted once that node is back and
     * `delete_after` has passed.
     */
    abandonedAt: timestamp("abandoned_at"),
    /** When the old node of an `abandoned` volume reported its copy deleted. */
    cleanedAt: timestamp("cleaned_at"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("volumes_service_env_live_uq")
      .on(t.serviceId, t.environmentId)
      .where(sql`status NOT IN ('deleted', 'abandoned')`),
    index("volumes_node_idx").on(t.nodeId, t.status),
    index("volumes_delete_after_idx").on(t.status, t.deleteAfter),
    index("volumes_abandoned_idx").on(t.status, t.cleanedAt, t.deleteAfter),
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
    /**
     * Point-in-time recovery (Postgres): WAL is archived continuously and
     * scheduled backups are `base` backups.
     */
    pitr: integer("pitr", { mode: "boolean" }).notNull().default(false),
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
    /** A `base` backup's WAL stream, whose files replay onto it. */
    walStreamId: text("wal_stream_id").references((): AnySQLiteColumn => walStreams.id, {
      onDelete: "set null",
    }),
    /** A `base` backup's first WAL segment, from its `backup_label`. */
    walStart: text("wal_start"),
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
    /**
     * Set when an `in_place` restore recovers a volume whose node was lost
     * (ADR 0004 `target_node_id`): the node the new volume was created on.
     */
    targetNodeId: text("target_node_id").references(() => nodes.id, { onDelete: "set null" }),
    /** `automatic` when a recovery policy started it. */
    trigger: text("trigger").$type<RestoreTrigger>().notNull().default("manual"),
    /** The volume a recovery replaced; its old node's copy is deleted after it succeeds. */
    abandonedVolumeId: text("abandoned_volume_id").references((): AnySQLiteColumn => volumes.id, {
      onDelete: "set null",
    }),
    /** A point-in-time restore's target, unix ms; `NULL` restores the backup as taken. */
    targetTime: timestamp("target_time"),
    /** The last WAL segment a point-in-time restore replays. */
    walEnd: text("wal_end"),
    /** How many WAL files a point-in-time restore fetches. */
    walFiles: integer("wal_files"),
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

/**
 * One move of a volume to another node through object storage. The volume
 * keeps its ID on both nodes: the target holds it from the start of the
 * copy, the source until its copy is deleted after the grace period.
 */
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
    /** Unused: the volume keeps its ID on the target node. */
    targetVolumeId: text("target_volume_id").references((): AnySQLiteColumn => volumes.id, {
      onDelete: "set null",
    }),
    status: text("status").$type<RestoreStatusName>().notNull().default("queued"),
    /** Where a running migration is; see `VOLUME_MIGRATION_PHASES`. */
    phase: text("phase").$type<VolumeMigrationPhase>().notNull().default("queued"),
    /** The volume's status before the move, restored on rollback. */
    priorStatus: text("prior_status").$type<VolumeStatusName>(),
    /** The target node's last report of the volume while the copy runs. */
    targetState: text("target_state").$type<VolumeState>(),
    copiedBytes: integer("copied_bytes"),
    /** When the target answered `volume_copy_in`; with `copy_error` on failure. */
    copyFinishedAt: timestamp("copy_finished_at"),
    copyError: text("copy_error"),
    /** The redeploy on the target node. */
    deploymentId: text("deployment_id").references(() => deployments.id, {
      onDelete: "set null",
    }),
    /**
     * The node left holding a copy nobody uses: the source after a move, the
     * target after a rollback. `volume_delete` goes to it after `cleanup_after`.
     */
    cleanupNodeId: text("cleanup_node_id").references(() => nodes.id, { onDelete: "set null" }),
    cleanupAfter: timestamp("cleanup_after"),
    cleanupSentAt: timestamp("cleanup_sent_at"),
    /** When that node reported the copy deleted. */
    cleanedAt: timestamp("cleaned_at"),
    error: text("error"),
    requestedBy: text("requested_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    ...timestamps,
  },
  (t) => [
    index("volume_migrations_volume_idx").on(t.volumeId),
    uniqueIndex("volume_migrations_active_uq")
      .on(t.volumeId)
      .where(sql`status IN ('queued', 'running')`),
    index("volume_migrations_target_idx").on(t.targetNodeId, t.status),
    index("volume_migrations_cleanup_idx").on(t.cleanedAt, t.cleanupAfter),
  ],
);

/**
 * A database's continuous WAL archive (ADR 0004, "Point-in-time recovery"),
 * from one volume's history. A restore that replaces the data, a new volume
 * or turning point-in-time recovery off retires it, and the next one starts
 * with a fresh base backup, so WAL file names never collide within one.
 */
export const walStreams = sqliteTable(
  "wal_streams",
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
    /** The volume whose database writes this WAL. */
    volumeId: text("volume_id").references(() => volumes.id, { onDelete: "set null" }),
    status: text("status").$type<WalStreamStatus>().notNull().default("active"),
    segmentCount: integer("segment_count").notNull().default(0),
    bytesStored: integer("bytes_stored").notNull().default(0),
    firstArchivedAt: timestamp("first_archived_at"),
    lastArchivedAt: timestamp("last_archived_at"),
    /** The newest file recorded. */
    lastFile: text("last_file"),
    retiredAt: timestamp("retired_at"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("wal_streams_active_uq")
      .on(t.serviceId, t.environmentId)
      .where(sql`status = 'active'`),
    index("wal_streams_volume_idx").on(t.volumeId, t.status),
    index("wal_streams_svc_env_idx").on(t.serviceId, t.environmentId, t.id),
  ],
);

/** One archived WAL file of a stream, stored at `walObjectKey`. */
export const walSegments = sqliteTable(
  "wal_segments",
  {
    streamId: text("stream_id")
      .notNull()
      .references(() => walStreams.id, { onDelete: "cascade" }),
    /** A segment, `.partial`, `.backup` or `.history` file name. */
    name: text("name").notNull(),
    sizeRaw: integer("size_raw").notNull(),
    sizeStored: integer("size_stored").notNull(),
    /** SHA-256 of the stored (compressed, encrypted) bytes, hex. */
    sha256: text("sha256").notNull(),
    /** When Postgres finished the file: every WAL record before it is in this file or an earlier one. */
    archivedAt: timestamp("archived_at").notNull(),
    createdAt: timestamp("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.streamId, t.name] }),
    index("wal_segments_archived_idx").on(t.streamId, t.archivedAt),
  ],
);

/**
 * A service's automatic recovery in one environment (ADR 0004): when the
 * node holding its volume stays offline for `grace_minutes`, the latest
 * backup is restored onto a healthy node, acting with the access of the
 * person who turned it on.
 */
export const recoveryPolicies = sqliteTable(
  "recovery_policies",
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
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    graceMinutes: integer("grace_minutes").notNull().default(30),
    /** Whose access a recovery runs with; re-checked every time. */
    enabledBy: text("enabled_by").references(() => users.id, { onDelete: "set null" }),
    status: text("status").$type<RecoveryPolicyStatus>().notNull().default("idle"),
    /** Why the status is what it is, for the dashboard. */
    message: text("message"),
    /** The offline node being watched or recovered from. */
    lostNodeId: text("lost_node_id").references(() => nodes.id, { onDelete: "set null" }),
    /** The last automatic recovery. */
    restoreId: text("restore_id").references(() => restores.id, { onDelete: "set null" }),
    triggeredAt: timestamp("triggered_at"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("recovery_policies_svc_env_uq").on(t.serviceId, t.environmentId),
    index("recovery_policies_enabled_idx").on(t.enabled),
  ],
);

/**
 * A published TCP port of a single-replica service in one environment (ADR
 * 0004, "TCP proxy"). Public ports are unique across the instance, so a
 * service keeps its port wherever it is placed.
 */
export const tcpProxies = sqliteTable(
  "tcp_proxies",
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
    containerPort: integer("container_port").notNull(),
    publicPort: integer("public_port").notNull(),
    /** Sources the node admits; never empty. */
    allowedCidrs: json<string[]>("allowed_cidrs").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("tcp_proxies_svc_env_uq").on(t.serviceId, t.environmentId),
    uniqueIndex("tcp_proxies_public_port_uq").on(t.publicPort),
  ],
);

/**
 * One rotation of a database's credentials. While it runs, the new
 * passwords are kept sealed under the project DEK (AAD
 * `credential-rotation:<id>`), so a rotation interrupted after the engine
 * accepted them can still be finished; they are cleared when it ends.
 */
export const credentialRotations = sqliteTable(
  "credential_rotations",
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
    status: text("status").$type<CredentialRotationStatus>().notNull().default("running"),
    /** Principals asked for, in the order they are changed. */
    principals: json<DatabasePrincipal[]>("principals").notNull(),
    /** Principals whose password the engine has accepted. */
    applied: json<DatabasePrincipal[]>("applied")
      .notNull()
      .$defaultFn(() => []),
    /** Sealed JSON `{principal: password}`; `NULL` once the rotation ends. */
    secretsSealed: json<SealedValue>("secrets_sealed"),
    /** `affected` redeploys every service using the credentials; `none` leaves them. */
    deploy: text("deploy").$type<"affected" | "none">().notNull(),
    changeSetId: text("change_set_id").references(() => changeSets.id, { onDelete: "set null" }),
    deploymentIds: json<string[]>("deployment_ids"),
    error: text("error"),
    requestedBy: text("requested_by").references(() => users.id, { onDelete: "set null" }),
    finishedAt: timestamp("finished_at"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("credential_rotations_running_uq")
      .on(t.serviceId, t.environmentId)
      .where(sql`status = 'running'`),
    index("credential_rotations_svc_env_idx").on(t.serviceId, t.environmentId, t.id),
  ],
);
