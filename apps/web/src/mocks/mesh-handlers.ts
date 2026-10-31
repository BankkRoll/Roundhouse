/**
 * MSW handlers for the mesh routes (`MESH_ROUTES` in `apps/api/src/contracts/mesh.ts`)
 * against the in-memory {@link db}. `contract.test.ts` validates every response against
 * the API's schemas.
 *
 * They follow the API's order: 401 without a session, 404 for a non-member, 403 when
 * the role lacks the action, 404 for a missing server, then 409 for a server outside the
 * mesh or while another server of the workspace rotates. There is no agent: a rotation
 * stays in progress until a test clears `rotating` itself. Resuming a server recovers
 * the services its forced drain degraded, announced over the realtime socket.
 *
 * @module
 */
import { HttpResponse, http } from "msw";
import { MESH_ROUTES } from "../../../api/src/contracts";
import type { Mesh, MeshNode, NodeDrain } from "../lib/api/mesh-client";
import type { Node } from "../lib/api/types";
import { apiError, notFound, recordAudit, requireWorkspace } from "./common";
import { db, makeNode, WORKSPACE_ID } from "./db";
import { announceServiceHealth } from "./deploy-handlers";
import { MESH_SEED_NODES, seededMesh, unjoinedMeshNode } from "./mesh-db";

function mswPath(name: keyof typeof MESH_ROUTES): string {
  return `*${MESH_ROUTES[name].path.replace(/\{([^}]+)\}/g, ":$1")}`;
}

/**
 * A server as the mesh reports it. With the mesh off nobody counts as joined, as the
 * API's `toMeshNode` has it.
 */
function meshNodeOf(node: Node, relays: ReadonlySet<string>): MeshNode {
  const state = db.mesh.nodes[node.id] ?? unjoinedMeshNode(node);
  const meshed = db.deploy.instance.mesh_enabled && state.mesh_index !== null;
  return {
    ...state,
    id: node.id,
    name: node.name,
    status: node.status,
    mesh_index: meshed ? state.mesh_index : null,
    address: meshed ? state.address : null,
    ready: meshed && state.ready,
    relay: relays.has(node.id),
  };
}

