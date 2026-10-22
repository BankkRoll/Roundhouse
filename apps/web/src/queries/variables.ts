import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deployApi } from "../lib/api/deploy-client";
import type { VariablesPutBody } from "../lib/api/deploy-types";
import { queryKeys } from "./keys";

/**
 * Reads a service's variables in an environment. Secret values are `null`.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @param enabled - Skip, e.g. while the caller cannot read variables.
 * @returns The variables query (data is the array, sorted by key).
 */
export function useServiceVariables(
  serviceId: string,
  environmentId: string | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.variables(serviceId, environmentId ?? ""),
    queryFn: ({ signal }) => deployApi.listServiceVariables(serviceId, environmentId ?? "", signal),
    select: (data) =>
      [...data.variables].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    enabled: enabled && Boolean(environmentId),
  });
}

/**
 * Reads a project environment's shared variables, for `${{shared.…}}` suggestions.
 *
 * @param projectId - Project id.
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @param enabled - Skip while not needed.
 * @returns The shared variables query.
 */
export function useSharedVariables(
  projectId: string,
  environmentId: string | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.sharedVariables(projectId, environmentId ?? ""),
    queryFn: ({ signal }) => deployApi.listSharedVariables(projectId, environmentId ?? "", signal),
    select: (data) => data.variables,
    enabled: enabled && Boolean(environmentId),
    staleTime: 60_000,
  });
}

/**
 * Writes staged variable changes as one new version and replaces the cached list with
 * the API's answer.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id.
 * @returns A mutation taking the `{ set, delete }` body.
 */
export function useSaveVariables(serviceId: string, environmentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: VariablesPutBody) =>
      deployApi.putServiceVariables(serviceId, environmentId, body),
    onSuccess: (data) =>
      queryClient.setQueryData(queryKeys.variables(serviceId, environmentId), data),
  });
}

/**
 * Reveals secret values. Each call is audited by the API, so the dashboard never caches
 * or prefetches the result beyond the component that asked.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id.
 * @returns A mutation taking the keys and resolving to `{ key: value }`.
 */
export function useRevealVariables(serviceId: string, environmentId: string) {
  return useMutation({
    mutationFn: async (keys: string[]) => {
      const { variables } = await deployApi.revealServiceVariables(serviceId, environmentId, keys);
      return Object.fromEntries(variables.map((variable) => [variable.key, variable.value]));
    },
    // SECURITY: Plaintext secrets must not linger in the MutationCache after use.
    gcTime: 0,
  });
}
