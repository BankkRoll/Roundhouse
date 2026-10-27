/**
 * Backup queries (ADR 0004): a service's backup policy and backups, restores, downloads,
 * and the instance's backup storage. The backup list polls while a backup or restore is
 * in flight, since their progress isn't pushed over the realtime socket.
 *
 * @module
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type Backup,
  type BackupPolicyPatch,
  type BackupStorageBody,
  backupsApi,
  type RestoreBody,
} from "../lib/api/backups-client";
import { queryKeys } from "./keys";
import { invalidateProjectSummaries } from "./projects";

/** How often the backup list refreshes while a backup or restore runs. */
export const BACKUP_POLL_MS = 5_000;

/** Query keys of backups; the service ones are prefixes of the service keys. */
export const backupKeys = {
  policy: (serviceId: string, environmentId: string) =>
    ["services", serviceId, "backup-policy", environmentId] as const,
  list: (serviceId: string, environmentId: string) =>
    ["services", serviceId, "backups", environmentId] as const,
  restore: (restoreId: string) => ["restores", restoreId] as const,
  storage: ["instance", "backup-storage"] as const,
};

const inFlight = (backup: Pick<Backup, "status">) =>
  backup.status === "queued" || backup.status === "running";

/**
 * A service's backup policy in an environment.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @returns The policy query.
 */
export function useBackupPolicy(serviceId: string, environmentId: string | undefined) {
  return useQuery({
    queryKey: backupKeys.policy(serviceId, environmentId ?? ""),
    queryFn: ({ signal }) => backupsApi.getPolicy(serviceId, environmentId!, signal),
    enabled: Boolean(environmentId),
  });
}

/**
 * Saves a backup policy and caches the result.
 *
 * @param serviceId - Service id.
 * @returns A mutation taking the policy patch.
 */
export function useSaveBackupPolicy(serviceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: BackupPolicyPatch) => backupsApi.putPolicy(serviceId, body),
    onSuccess: (policy) =>
      queryClient.setQueryData(backupKeys.policy(serviceId, policy.environment_id), policy),
  });
}

/**
 * The newest page of a service's backups, polled while one is queued or running.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @returns The backups query.
 */
export function useBackups(serviceId: string, environmentId: string | undefined) {
  return useQuery({
    queryKey: backupKeys.list(serviceId, environmentId ?? ""),
    queryFn: ({ signal }) => backupsApi.list(serviceId, environmentId!, undefined, signal),
    enabled: Boolean(environmentId),
    refetchInterval: (query) => (query.state.data?.backups.some(inFlight) ? BACKUP_POLL_MS : false),
  });
}

/**
 * Takes a manual backup now and refreshes the list.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id.
 * @returns A mutation without input.
 */
export function useCreateBackup(serviceId: string, environmentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => backupsApi.create(serviceId, environmentId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: backupKeys.list(serviceId, environmentId) }),
  });
}

/**
 * Deletes a backup and refreshes the list.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id.
 * @returns A mutation taking the backup id.
 */
export function useDeleteBackup(serviceId: string, environmentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (backupId: string) => backupsApi.remove(backupId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: backupKeys.list(serviceId, environmentId) }),
  });
}

/**
 * Gets a presigned download link for a backup.
 *
 * @returns A mutation taking the backup id.
 */
export function useBackupDownload() {
  return useMutation({ mutationFn: (backupId: string) => backupsApi.download(backupId) });
}

/**
 * Starts a restore and refreshes the list (an in-place restore queues a safety backup).
 * A restore into a new service also refreshes the project and its summaries, which now
 * hold the new database.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id.
 * @param projectId - The service's project.
 * @returns A mutation taking the backup id and restore body.
 */
export function useRestoreBackup(serviceId: string, environmentId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ backupId, body }: { backupId: string; body: RestoreBody }) =>
      backupsApi.restore(backupId, body),
    onSuccess: (restore) => {
      queryClient.setQueryData(backupKeys.restore(restore.id), restore);
      void queryClient.invalidateQueries({ queryKey: backupKeys.list(serviceId, environmentId) });
      if (restore.mode === "new_service") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
        invalidateProjectSummaries(queryClient, projectId);
      }
    },
  });
}

/**
 * A restore, polled until it finishes.
 *
 * @param restoreId - Restore id, or `null` for none.
 * @returns The restore query.
 */
export function useRestore(restoreId: string | null) {
  return useQuery({
    queryKey: backupKeys.restore(restoreId ?? ""),
    queryFn: ({ signal }) => backupsApi.getRestore(restoreId!, signal),
    enabled: restoreId !== null,
    refetchInterval: (query) =>
      query.state.data &&
      (query.state.data.status === "queued" || query.state.data.status === "running")
        ? BACKUP_POLL_MS
        : false,
  });
}

/**
 * The instance's backup bucket. Instance admins only.
 *
 * @param enabled - Skip for callers without `instance:manage`.
 * @returns The storage query.
 */
export function useBackupStorage(enabled = true) {
  return useQuery({
    queryKey: backupKeys.storage,
    queryFn: ({ signal }) => backupsApi.getStorage(signal),
    enabled,
  });
}

/**
 * Sets the backup bucket and caches the result.
 *
 * @returns A mutation taking the storage body.
 */
export function useSaveBackupStorage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: BackupStorageBody) => backupsApi.putStorage(body),
    onSuccess: (storage) => queryClient.setQueryData(backupKeys.storage, storage),
  });
}