function workspaceNodes(workspaceId: string) {
  return db.nodes
    .filter((node) => node.workspace_id === workspaceId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readMesh(workspaceId: string): Mesh {
  const instance = db.deploy.instance;
  const nodes = workspaceNodes(workspaceId);
  const ids = new Set(nodes.map((node) => node.id));
  const pairs = instance.mesh_enabled
    ? db.mesh.pairs.filter((pair) => ids.has(pair.nodes[0]) && ids.has(pair.nodes[1]))
    : [];
  const relays = new Set(
    pairs.flatMap((pair) =>
      pair.path === "relayed" && pair.relay_node_id ? [pair.relay_node_id] : [],
    ),
  );
  return {
    enabled: instance.mesh_enabled,
    supernet: instance.mesh_supernet,
    nodes: nodes.map((node) => meshNodeOf(node, relays)),
    pairs,
  };
}

/**
 * Turns the mesh on and seeds a five-server network: `hel-1` and `nbg-1` public,
 * `home-1` and `lab-1` behind NAT (relayed through `hel-1`), and `office-1` whose Docker
 * firewall drops mesh packets. `fsn-1` stays pending and outside the mesh.
 *
 * @param now - Reference time.
 */
export function seedMeshNetwork(now = Date.now()): void {
  for (const extra of MESH_SEED_NODES) {
    if (db.nodes.some((node) => node.id === extra.id)) continue;
    db.nodes.push({
      ...makeNode({
        id: extra.id,
        name: extra.name,
        hostname: `${extra.name}.example.com`,
        public_ip: extra.public_ip,
        last_heartbeat_at: now - 3_000,
      }),
      workspace_id: WORKSPACE_ID,
    });
  }
  db.mesh = seededMesh(now);
  db.deploy.instance.mesh_enabled = true;
}

/** Every mesh and node-lifecycle route. */
export const meshHandlers = [
  http.get(mswPath("getNodeDrain"), ({ params }) => {
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "nodes:read");
    if (!access.ok) return access.response;
    const node = workspaceNodes(workspaceId).find((row) => row.id === params.nodeId);
    if (!node) return notFound("Server");
    return HttpResponse.json({ drain: db.mesh.drains[node.id] ?? null });
  }),

  // A mock drain finishes at once: it has no replicas to move.
  http.post(mswPath("drainNode"), async ({ params, request }) => {
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "nodes:manage");
    if (!access.ok) return access.response;
    const node = workspaceNodes(workspaceId).find((row) => row.id === params.nodeId);
    if (!node) return notFound("Server");
    if (node.status === "pending") {
      return apiError(409, "node_not_drainable", "This server hasn't connected yet.");
    }
    if (db.mesh.drains[node.id]?.status === "running") {
      return apiError(409, "drain_in_progress", "This server is already draining.");
    }
    const body = ((await request.json().catch(() => ({}))) ?? {}) as { force?: boolean };
    const now = Date.now();
    const drain: NodeDrain = {
      id: `drn_${now.toString(36)}`,
      node_id: node.id,
      status: "completed",
      force: body.force === true,
      moves: [],
      blocked: [],
      error: null,
      started_by: access.user.id,
      started_at: now,
      finished_at: now,
    };
    db.mesh.drains[node.id] = drain;
    node.status = "maintenance";
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: access.user.id,
      action: "node.drain_started",
      targetType: "node",
      targetId: node.id,
      metadata: { name: node.name, force: drain.force },
    });
    return HttpResponse.json(drain, { status: 202 });
  }),

  http.post(mswPath("resumeNode"), ({ params }) => {
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "nodes:manage");
    if (!access.ok) return access.response;
    const node = workspaceNodes(workspaceId).find((row) => row.id === params.nodeId);
    if (!node) return notFound("Server");
    if (node.status !== "draining" && node.status !== "maintenance") {
      return apiError(409, "node_not_draining", "This server isn't draining or in maintenance.");
    }
    const drain = db.mesh.drains[node.id];
    if (drain?.status === "running") drain.status = "cancelled";
    node.status = "online";
    for (const service of db.deploy.services) {
      if (service.health_reason === "node_maintenance" && service.health_node?.id === node.id) {
        announceServiceHealth(service.id, { health: "ok", health_reason: null, health_node: null });
      }
    }
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: access.user.id,
      action: "node.resumed",
      targetType: "node",
      targetId: node.id,
      metadata: { name: node.name },
    });
    return HttpResponse.json(node);
  }),

  http.get(mswPath("getMesh"), ({ params }) => {
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "nodes:read");
    if (!access.ok) return access.response;
    return HttpResponse.json(readMesh(workspaceId));
  }),

  http.post(mswPath("rotateMeshKey"), ({ params }) => {
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "nodes:manage");
    if (!access.ok) return access.response;
    const node = workspaceNodes(workspaceId).find((row) => row.id === params.nodeId);
    if (!node) return notFound("Server");
    const state = db.mesh.nodes[node.id];
    if (!db.deploy.instance.mesh_enabled || !state || state.mesh_index === null) {
      return apiError(409, "mesh_not_joined", "This server is not part of the mesh.");
    }
    const busy = workspaceNodes(workspaceId).some((row) => db.mesh.nodes[row.id]?.rotating);
    if (busy) {
      return apiError(
        409,
        "mesh_rotation_in_progress",
        "Another server of this workspace is rotating its key; one rotates at a time.",
      );
    }
    state.rotating = true;
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: access.user.id,
      action: "node.mesh_key_rotated",
      targetType: "node",
      targetId: node.id,
      metadata: { name: node.name, reason: "operator" },
    });
    // NOTE: Like the API, the response doesn't work out relays; the next read does.
    return HttpResponse.json(meshNodeOf(node, new Set()), { status: 202 });
  }),
];
