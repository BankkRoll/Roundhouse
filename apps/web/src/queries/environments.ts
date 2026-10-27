/**
 * Environment lifecycle queries (ADR 0007): the diff between two environments, and
 * creating, promoting and deleting environments.
 *
 * @module
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CreateEnvironmentBody,
  environmentsApi,
  type PromoteEnvironmentBody,
} from "../lib/api/environments-client";
import { queryKeys } from "./keys";

/**
 * What differs between two environments; off until both are chosen and differ.
 *
 * @param projectId - Project id.
 * @param base - Base environment id.
 * @param target - Target environment id.
 * @returns The diff query.
 */
export function useEnvironmentDiff(projectId: string, base?: string, target?: string) {
  return useQuery({
    queryKey: ["projects", projectId, "environment-diff", base, target] as const,
    queryFn: ({ signal }) => environmentsApi.diff(projectId, base!, target!, signal),
    enabled: !!base && !!target && base !== target,
  });
}

/**
 * Creates (or clones) an environment and refreshes the project.
 *
 * @param projectId - Project id.
 * @returns The mutation.
 */
export function useCreateEnvironment(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEnvironmentBody) => environmentsApi.create(projectId, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) }),
  });
}

/**
 * Proposes a promotion into an environment.
 *
 * @param projectId - Project id, whose change sets refresh.
 * @returns The mutation; it takes the target and the body.
 */
export function usePromoteEnvironment(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { environmentId: string; body: PromoteEnvironmentBody }) =>
      environmentsApi.promote(input.environmentId, input.body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) }),
  });
}

/**
 * Deletes an environment and refreshes the project.
 *
 * @param projectId - Project id.
 * @returns The mutation; it takes the environment and its typed slug.
 */
export function useDeleteEnvironment(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { environmentId: string; confirm: string }) =>
      environmentsApi.remove(input.environmentId, input.confirm),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) }),
  });
}
