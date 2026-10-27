/**
 * Mesh queries (ADR 0005): the workspace's private network between servers, polled
 * while visible, and rotating one server's WireGuard key.
 *
 * @module
 */
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type Mesh, type MeshNode, meshApi } from "../lib/api/mesh-client";

/**
 * How often the mesh refreshes while visible. Agents report handshakes about every 30
 * seconds, so polling faster only repeats the same answer.
 */
export const MESH_POLL_INTERVAL_MS = 15_000;

/** Query keys of the mesh; they sit under the workspace key. */
export const meshKeys = {
  mesh: (workspaceId: string) => ["workspaces", workspaceId, "mesh"] as const,
};

/**
 * Reads the workspace's mesh, polling so paths and handshakes stay current.
 *
 * @param workspaceId - Workspace id.
 * @param enabled - Skip for callers without `nodes:read`.
 * @returns The mesh query.
 */
export function useMesh(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: meshKeys.mesh(workspaceId),
    queryFn: ({ signal }) => meshApi.get(workspaceId, signal),
    enabled,
    refetchInterval: (query) => (query.state.status === "error" ? false : MESH_POLL_INTERVAL_MS),
  });
}

/**
 * Writes one server's mesh state into the cached mesh, keeping pairs as they are. The
 * cached relay flag is kept too: the rotate response doesn't work relays out.
 *
 * @param queryClient - Shared query client.
 * @param workspaceId - Workspace id.
 * @param node - The server as the API last reported it.
 */
export function upsertMeshNode(queryClient: QueryClient, workspaceId: string, node: MeshNode) {
  queryClient.setQueryData<Mesh>(meshKeys.mesh(workspaceId), (previous) =>
    previous
      ? {
          ...previous,
          nodes: previous.nodes.map((row) =>
            row.id === node.id ? { ...node, relay: row.relay } : row,
          ),
        }
      : previous,
  );
}

/**
 * Drops every cached mesh, e.g. after the mesh was turned on or off for the instance.
 *
 * @param queryClient - Shared query client.
 */
export function invalidateMeshes(queryClient: QueryClient) {
  void queryClient.invalidateQueries({
    predicate: (query) => query.queryKey[0] === "workspaces" && query.queryKey[2] === "mesh",
  });
}

/**
 * Starts a WireGuard key rotation for one server.
 *
 * @param workspaceId - Workspace id.
 * @returns A mutation taking the server id and resolving to the rotating server.
 */
export function useRotateMeshKey(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (nodeId: string) => meshApi.rotateKey(workspaceId, nodeId),
    onSuccess: (node) => {
      upsertMeshNode(queryClient, workspaceId, node);
      void queryClient.invalidateQueries({ queryKey: meshKeys.mesh(workspaceId) });
    },
  });
}
