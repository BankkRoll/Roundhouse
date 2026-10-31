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
import { nodes } from "@roundhouse/db";
import type { Action } from "@roundhouse/shared";
import { and, eq, isNull } from "drizzle-orm";
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
import { refreshNodes } from "../lib/desired-state";
import { ApiError, notFound } from "../lib/errors";
import { readMesh, requestRotation, toMeshNode } from "../lib/mesh";
import {
  latestDrain,
  loadWorkspaceNode,
  resumeDrainedNode,
  startDrain,
  toApiDrain,
} from "../lib/node-lifecycle";
import { toApiNode } from "../lib/nodes";
import { nodeCostEstimates, withCostEstimates } from "../lib/provisioning";
import { getMeshSettings } from "../lib/settings";

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
    const { drain } = await startDrain(
      { db: c.get("db"), env: c.env },
      { workspaceId, nodeId, force, startedBy: m.user.id },
      { actor: m.actor, ip: clientIp(c) },
    );
    return c.json(toApiDrain(drain), 202);
  })
  .openapi(getNodeDrain, async (c) => {
    const { workspaceId, nodeId } = c.req.valid("param");
    await requireWorkspace(c, workspaceId, policyOf(getNodeDrain).action as Action);
    const db = c.get("db");
    await loadWorkspaceNode(db, workspaceId, nodeId);
    const drain = await latestDrain(db, nodeId);
    return c.json({ drain: drain ? toApiDrain(drain) : null }, 200);
  })
  .openapi(resumeNode, async (c) => {
    const { workspaceId, nodeId } = c.req.valid("param");
    const m = await requireWorkspace(c, workspaceId, policyOf(resumeNode).action as Action);
    const db = c.get("db");
    const { node: resumed } = await resumeDrainedNode(
      { db, env: c.env },
      { workspaceId, nodeId },
      { actor: m.actor, ip: clientIp(c) },
    );
    const [node] = withCostEstimates(
      [toApiNode(resumed)],
      await nodeCostEstimates(db, workspaceId),
    );
    return c.json(node!, 200);
  });
