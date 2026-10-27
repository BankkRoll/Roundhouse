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
  drain: (workspaceId: string, nodeId: string) =>
    ["workspaces", workspaceId, "nodes", nodeId, "drain"] as const,
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

/** Poll interval of a drain that is still moving replicas. */
export const DRAIN_POLL_INTERVAL_MS = 2_000;

/**
 * A server's latest drain, polled while it runs.
 *
 * @param workspaceId - The workspace.
 * @param nodeId - The server.
 * @returns The query.
 */
export function useNodeDrain(workspaceId: string, nodeId: string) {
  return useQuery({
    queryKey: meshKeys.drain(workspaceId, nodeId),
    queryFn: ({ signal }) => meshApi.drain(workspaceId, nodeId, signal),
    refetchInterval: (query) =>
      query.state.data?.drain?.status === "running" ? DRAIN_POLL_INTERVAL_MS : false,
  });
}

/** Refetches what a drain or resume changes: the drain, the server and the mesh. */
function invalidateDrain(queryClient: QueryClient, workspaceId: string, nodeId: string) {
  void queryClient.invalidateQueries({ queryKey: meshKeys.drain(workspaceId, nodeId) });
  void queryClient.invalidateQueries({
    predicate: (query) => query.queryKey[0] === "workspaces" && query.queryKey[1] === workspaceId,
  });
}

/**
 * Starts draining a server.
 *
 * @param workspaceId - The workspace.
 * @param nodeId - The server.
 * @returns The mutation; its variable is `force`.
 */
export function useDrainNode(workspaceId: string, nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (force: boolean) => meshApi.startDrain(workspaceId, nodeId, force),
    onSuccess: (drain) => {
      queryClient.setQueryData(meshKeys.drain(workspaceId, nodeId), { drain });
      invalidateDrain(queryClient, workspaceId, nodeId);
    },
  });
}

/**
 * Takes a draining or maintenance server back into service.
 *
 * @param workspaceId - The workspace.
 * @param nodeId - The server.
 * @returns The mutation.
 */
export function useResumeNode(workspaceId: string, nodeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => meshApi.resume(workspaceId, nodeId),
    onSuccess: () => invalidateDrain(queryClient, workspaceId, nodeId),
  });
}
