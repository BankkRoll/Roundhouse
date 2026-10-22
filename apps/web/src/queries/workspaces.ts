import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api/client";
import type { Me } from "../lib/api/types";
import { queryKeys } from "./keys";

/**
 * Query options for one workspace.
 *
 * @param workspaceId - Workspace id.
 * @returns Options for `useQuery`.
 */
export function workspaceQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: queryKeys.workspace(workspaceId),
    queryFn: ({ signal }) => api.getWorkspace(workspaceId, signal),
  });
}

/**
 * Reads `GET /v1/workspaces/:id`.
 *
 * @param workspaceId - Workspace id.
 * @returns The workspace query.
 */
export function useWorkspace(workspaceId: string) {
  return useQuery(workspaceQueryOptions(workspaceId));
}

/**
 * Renames a workspace and patches the cached `/v1/me` so the sidebar updates instantly.
 *
 * @param workspaceId - Workspace id.
 * @returns A mutation taking the new name.
 */
export function useRenameWorkspace(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.updateWorkspace(workspaceId, { name }),
    onSuccess: (workspace) => {
      queryClient.setQueryData(queryKeys.workspace(workspaceId), workspace);
      queryClient.setQueryData<Me>(queryKeys.me, (me) =>
        me
          ? {
              ...me,
              workspaces: me.workspaces.map((entry) =>
                entry.id === workspaceId
                  ? { ...entry, name: workspace.name, slug: workspace.slug }
                  : entry,
              ),
            }
          : me,
      );
    },
  });
}
