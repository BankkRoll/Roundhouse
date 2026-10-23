/**
 * Volumes, backups and restores (ADR 0004): their lifecycles and the pure
 * decisions the API makes about them, so the dashboard and tests share one
 * definition.
 *
 * - {@link backupPartSize}: the multipart part size for an estimated size.
 * - {@link selectExpiredBackups}: what retention deletes.
 * - {@link backupObjectKey}: where a backup lives in the bucket.
 *
 * @module
 */

/** A volume's lifecycle in the control plane. */
export const VOLUME_STATUSES = [
  "pending",
  "ready",
  "migrating",
  "degraded",
  "pending_deletion",
  "deleted",
  "abandoned",
  "error",
] as const;

/** A volume's status; see {@link VOLUME_STATUSES}. */
export type VolumeStatusName = (typeof VOLUME_STATUSES)[number];

/** Statuses of a volume that still holds data and belongs on its node. */
export const LIVE_VOLUME_STATUSES: readonly VolumeStatusName[] = [
  "pending",
  "ready",
  "migrating",
  "degraded",
  "error",
];

/** How long a deleted volume can be undeleted before its data is removed. */
export const VOLUME_DELETE_GRACE_MS = 72 * 60 * 60 * 1000;

/**
 * Where a running volume migration is (ADR 0004, "Volume migration between
 * nodes"), in order: the target creates the volume, the service stops, the
 * source copies out, the target copies in, the service starts on the target.
 * `rolling_back` puts the service back on the source after a failure.
 */
export const VOLUME_MIGRATION_PHASES = [
  "queued",
  "preparing_target",
  "stopping",
  "copying_out",
  "copying_in",
  "starting",
  "done",
  "rolling_back",
] as const;

/** A migration phase; see {@link VOLUME_MIGRATION_PHASES}. */
export type VolumeMigrationPhase = (typeof VOLUME_MIGRATION_PHASES)[number];

/** How long a migration's leftover copy (and its snapshot backup) is kept. */
export const VOLUME_MIGRATION_KEEP_MS = VOLUME_DELETE_GRACE_MS;

/** Host ports the TCP proxy allocates from (ADR 0004, `tcp_proxy_port_range`). */
export const TCP_PROXY_PORT_RANGE = { min: 20_000, max: 29_999 } as const;

/** Most source CIDRs one TCP proxy admits; the protocol's `MAX_PUBLISH_CIDRS`. */
export const MAX_TCP_PROXY_CIDRS = 64;

/** A credential rotation's lifecycle. */
export const CREDENTIAL_ROTATION_STATUSES = ["running", "succeeded", "failed"] as const;

/** A rotation's status; see {@link CREDENTIAL_ROTATION_STATUSES}. */
export type CredentialRotationStatus = (typeof CREDENTIAL_ROTATION_STATUSES)[number];

/** What started a backup. */
export const BACKUP_TRIGGERS = ["schedule", "manual", "pre_restore", "migration"] as const;

/** A backup trigger; see {@link BACKUP_TRIGGERS}. */
export type BackupTrigger = (typeof BACKUP_TRIGGERS)[number];

/** A backup's lifecycle. */
export const BACKUP_STATUSES = ["queued", "running", "succeeded", "failed", "deleted"] as const;

/** A backup's status; see {@link BACKUP_STATUSES}. */
export type BackupStatusName = (typeof BACKUP_STATUSES)[number];

/** `dump` runs the engine's tool; `snapshot` archives the volume's files. */
export const BACKUP_METHOD_NAMES = ["dump", "snapshot"] as const;

/** A backup method; see {@link BACKUP_METHOD_NAMES}. */
export type BackupMethodName = (typeof BACKUP_METHOD_NAMES)[number];

/** Where a restore writes. */
export const RESTORE_MODES = ["in_place", "new_service"] as const;

/** A restore mode; see {@link RESTORE_MODES}. */
export type RestoreMode = (typeof RESTORE_MODES)[number];

