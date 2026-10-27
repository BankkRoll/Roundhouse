import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
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

/**
 * Query key of a workspace's shell sessions.
 *
 * @param workspaceId - Workspace id.
 * @returns The key.
 */
export const shellSessionsKey = (workspaceId: string) =>
  ["workspaces", workspaceId, "shell-sessions"] as const;

/**
 * Reads a workspace's shell sessions with cursor pagination, newest first.
 *
 * @param workspaceId - Workspace id.
 * @param enabled - Skip when the caller can't read the audit log.
 * @returns An infinite query; `fetchNextPage` loads older sessions.
 */
export function useShellSessions(workspaceId: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: shellSessionsKey(workspaceId),
    queryFn: ({ pageParam, signal }) =>
      shellApi.listSessions(workspaceId, { cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    enabled,
  });
}

/**
 * Reads one session's recording (asciicast text). Never cached past its viewer: the
 * text holds whatever the shell showed, secrets included, so it is dropped as soon as
 * the player closes, and a refusal isn't retried (re-authentication already was).
 *
 * @param sessionId - Session id.
 * @returns The query.
 */
export function useShellRecording(sessionId: string) {
  return useQuery({
    queryKey: ["shell-sessions", sessionId, "recording"] as const,
    queryFn: ({ signal }) => shellApi.getRecording(sessionId, signal),
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
  });
}
