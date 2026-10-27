/**
 * Servers → Network (ADR 0005): `MESH_ROUTES` in `contracts/mesh.ts`.
 *
 * - `GET /mesh`: every server's mesh state and every pair's path.
 * - `POST /nodes/{id}/mesh/rotate-key`: starts a WireGuard key rotation;
 *   the node's Durable Object and `lib/mesh.ts` carry it through.
 * - `POST /nodes/{id}/drain`, `GET /nodes/{id}/drain`, `POST /nodes/{id}/resume`:
 *   the node lifecycle; `workflows/drain.ts` moves the replicas.
 *
 * @module
 */
import { nodeDrains, nodes, placements } from "@roundhouse/db";
import { type Action, newId } from "@roundhouse/shared";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { clientIp, createRouter, requireWorkspace } from "../context";
import {
  drainNode,
  getMesh,
  getNodeDrain,
  policyOf,
  resumeNode,
  rotateMeshKey,
} from "../contracts";
import { recordAudit } from "../lib/audit";
import { disposeRpc } from "../lib/deployments";
import { refreshNodes } from "../lib/desired-state";
import { ApiError, notFound } from "../lib/errors";
import { readMesh, requestRotation, toMeshNode } from "../lib/mesh";
import { recoverNodeServices } from "../lib/moves";
import { toApiNode } from "../lib/nodes";
import { nodeCostEstimates, withCostEstimates } from "../lib/provisioning";
import { getMeshSettings } from "../lib/settings";

/** A `node_drains` row on the wire. */
function toApiDrain(d: typeof nodeDrains.$inferSelect) {
  return {
    id: d.id,
    node_id: d.nodeId,
    status: d.status,
    force: d.force,
    moves: d.moves.map((m) => ({
      workload_id: m.workloadId,
      deployment_id: m.deploymentId,
      service_id: m.serviceId,
      environment_id: m.environmentId,
      replica: m.replica,
      state: m.state,
      to_node_id: m.toNodeId,
      new_workload_id: m.newWorkloadId,
      error: m.error,
    })),
    blocked: d.blocked.map((b) => ({
      service_id: b.serviceId,
      environment_id: b.environmentId,
      service_name: b.serviceName,
    })),
    error: d.error,
    started_by: d.startedBy,
    started_at: +d.createdAt,
    finished_at: d.finishedAt ? +d.finishedAt : null,
  };
}

const liveNode = (workspaceId: string, nodeId: string) =>
  and(eq(nodes.id, nodeId), eq(nodes.workspaceId, workspaceId), isNull(nodes.deletedAt));