/** A restore's lifecycle. */
export const RESTORE_STATUSES = ["queued", "running", "succeeded", "failed"] as const;

/** A restore's status; see {@link RESTORE_STATUSES}. */
export type RestoreStatusName = (typeof RESTORE_STATUSES)[number];

/** Schedule a new backup policy starts with: daily at 03:00 UTC. */
export const DEFAULT_BACKUP_SCHEDULE = "0 3 * * *";

/** Scheduled backups a new policy keeps. */
export const DEFAULT_BACKUP_KEEP_LAST = 7;

const MIB = 1024 * 1024;

/** Smallest part the API asks for: well above R2's 5 MiB minimum. */
export const MIN_PART_SIZE_BYTES = 16 * MIB;

/** Parts R2 allows in one multipart upload. */
export const MAX_UPLOAD_PARTS = 10_000;

/** Largest part R2 allows. */
export const MAX_PART_SIZE_BYTES = 5 * 1024 * MIB;

/**
 * The part size for a backup (ADR 0004, "Parts"): the larger of 16 MiB and
 * 1.5× the estimate spread over 9,000 parts, rounded up to a whole MiB, so
 * a stream half again as big as expected still fits in R2's 10,000 parts.
 *
 * @param estimatedBytes - Expected stored size, e.g. the volume's `used_bytes`.
 * @returns Bytes per part; every part but the last has exactly this size.
 * @example
 * backupPartSize(0); // 16 MiB
 */
export function backupPartSize(estimatedBytes: number): number {
  const wanted = Math.ceil((Math.max(0, estimatedBytes) * 1.5) / 9000);
  const aligned = Math.ceil(wanted / MIB) * MIB;
  return Math.min(MAX_PART_SIZE_BYTES, Math.max(MIN_PART_SIZE_BYTES, aligned));
}

/**
 * The object key of a backup. Every presigned URL the agent gets names
 * exactly this key, so one leaked URL reaches one object.
 *
 * @param b - The backup's project, service, environment and ID.
 * @returns E.g. `backups/prj_1/svc_1/env_1/bak_1.rhbk.zst.age`.
 */
export function backupObjectKey(b: {
  projectId: string;
  serviceId: string;
  environmentId: string;
  id: string;
}): string {
  return `backups/${b.projectId}/${b.serviceId}/${b.environmentId}/${b.id}.rhbk.zst.age`;
}

/** A backup as retention sees it. */
export interface RetainedBackup {
  id: string;
  trigger: BackupTrigger;
  status: BackupStatusName;
  pinned: boolean;
  /** Unix milliseconds. */
  createdAt: number;
}

/**
 * Backups retention deletes (ADR 0004, "Retention"): succeeded scheduled
 * backups beyond the newest `keepLast`, and any finished backup older than
 * `maxAgeDays`, except pinned ones, which only an explicit delete removes.
 * The newest `keepLast` succeeded scheduled backups always survive, so a
 * policy can never delete its last good backup by age alone.
 *
 * @param backups - The service's backups in one environment.
 * @param policy - `keepLast` (1..365) and `maxAgeDays` (`null` for none).
 * @param now - Unix milliseconds.
 * @returns IDs to delete.
 */
export function selectExpiredBackups(
  backups: readonly RetainedBackup[],
  policy: { keepLast: number; maxAgeDays: number | null },
  now: number,
): string[] {
  const scheduled = backups
    .filter((b) => b.trigger === "schedule" && b.status === "succeeded" && !b.pinned)
    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
  const kept = new Set(scheduled.slice(0, policy.keepLast).map((b) => b.id));
  const out = new Set(scheduled.slice(policy.keepLast).map((b) => b.id));
  if (policy.maxAgeDays !== null) {
    const cutoff = now - policy.maxAgeDays * 86_400_000;
    for (const b of backups) {
      if (b.pinned || kept.has(b.id)) continue;
      if (b.status !== "succeeded" && b.status !== "failed") continue;
      if (b.createdAt < cutoff) out.add(b.id);
    }
  }
  return [...out];
}
