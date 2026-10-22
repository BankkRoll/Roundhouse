import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deployApi } from "../lib/api/deploy-client";
import type { GithubManifestBody, InstanceSettingsPatch } from "../lib/api/deploy-types";
import { queryKeys } from "./keys";

/**
 * Reads install-wide ingress settings (apps domain, TLS mode). Owners only.
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
