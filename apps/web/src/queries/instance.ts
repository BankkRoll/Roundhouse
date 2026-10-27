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
import {
  type InstanceDomainSettings,
  type PutInstanceDomainsBody,
  tlsApi,
} from "../lib/api/tls-client";
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
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.instanceSettings, settings);
      // NOTE: Domains & TLS reads the same fields, and its form compares against them;
      // patching first keeps it from looking unsaved until the refetch lands.
      queryClient.setQueryData<InstanceDomainSettings>(queryKeys.instanceDomains, (previous) =>
        previous
          ? {
              ...previous,
              apps_domain: settings.apps_domain,
              tls_mode: settings.tls_mode,
              ingress_nodes: settings.ingress_nodes,
            }
          : previous,
      );
      // A mode or apps domain change starts or drops certificates and moves what
      // managed mode can issue.
      void queryClient.invalidateQueries({ queryKey: queryKeys.instanceDomains });
      void queryClient.invalidateQueries({ queryKey: queryKeys.certificates });
    },
  });
}

/**
 * Reads the Domains & TLS settings: ingress hostname, ACME CA, Cloudflare zone, and
 * whether `managed` mode may be selected. Instance admins only.
 *
 * @param enabled - Skip for callers without `instance:manage`.
 * @returns The settings query.
 */
export function useInstanceDomains(enabled = true) {
  return useQuery({
    queryKey: queryKeys.instanceDomains,
    queryFn: ({ signal }) => tlsApi.getSettings(signal),
    enabled,
  });
}

/**
 * Changes the Domains & TLS settings and caches the result.
 *
 * @returns A mutation taking the fields to change.
 */
export function useSaveInstanceDomains() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PutInstanceDomainsBody) => tlsApi.putSettings(body),
    onSuccess: (settings) => {
      queryClient.setQueryData(queryKeys.instanceDomains, settings);
      // A new zone or CA starts certificate orders at once.
      void queryClient.invalidateQueries({ queryKey: queryKeys.certificates });
    },
  });
}

/** How often the certificate list refreshes while open; orders finish in the background. */
export const CERTIFICATES_POLL_MS = 15_000;

/**
 * Lists the control plane's certificates. Instance admins only.
 *
 * @param enabled - Skip for callers without `instance:manage`.
 * @returns The certificates query.
 */
export function useCertificates(enabled = true) {
  return useQuery({
    queryKey: queryKeys.certificates,
    queryFn: ({ signal }) => tlsApi.listCertificates(signal),
    select: (data) => data.certificates,
    enabled,
    refetchInterval: CERTIFICATES_POLL_MS,
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
