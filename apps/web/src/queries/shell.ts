import { useQuery } from "@tanstack/react-query";
import { shellApi } from "../lib/api/shell-client";

/**
 * Query key of a service's shell targets in an environment.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id.
 * @returns The key.
 */
export const shellTargetsKey = (serviceId: string, environmentId: string) =>
  ["services", serviceId, "shell-targets", environmentId] as const;

/**
 * Reads the replicas a shell can open in and whether the caller may open one. Not
 * refetched on focus: the list only matters when the user picks a replica, and a stale
 * gate is re-checked by the socket itself.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id; the query waits for it.
 * @returns The query.
 */
export function useShellTargets(serviceId: string, environmentId: string | undefined) {
  return useQuery({
    queryKey: shellTargetsKey(serviceId, environmentId ?? ""),
    queryFn: ({ signal }) => shellApi.listTargets(serviceId, environmentId ?? "", signal),
    enabled: Boolean(environmentId),
    refetchOnWindowFocus: false,
  });
}
