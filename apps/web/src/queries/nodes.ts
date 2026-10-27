import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api/client";
import { queryKeys } from "./keys";

/** How often node lists and details refresh while visible. */
export const NODE_POLL_INTERVAL_MS = 5_000;

/**
 * Reads the workspace's nodes, polling so status and usage stay live.
 *
 * @param workspaceId - Workspace id.
 * @param pollIntervalMs - Refetch interval; `false` disables polling.
 * @returns The nodes query (data is the node array).
 */
export function useNodes(
  workspaceId: string,
  pollIntervalMs: number | false = NODE_POLL_INTERVAL_MS,
) {
  return useQuery({
    queryKey: queryKeys.nodes(workspaceId),
    queryFn: ({ signal }) => api.listNodes(workspaceId, signal),
    select: (data) => data.nodes,
    refetchInterval: pollIntervalMs,
  });
}

/**
 * Reads one node, polling for fresh usage. Polling stops once a request fails: a 404
 * will not fix itself, and a window refocus still retries.
 *
 * @param workspaceId - Workspace id.
 * @param nodeId - Node id.
 * @param pollIntervalMs - Refetch interval while healthy.
 * @returns The node query.
 */
export function useNode(
  workspaceId: string,
  nodeId: string,
  pollIntervalMs: number = NODE_POLL_INTERVAL_MS,
) {
  return useQuery({
    queryKey: queryKeys.node(workspaceId, nodeId),
    queryFn: ({ signal }) => api.getNode(workspaceId, nodeId, signal),
    refetchInterval: (query) => (query.state.status === "error" ? false : pollIntervalMs),
  });
}

/**
 * Removes a node and refreshes the node list.
 *
 * The node's own cached detail is left alone: the caller should navigate away first and
 * then call {@link forgetNode}, otherwise the still-mounted detail page refetches and
 * flashes "not found".
 *
 * @param workspaceId - Workspace id.
 * @returns A mutation taking the node id and, for a provisioned server, whether to keep
 *   it running at the provider.
 */
export function useDeleteNode(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, keepServer = false }: { nodeId: string; keepServer?: boolean }) =>
      api.deleteNode(workspaceId, nodeId, keepServer),
    onSuccess: () =>
      // NOTE: exact, because node detail keys extend the list key and would refetch too.
      queryClient.invalidateQueries({ queryKey: queryKeys.nodes(workspaceId), exact: true }),
  });
}

/**
 * Replaces a node's labels, then caches the node and refreshes the node list.
 *
 * @param workspaceId - Workspace id.
 * @param nodeId - Node id.
 * @returns A mutation taking the complete new label set.
 */
export function useUpdateNodeLabels(workspaceId: string, nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (labels: Record<string, string>) => api.putNodeLabels(workspaceId, nodeId, labels),
    onSuccess: (node) => {
      queryClient.setQueryData(queryKeys.node(workspaceId, nodeId), node);
      void queryClient.invalidateQueries({ queryKey: queryKeys.nodes(workspaceId), exact: true });
    },
  });
}

/**
 * Drops a removed node's cached detail.
 *
 * @param queryClient - Shared query client.
 * @param workspaceId - Workspace id.
 * @param nodeId - The removed node.
 */
export function forgetNode(queryClient: QueryClient, workspaceId: string, nodeId: string): void {
  queryClient.removeQueries({ queryKey: queryKeys.node(workspaceId, nodeId), exact: true });
}

/**
 * Mints a single-use join token and install command for a new server.
 *
 * @param workspaceId - Workspace id.
 * @returns A mutation resolving to the token, its expiry and the install one-liner.
 */
export function useCreateJoinToken(workspaceId: string) {
  return useMutation({ mutationFn: () => api.createJoinToken(workspaceId) });
}
