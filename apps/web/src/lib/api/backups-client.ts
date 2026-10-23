/**
 * Typed endpoint functions and wire types for backups (ADR 0004): a service's backup
 * policy, its backups, restores, downloads and the instance's backup storage.
 *
 * Types come from the API's route contracts (`apps/api/src/contracts/backups.ts`).
 *
 * @module
 */
import type {
  Backup,
  BackupPolicy,
  BackupStorage,
  BodyOf,
  downloadBackup,
  listBackups,
  putBackupPolicy,
  putBackupStorage,
  ResponseOf,
  Restore,
  restoreBackup,
} from "../../../../api/src/contracts";
import { request } from "./client";

export type { Backup, BackupPolicy, BackupStorage, Restore };

/** `PUT /v1/services/{serviceId}/backup-policy` body. */
export type BackupPolicyPatch = BodyOf<typeof putBackupPolicy>;
/** `PUT /v1/instance/backup-storage` body. */
export type BackupStorageBody = BodyOf<typeof putBackupStorage>;
/** `POST /v1/backups/{backupId}/restore` body. */
export type RestoreBody = BodyOf<typeof restoreBackup>;
/** A page of backups, newest first. */
export type BackupPage = ResponseOf<typeof listBackups, 200>;
/** A presigned download of a backup's encrypted object. */
export type BackupDownload = ResponseOf<typeof downloadBackup, 200>;

const seg = encodeURIComponent;

/** Backup endpoints. */
export const backupsApi = {
  /**
   * Reads a service's backup policy, or the defaults when none is saved.
   *
   * @param serviceId - Service id.
   * @param environmentId - Environment id.
   * @param signal - Abort signal.
   * @returns The policy with its next runs.
   */
  getPolicy: (serviceId: string, environmentId: string, signal?: AbortSignal) =>
    request<BackupPolicy>("GET", `/v1/services/${seg(serviceId)}/backup-policy`, {
      query: { environment_id: environmentId },
      signal,
    }),
  /**
   * Creates or updates a backup policy; omitted fields keep their value.
   *
   * @param serviceId - Service id.
   * @param body - Environment and the fields to change.
   * @returns The saved policy.
   */
  putPolicy: (serviceId: string, body: BackupPolicyPatch) =>
    request<BackupPolicy>("PUT", `/v1/services/${seg(serviceId)}/backup-policy`, { body }),
  /**
   * Lists a service's backups in an environment, newest first.
   *
   * @param serviceId - Service id.
   * @param environmentId - Environment id.
   * @param cursor - Cursor from the previous page.
   * @param signal - Abort signal.
   * @returns A page of backups.
   */
  list: (serviceId: string, environmentId: string, cursor?: string, signal?: AbortSignal) =>
    request<BackupPage>("GET", `/v1/services/${seg(serviceId)}/backups`, {
      query: { environment_id: environmentId, cursor },
      signal,
    }),
  /**
   * Takes a manual (pinned) backup now.
   *
   * @param serviceId - Service id.
   * @param environmentId - Environment id.
   * @returns The queued backup.
   */
  create: (serviceId: string, environmentId: string) =>
    request<Backup>("POST", `/v1/services/${seg(serviceId)}/backups`, {
      body: { environment_id: environmentId },
    }),
  /**
   * Reads one backup.
   *
   * @param backupId - Backup id.
   * @param signal - Abort signal.
   * @returns The backup.
   */
  get: (backupId: string, signal?: AbortSignal) =>
    request<Backup>("GET", `/v1/backups/${seg(backupId)}`, { signal }),
  /**
   * Deletes a finished backup.
   *
   * @param backupId - Backup id.
   */
  remove: (backupId: string) => request<void>("DELETE", `/v1/backups/${seg(backupId)}`),
  /**
   * Gets a 15-minute presigned download of the encrypted object.
   *
   * @param backupId - Backup id.
   * @returns URL, expiry, file name and checksum.
   */
  download: (backupId: string) =>
    request<BackupDownload>("GET", `/v1/backups/${seg(backupId)}/download`),
  /**
   * Starts a restore. Needs a fresh session (403 `reauth_required` otherwise).
   *
   * @param backupId - Backup id.
   * @param body - Mode and the typed service slug.
   * @returns The restore.
   */
  restore: (backupId: string, body: RestoreBody) =>
    request<Restore>("POST", `/v1/backups/${seg(backupId)}/restore`, { body }),
  /**
   * Reads one restore.
   *
   * @param restoreId - Restore id.
   * @param signal - Abort signal.
   * @returns The restore.
   */
  getRestore: (restoreId: string, signal?: AbortSignal) =>
    request<Restore>("GET", `/v1/restores/${seg(restoreId)}`, { signal }),
  /**
   * Reads the instance's backup bucket, without its secret.
   *
   * @param signal - Abort signal.
   * @returns The storage settings.
   */
  getStorage: (signal?: AbortSignal) =>
    request<BackupStorage>("GET", "/v1/instance/backup-storage", { signal }),
  /**
   * Sets the backup bucket after the API checks the credentials reach it.
   *
   * @param body - Endpoint, bucket, region and keys; omit the secret to keep the stored one.
   * @returns The storage settings.
   */
  putStorage: (body: BackupStorageBody) =>
    request<BackupStorage>("PUT", "/v1/instance/backup-storage", { body }),
};
