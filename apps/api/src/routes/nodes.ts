/**
 * Node management for operators (list, inspect, remove, join tokens).
 * Agent-facing endpoints live in `./agent.ts`.
 *
 * @module
 */
import { createRoute, z } from "@hono/zod-openapi";
import { nodes } from "@roundhouse/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { clientIp, createRouter, originOf, requireWorkspace } from "../context";
import { defineRoute, session } from "../contracts/policy";
import { recordAudit } from "../lib/audit";
import { notFound } from "../lib/errors";
import { mintJoinToken } from "../lib/join-tokens";
import { installCommand, toApiNode } from "../lib/nodes";
import { deprovisionNodeServer, nodeCostEstimates, withCostEstimates } from "../lib/provisioning";
import {
  errors,
  json,
  Millis,
  NodeSchema,
  RemoveNodeQuery,
  sessionAuth,
  WorkspaceParams,
} from "../schemas";

const NodeParams = WorkspaceParams.extend({ nodeId: z.string() });

const list = createRoute({
  method: "get",
  path: "/v1/workspaces/{workspaceId}/nodes",
  tags: ["nodes"],
  summary: "List servers",
  security: sessionAuth,
  request: { params: WorkspaceParams },
  responses: { 200: json(z.object({ nodes: z.array(NodeSchema) })), ...errors(401, 403, 404) },
});

const get = createRoute({
  method: "get",
  path: "/v1/workspaces/{workspaceId}/nodes/{nodeId}",
  tags: ["nodes"],
  summary: "Get a server",
  security: sessionAuth,
  request: { params: NodeParams },
  responses: { 200: json(NodeSchema), ...errors(401, 403, 404) },
});

const remove = createRoute({
  method: "delete",
  path: "/v1/workspaces/{workspaceId}/nodes/{nodeId}",
  tags: ["nodes"],
  summary: "Remove a server and revoke its credential",
  description:
    "For servers Roundhouse provisioned, also deletes the cloud server unless `keep_server=true`.",
  security: sessionAuth,
  request: { params: NodeParams, query: RemoveNodeQuery },
  responses: { 204: { description: "Removed" }, ...errors(401, 403, 404, 409, 429, 502) },
});

// SECURITY: A join token lets a machine into the workspace, where it can be
// handed workloads and their secrets, so minting one needs a fresh session
// (ADR 0014 "Fresh sessions"); the router enforces it.
const createJoinToken = defineRoute(
  session("nodes:manage", ["node.join_token_created"], { reauth: true }),
  {
    method: "post",
    path: "/v1/workspaces/{workspaceId}/nodes/join-tokens",
    tags: ["nodes"],
    summary: "Create a single-use join token and install command",
    description:
      "Needs a fresh session (403 `reauth_required`); API tokens can't create join tokens.",
    security: sessionAuth,
    request: { params: WorkspaceParams },
    responses: {
      201: json(
        z.object({ token: z.string(), expires_at: Millis, install_command: z.string() }),
        "Created",
      ),
      ...errors(401, 403, 404),
    },
  },
);

const liveNode = (workspaceId: string, nodeId: string) =>
  and(eq(nodes.id, nodeId), eq(nodes.workspaceId, workspaceId), isNull(nodes.deletedAt));

/** Operator-facing node routes. */
export const nodeRoutes = createRouter()
  .openapi(list, async (c) => {
    const { workspaceId } = c.req.valid("param");
    await requireWorkspace(c, workspaceId, "nodes:read");
    const rows = await c
      .get("db")
      .select()
      .from(nodes)
      .where(and(eq(nodes.workspaceId, workspaceId), isNull(nodes.deletedAt)))
      .orderBy(asc(nodes.name));
    const now = Date.now();
    const costs = await nodeCostEstimates(c.get("db"), workspaceId);
    return c.json(
      {
        nodes: withCostEstimates(
          rows.map((n) => toApiNode(n, now)),
          costs,
        ),
      },
      200,
    );
  })
  .openapi(get, async (c) => {
    const { workspaceId, nodeId } = c.req.valid("param");
    await requireWorkspace(c, workspaceId, "nodes:read");
    const [row] = await c.get("db").select().from(nodes).where(liveNode(workspaceId, nodeId));
    if (!row) throw notFound("Server");
    const costs = await nodeCostEstimates(c.get("db"), workspaceId);
    const [node] = withCostEstimates([toApiNode(row)], costs);
    return c.json(node!, 200);
  })
  .openapi(remove, async (c) => {
    const { workspaceId, nodeId } = c.req.valid("param");
    const { keep_server: keepServer } = c.req.valid("query");
    const m = await requireWorkspace(c, workspaceId, "nodes:manage");
    const [live] = await c.get("db").select().from(nodes).where(liveNode(workspaceId, nodeId));
    if (!live) throw notFound("Server");
    // Delete the cloud server first: if the provider refuses, the node stays
    // listed so the operator can retry instead of losing track of a billing server.
    const deprovisioned = keepServer ? null : await deprovisionNodeServer(c.get("db"), c.env, live);
    const [row] = await c
      .get("db")
      .update(nodes)
      .set({ deletedAt: new Date(), status: "offline" })
      .where(liveNode(workspaceId, nodeId))
      .returning({ id: nodes.id, name: nodes.name });
    if (!row) throw notFound("Server");
    // The connect route rejects deleted nodes, but an already-open socket
    // must be cut explicitly.
    await c.env.NODE_CONNECTION.get(c.env.NODE_CONNECTION.idFromName(nodeId)).disconnect("removed");
    await recordAudit(c.get("db"), {
      workspaceId,
      ...m.actor,
      action: "node.removed",
      targetType: "node",
      targetId: nodeId,
      metadata: { name: row.name },
      ip: clientIp(c),
    });
    if (deprovisioned) {
      await recordAudit(c.get("db"), {
        workspaceId,
        ...m.actor,
        action: "node.deprovisioned",
        targetType: "node",
        targetId: nodeId,
        metadata: {
          provider: deprovisioned.provider,
          server_id: deprovisioned.serverId,
          deleted: deprovisioned.deleted,
        },
        ip: clientIp(c),
      });
    }
    return c.body(null, 204);
  })
  .openapi(createJoinToken, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const m = await requireWorkspace(c, workspaceId, "nodes:manage");
    const { id, token, expiresAt } = await mintJoinToken(c.get("db"), {
      workspaceId,
      createdBy: m.user.id,
    });
    await recordAudit(c.get("db"), {
      workspaceId,
      ...m.actor,
      action: "node.join_token_created",
      targetType: "join_token",
      targetId: id,
      ip: clientIp(c),
    });
    return c.json(
      { token, expires_at: +expiresAt, install_command: installCommand(originOf(c), token) },
      201,
    );
  });