/** Mesh routes. */
export const meshRoutes = createRouter()
  .openapi(getMesh, async (c) => {
    const { workspaceId } = c.req.valid("param");
    await requireWorkspace(c, workspaceId, policyOf(getMesh).action as Action);
    return c.json(await readMesh(c.get("db"), workspaceId), 200);
  })
  .openapi(rotateMeshKey, async (c) => {
    const { workspaceId, nodeId } = c.req.valid("param");
    const m = await requireWorkspace(c, workspaceId, policyOf(rotateMeshKey).action as Action);
    const db = c.get("db");
    const [node] = await db
      .select({ id: nodes.id, name: nodes.name })
      .from(nodes)
      .where(
        and(eq(nodes.id, nodeId), eq(nodes.workspaceId, workspaceId), isNull(nodes.deletedAt)),
      );
    if (!node) throw notFound("Server");
    const outcome = await requestRotation(db, nodeId);
    if (outcome === "not_found") throw notFound("Server");
    if (outcome === "not_joined") {
      throw new ApiError(409, "mesh_not_joined", "This server is not part of the mesh.");
    }
    if (outcome === "in_progress") {
      throw new ApiError(
        409,
        "mesh_rotation_in_progress",
        "Another server of this workspace is rotating its key; one rotates at a time.",
      );
    }
    await refreshNodes(c.env, db, [nodeId]);
    await recordAudit(db, {
      workspaceId,
      ...m.actor,
      action: "node.mesh_key_rotated",
      targetType: "node",
      targetId: nodeId,
      metadata: { name: node.name, reason: "operator" },
      ip: clientIp(c),
    });
    const [row] = await db.select().from(nodes).where(eq(nodes.id, nodeId));
    return c.json(toMeshNode(row!, await getMeshSettings(db), false), 202);
  })
  .openapi(drainNode, async (c) => {
    const { workspaceId, nodeId } = c.req.valid("param");
    const { force } = c.req.valid("json");
    const m = await requireWorkspace(c, workspaceId, policyOf(drainNode).action as Action);
    const db = c.get("db");
    const [node] = await db.select().from(nodes).where(liveNode(workspaceId, nodeId));
    if (!node) throw notFound("Server");
    if (node.status === "pending") {
      throw new ApiError(409, "node_not_drainable", "This server hasn't connected yet.");
    }
    const [running] = await db
      .select({ id: nodeDrains.id })
      .from(nodeDrains)
      .where(and(eq(nodeDrains.nodeId, nodeId), eq(nodeDrains.status, "running")))
      .limit(1);
    if (running) {
      throw new ApiError(409, "drain_in_progress", "This server is already being drained.");
    }
    const id = newId("nodeDrain");
    const instanceId = `drain-${nodeId}-${Date.now()}`;
    // Draining first, so the scheduler stops placing here before anything moves.
    const [, [row]] = await db.batch([
      db.update(nodes).set({ status: "draining" }).where(liveNode(workspaceId, nodeId)),
      db
        .insert(nodeDrains)
        .values({
          id,
          workspaceId,
          nodeId,
          force,
          workflowInstanceId: instanceId,
          startedBy: m.user.id,
        })
        .returning(),
    ]);
    try {
      disposeRpc(await c.env.DRAIN_WORKFLOW.create({ id: instanceId, params: { drainId: id } }));
    } catch (err) {
      await db
        .update(nodeDrains)
        .set({ status: "failed", error: "Could not start the drain", finishedAt: new Date() })
        .where(eq(nodeDrains.id, id));
      throw err;
    }
    await recordAudit(db, {
      workspaceId,
      ...m.actor,
      action: "node.drain_started",
      targetType: "node",
      targetId: nodeId,
      metadata: { name: node.name, drain_id: id, force },
      ip: clientIp(c),
    });
    return c.json(toApiDrain(row!), 202);
  })
  .openapi(getNodeDrain, async (c) => {
    const { workspaceId, nodeId } = c.req.valid("param");
    await requireWorkspace(c, workspaceId, policyOf(getNodeDrain).action as Action);
    const db = c.get("db");
    const [node] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(liveNode(workspaceId, nodeId));
    if (!node) throw notFound("Server");
    const [drain] = await db
      .select()
      .from(nodeDrains)
      .where(eq(nodeDrains.nodeId, nodeId))
      .orderBy(desc(nodeDrains.id))
      .limit(1);
    return c.json({ drain: drain ? toApiDrain(drain) : null }, 200);
  })
  .openapi(resumeNode, async (c) => {
    const { workspaceId, nodeId } = c.req.valid("param");
    const m = await requireWorkspace(c, workspaceId, policyOf(resumeNode).action as Action);
    const db = c.get("db");
    const [resumed] = await db
      .update(nodes)
      .set({ status: "online" })
      .where(and(liveNode(workspaceId, nodeId), inArray(nodes.status, ["draining", "maintenance"])))
      .returning();
    if (!resumed) {
      const [node] = await db
        .select({ id: nodes.id })
        .from(nodes)
        .where(liveNode(workspaceId, nodeId));
      if (!node) throw notFound("Server");
      throw new ApiError(409, "node_not_draining", "This server isn't draining or in maintenance.");
    }
    const now = new Date();
    await db
      .update(nodeDrains)
      .set({ status: "cancelled", finishedAt: now, updatedAt: now })
      .where(and(eq(nodeDrains.nodeId, nodeId), eq(nodeDrains.status, "running")));
    // Volume services a forced drain stopped start again where their data is.
    const unparked = await db
      .update(placements)
      .set({ state: "pending", lastStatusAt: null, updatedAt: now })
      .where(and(eq(placements.nodeId, nodeId), eq(placements.state, "parked")))
      .returning({ id: placements.id });
    await recoverNodeServices(db, nodeId, ["node_maintenance"]);
    await refreshNodes(c.env, db, [nodeId]);
    await recordAudit(db, {
      workspaceId,
      ...m.actor,
      action: "node.resumed",
      targetType: "node",
      targetId: nodeId,
      metadata: { name: resumed.name, restarted: unparked.length },
      ip: clientIp(c),
    });
    const [node] = withCostEstimates(
      [toApiNode(resumed)],
      await nodeCostEstimates(db, workspaceId),
    );
    return c.json(node!, 200);
  });
