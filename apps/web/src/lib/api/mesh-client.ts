/**
 * Typed endpoint functions and wire types for the WireGuard mesh between a workspace's
 * servers (ADR 0005): reading it for Servers → Network, and rotating one server's key.
 * Turning the mesh on and its supernet are instance settings
 * (`deployApi.updateInstanceSettings`).
 *
 * Types come from the API's route contracts (`apps/api/src/contracts/mesh.ts`).
 *
 * @module
 */
import type {
  MESH_MODE_VALUES,
  MESH_NAT_VALUES,
  MESH_PATH_VALUES,
  Mesh,
  MeshNode,
  MeshPair,
} from "../../../../api/src/contracts";
import { request } from "./client";

export type { Mesh, MeshNode, MeshPair };

/** How two servers reach each other: direct, through a relay, or not at all. */
export type MeshPath = (typeof MESH_PATH_VALUES)[number];
/** How a server runs `wg0`. */
export type MeshMode = (typeof MESH_MODE_VALUES)[number];
/** Whether peers can reach a server directly. */
export type MeshNat = (typeof MESH_NAT_VALUES)[number];
/** One side's report of a tunnel. */
export type MeshPeerView = MeshPair["sides"][number];

const seg = encodeURIComponent;

/** Mesh endpoints. */
export const meshApi = {
  /**
   * Reads the workspace's mesh: servers, pair paths and handshakes.
   *
   * @param workspaceId - Workspace id.
   * @param signal - Abort signal.
   * @returns The mesh.
   */
  get: (workspaceId: string, signal?: AbortSignal) =>
    request<Mesh>("GET", `/v1/workspaces/${seg(workspaceId)}/mesh`, { signal }),
  /**
   * Starts a WireGuard key rotation for one server.
   *
   * @param workspaceId - Workspace id.
   * @param nodeId - Server to rotate.
   * @returns The server, now `rotating`.
   */
  rotateKey: (workspaceId: string, nodeId: string) =>
    request<MeshNode>(
      "POST",
      `/v1/workspaces/${seg(workspaceId)}/nodes/${seg(nodeId)}/mesh/rotate-key`,
    ),
};
