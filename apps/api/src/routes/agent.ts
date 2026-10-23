/**
 * Endpoints called by node agents and the install script — never by browsers.
 *
 * - `POST /v1/nodes/join` exchanges a single-use join token for a node identity.
 * - `GET /v1/nodes/:id/connect` upgrades to the agent's WebSocket, which is
 *   owned by that node's `NodeConnection` Durable Object.
 * - `GET /install.sh` serves the installer with this control plane's origin baked in.
 *
 * @module
 */
import { createRoute } from "@hono/zod-openapi";
import { nodeJoinTokens, nodes } from "@roundhouse/db";
import { JoinRequestSchema, JoinResponseSchema, nodeEncryptionKeyId } from "@roundhouse/protocol";
import { newId, PINNED_AGENT_VERSION } from "@roundhouse/shared";
import { and, eq, gt, isNull } from "drizzle-orm";
import installScript from "../../../../install/install.sh";
import { clientIp, createRouter, originOf, requireMasterKey } from "../context";
import { recordAudit } from "../lib/audit";
import { hashToken, randomToken } from "../lib/crypto";
import { ApiError, errorBody } from "../lib/errors";
import { isShellSafeOrigin, NODE_ID_HEADER } from "../lib/nodes";
import { isSetupComplete, loadSigningKey } from "../lib/settings";
import { body, errors, json } from "../schemas";

const join = createRoute({
  method: "post",
  path: "/v1/nodes/join",
  tags: ["agent"],
  summary: "Register a new node using a join token",
  request: body(JoinRequestSchema),
  responses: { 201: json(JoinResponseSchema, "Joined"), ...errors(400, 401, 429, 503) },
});

/** Agent-facing routes. */
export const agentRoutes = createRouter()
  .openapi(join, async (c) => {
    requireMasterKey(c);
    const db = c.get("db");
    const input = c.req.valid("json");
    if (!(await isSetupComplete(db))) {
      throw new ApiError(503, "setup_incomplete", "Control plane setup is not complete");
    }
    const signing = await loadSigningKey(db, c.env);

    // SECURITY: Consume the token in the same statement that checks it, so a
    // token can't be used twice even by concurrent joins.
    const [token] = await db
      .update(nodeJoinTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(nodeJoinTokens.tokenHash, await hashToken(input.token)),
          isNull(nodeJoinTokens.usedAt),
          gt(nodeJoinTokens.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!token) {
      throw new ApiError(401, "invalid_token", "Join token is invalid, expired, or already used");
    }

    const nodeId = newId("node");
    const credential = randomToken("nc");
    await db.batch([
      db.insert(nodes).values({
        id: nodeId,
        workspaceId: token.workspaceId,
        name: input.name,
        hostname: input.hostname,
        // The address Cloudflare observed beats a self-reported one.
        publicIp: clientIp(c) ?? input.public_ip ?? null,
        identityPublicKey: input.public_key,
        ...(input.encryption_public_key
          ? {
              encryptionPublicKey: input.encryption_public_key,
              encryptionKeyId: await nodeEncryptionKeyId(input.encryption_public_key),
              encryptionKeyRegisteredAt: new Date(),
            }
          : {}),
        credentialHash: await hashToken(credential),
        os: input.os,
        arch: input.arch,
        agentVersion: input.agent_version,
        capabilities: input.capabilities,
        cpuTotal: input.hardware.cpu_cores,
        memTotal: input.hardware.mem_bytes,
        diskTotal: input.hardware.disk_bytes,
      }),
      db.update(nodeJoinTokens).set({ nodeId }).where(eq(nodeJoinTokens.id, token.id)),
    ]);
    await recordAudit(db, {
      workspaceId: token.workspaceId,
      actorType: "node",
      actorId: nodeId,
      action: "node.joined",
      targetType: "node",
      targetId: nodeId,
      metadata: { name: input.name, hostname: input.hostname, agent_version: input.agent_version },
      ip: clientIp(c),
    });

    const wsOrigin = originOf(c).replace(/^http/, "ws");
    return c.json(
      {
        node_id: nodeId,
        credential,
        control_public_key: signing.publicKey,
        connect_url: `${wsOrigin}/v1/nodes/${nodeId}/connect`,
      },
      201,
    );
  })
  .get("/v1/nodes/:nodeId/connect", async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return c.json(errorBody("upgrade_required", "Expected a WebSocket upgrade"), 426);
    }
    const nodeId = c.req.param("nodeId");
    const bearer = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (!bearer) return c.json(errorBody("unauthorized", "Missing node credential"), 401);

    const [node] = await c
      .get("db")
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.id, nodeId),
          eq(nodes.credentialHash, await hashToken(bearer)),
          isNull(nodes.deletedAt),
        ),
      )
      .limit(1);
    if (!node) return c.json(errorBody("unauthorized", "Invalid node credential"), 401);

    const headers = new Headers(c.req.raw.headers);
    headers.set(NODE_ID_HEADER, nodeId);
    headers.delete("authorization");
    const stub = c.env.NODE_CONNECTION.get(c.env.NODE_CONNECTION.idFromName(nodeId));
    return stub.fetch(new Request(c.req.raw, { headers }));
  })
  .get("/install.sh", (c) => {
    const origin = originOf(c);
    // SECURITY: The origin is pasted into a shell script that runs as root.
    // WHATWG URL hosts may contain `$`, backticks, and parentheses, so only a
    // plain scheme://host[:port] is ever substituted.
    if (!isShellSafeOrigin(origin)) {
      return c.json(errorBody("invalid_request", "Unsupported control plane hostname"), 400);
    }
    c.header("content-type", "text/x-shellscript; charset=utf-8");
    c.header("cache-control", "no-store");
    return c.body(
      installScript
        .replaceAll("__CONTROL_PLANE_URL__", origin)
        .replaceAll("__AGENT_VERSION__", PINNED_AGENT_VERSION),
    );
  });
