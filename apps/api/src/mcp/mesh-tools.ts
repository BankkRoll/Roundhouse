/**
 * Read-only MCP tool for the private network between servers (ADR 0005):
 * `get_mesh`.
 *
 * It checks the same action as `GET /v1/workspaces/{workspaceId}/mesh`
 * (`nodes:read`) and reads through the same `readMesh`, then trims the view
 * to what an agent needs to explain connectivity: readiness and errors per
 * server, and each pair's path and handshake age. Keys, byte counters and
 * per-side endpoints stay in the API. Turning the mesh on and rotating keys
 * need a human.
 *
 * @module
 */
import type { Action, ApiTokenScope } from "@roundhouse/shared";
import { z } from "zod";
import { requireWorkspace } from "../context";
import { getMesh, policyOf } from "../contracts";
import { readMesh } from "../lib/mesh";
import type { McpTool } from "./tools";

const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

const scopeOf = (route: Parameters<typeof policyOf>[0]): ApiTokenScope =>
  policyOf(route).action as Exclude<Action, "instance:manage" | "workspaces:create">;

const getMeshTool: McpTool = {
  name: "get_mesh",
  title: "Get the private network",
  description:
    "Summarises the WireGuard mesh between the workspace's servers: whether it is on, its " +
    "supernet, each server's mesh address, mode (kernel/userspace), reachability (public " +
    "endpoint or behind NAT), readiness and the error it reported, which servers relay, and " +
    "each pair's path (direct, relayed or down) with its last handshake. Read-only: turning " +
    "the mesh on and rotating keys need the dashboard.",
  input: z.object({
    workspace_id: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Workspace ID. Defaults to the token's workspace."),
  }),
  scopes: [scopeOf(getMesh)],
  annotations: READ,
  async run({ c, token }, raw) {
    const input = raw as { workspace_id?: string };
    const workspaceId = input.workspace_id ?? token.workspaceId;
    await requireWorkspace(c, workspaceId, policyOf(getMesh).action!);
    const now = Date.now();
    const mesh = await readMesh(c.get("db"), workspaceId, now);
    const names = new Map(mesh.nodes.map((node) => [node.id, node.name]));
    const joined = mesh.nodes.filter((node) => node.mesh_index !== null);
    const count = (path: string) => mesh.pairs.filter((pair) => pair.path === path).length;
    return {
      enabled: mesh.enabled,
      supernet: mesh.supernet,
      summary: {
        servers: mesh.nodes.length,
        joined: joined.length,
        ready: joined.filter((node) => node.ready).length,
        direct: count("direct"),
        relayed: count("relayed"),
        down: count("down"),
      },
      servers: mesh.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        status: node.status,
        supported: node.supported,
        joined: node.mesh_index !== null,
        address: node.address,
        mode: node.mode,
        nat: node.nat,
        endpoint: node.endpoint,
        docker_firewall: node.docker_firewall,
        accept_fwmark: node.accept_fwmark,
        ready: node.ready,
        error: node.error,
        relay: node.relay,
        rotating: node.rotating,
      })),
      pairs: mesh.pairs.map((pair) => ({
        servers: pair.nodes.map((id) => names.get(id) ?? id),
        path: pair.path,
        relay: pair.relay_node_id ? (names.get(pair.relay_node_id) ?? pair.relay_node_id) : null,
        last_handshake_at: pair.last_handshake_at,
        handshake_age_s:
          pair.last_handshake_at === null
            ? null
            : Math.max(0, Math.round((now - pair.last_handshake_at) / 1000)),
      })),
    };
  },
};

/** The mesh tools, in `tools/list` order. */
export const MESH_TOOLS: readonly McpTool[] = [getMeshTool];
