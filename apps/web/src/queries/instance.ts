import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deployApi } from "../lib/api/deploy-client";
import type {
  CompleteSigningKeyRolloverBody,
  GithubManifestBody,
  InstanceSettingsPatch,
  ScheduleSigningKeyRolloverBody,
} from "../lib/api/deploy-types";
import { securityApi } from "../lib/api/security-client";
import type { InstanceAuditQuery } from "../lib/api/security-types";
import { queryKeys } from "./keys";

/**
 * Reads install-wide settings (apps domain, TLS mode, log retention). Owners only.
 *
 * @param enabled - Skip for callers without `instance:manage`.
 * @returns The settings query.
 */
export function useInstanceSettings(enabled = true) {
  return useQuery({
    queryKey: queryKeys.instanceSettings,
    queryFn: ({ signal }) => deployApi.getInstanceSettings(signal),
    enabled,
  });
}

/**
 * Updates instance settings and caches the result.
 *
 * @returns A mutation taking the fields to change.
 */
export function useUpdateInstanceSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: InstanceSettingsPatch) => deployApi.updateInstanceSettings(body),
    onSuccess: (settings) => queryClient.setQueryData(queryKeys.instanceSettings, settings),
  });
}

/**
 * Reads whether the instance has a GitHub App and the workspace's installations.
 *
 * @param workspaceId - Workspace id.
 * @param enabled - Skip while not needed.
 * @returns The status query.
 */
export function useGithubStatus(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.githubStatus(workspaceId),
    queryFn: ({ signal }) => deployApi.getGithubStatus(workspaceId, signal),
    enabled,
  });
}

/**
 * Lists repositories the workspace's GitHub App installations can read.
 *
 * @param workspaceId - Workspace id.
 * @param enabled - Skip until the GitHub source is chosen.
 * @returns The repositories query.
 */
export function useGithubRepositories(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.githubRepositories(workspaceId),
    queryFn: ({ signal }) => deployApi.listGithubRepositories(workspaceId, undefined, signal),
    select: (data) => data.repositories,
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Starts the GitHub App manifest flow.
 *
 * @returns A mutation resolving to the manifest, state and GitHub URL to post to.
 */
export function useCreateGithubManifest() {
  return useMutation({
    mutationFn: (body: GithubManifestBody) => deployApi.createGithubManifest(body),
  });
}

/**
 * Reads the control-plane signing keys and rollover status. Instance admins only.
 *
 * @param enabled - Skip for callers without `instance:manage`.
 * @returns The status query.
 */
export function useSigningKeys(enabled = true) {
  return useQuery({
    queryKey: queryKeys.signingKeys,
    queryFn: ({ signal }) => deployApi.getSigningKeys(signal),
    enabled,
    // NOTE: servers pick up an announced key as they reconnect, so the list moves on its own.
    refetchInterval: 30_000,
  });
}

/** Rows fetched per instance audit log page. */
export const INSTANCE_AUDIT_PAGE_SIZE = 50;

/** Filters of the instance audit log the page offers. */
export type InstanceAuditFilters = Pick<InstanceAuditQuery, "action" | "actor_id">;

/**
 * Reads the instance audit log with cursor pagination. Instance admins only.
 *
 * @param filters - Action and actor to narrow to.
 * @param enabled - Skip for callers without `instance:manage`.
 * @returns An infinite query; call `fetchNextPage` to load older entries.
 */
export function useInstanceAuditLog(filters: InstanceAuditFilters, enabled = true) {
  return useInfiniteQuery({
    queryKey: [...queryKeys.instanceAudit, filters],
    queryFn: ({ pageParam, signal }) =>
      securityApi.listInstanceAuditLogs(
        { ...filters, cursor: pageParam ?? undefined, limit: INSTANCE_AUDIT_PAGE_SIZE },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    enabled,
  });
}

/**
 * Schedules, completes or cancels a signing-key rollover and caches the resulting status.
 *
 * @returns One mutation per action.
 */
export function useSigningKeyRollover() {
  const queryClient = useQueryClient();
  const onSuccess = (status: Awaited<ReturnType<typeof deployApi.getSigningKeys>>) =>
    queryClient.setQueryData(queryKeys.signingKeys, status);
  return {
    schedule: useMutation({
      mutationFn: (body: ScheduleSigningKeyRolloverBody) =>
        deployApi.scheduleSigningKeyRollover(body),
      onSuccess,
    }),
    complete: useMutation({
      mutationFn: (body: CompleteSigningKeyRolloverBody) =>
        deployApi.completeSigningKeyRollover(body),
      onSuccess,
    }),
    cancel: useMutation({ mutationFn: () => deployApi.cancelSigningKeyRollover(), onSuccess }),
  };
}

/**
 * Verifies the audit chain on demand.
 *
 * @returns A mutation resolving to the verification report.
 */
export function useVerifyAuditChain() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => securityApi.verifyAuditChain(),
    // Verifying seals pending entries first, so listed hashes may have changed.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.instanceAudit }),
  });
}

/**
 * Starts claiming a GitHub installation for a workspace.
 *
 * @returns A mutation taking the workspace id and resolving to the install URL.
 */
export function useStartGithubClaim() {
  return useMutation({
    mutationFn: (workspaceId: string) => securityApi.startGithubClaim(workspaceId),
  });
}

/**
 * Releases a GitHub installation from a workspace (ADR 0014). Needs a fresh session,
 * which the API client asks for.
 *
 * @param workspaceId - Workspace that holds the claim.
 * @returns A mutation taking the installation's `ghi_…` id.
 */
export function useReleaseGithubInstallation(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (installationId: string) =>
      securityApi.releaseGithubInstallation(workspaceId, installationId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.githubStatus(workspaceId) }),
  });
}
