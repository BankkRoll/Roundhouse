/**
 * Servers → Network (ADR 0005): `MESH_ROUTES` in `contracts/mesh.ts`.
 *
 * - `GET /mesh`: every server's mesh state and every pair's path.
 * - `POST /nodes/{id}/mesh/rotate-key`: starts a WireGuard key rotation;
 *   the node's Durable Object and `lib/mesh.ts` carry it through.
 *
 * @module
 */
import { nodes } from "@roundhouse/db";
import type { Action } from "@roundhouse/shared";
import { and, eq, isNull } from "drizzle-orm";
import { clientIp, createRouter, requireWorkspace } from "../context";
import { getMesh, policyOf, rotateMeshKey } from "../contracts";
import { recordAudit } from "../lib/audit";
import { refreshNodes } from "../lib/desired-state";
import { ApiError, notFound } from "../lib/errors";
import { readMesh, requestRotation, toMeshNode } from "../lib/mesh";
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
  });
