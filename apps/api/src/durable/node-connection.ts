/**
 * One Durable Object per node. It owns the agent's WebSocket (hibernatable,
 * so idle nodes cost nothing), validates agent frames, persists heartbeat
 * snapshots, signs control frames, and detects silent nodes with an alarm.
 *
 * Only the Worker can reach this object, and it authenticates the agent
 * before forwarding the upgrade, so the node ID header is trusted here.
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import { createDb, type Db, nodes } from "@openrail/db";
import {
  type AgentMessage,
  AgentMessageSchema,
  type ControlMessage,
  type Heartbeat,
  type Hello,
  PROTOCOL_VERSION,
  signEnvelope,
} from "@openrail/protocol";
import { HEARTBEAT_INTERVAL_MS, type NodeStatus, newId, OFFLINE_AFTER_MS } from "@openrail/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Env } from "../env";
import { recordAudit } from "../lib/audit";
import { NODE_ID_HEADER } from "../lib/nodes";
import { loadSigningKey } from "../lib/settings";

/** Agent frames larger than this are rejected; heartbeats are a few hundred bytes. */
const MAX_FRAME_BYTES = 64 * 1024;

/** Signed control frames expire quickly so a captured frame can't be replayed later. */
const CONTROL_TTL_MS = 5 * 60 * 1000;

/** WebSocket close codes we use. */
export const CloseCode = {
  policy: 1008,
  tooBig: 1009,
  replaced: 4000,
  removed: 4001,
} as const;

/**
 * Heartbeats arriving faster than this are dropped. Half the interval leaves
 * room for jitter and a reconnect burst while capping D1 writes per node.
 */
const MIN_HEARTBEAT_GAP_MS = HEARTBEAT_INTERVAL_MS / 2;

/**
 * Consecutive too-fast heartbeats tolerated before the connection is closed.
 * An accepted beat resets the count, so clock jitter over a long session never
 * adds up to a disconnect.
 */
const MAX_RATE_STRIKES = 5;

/** Statuses an agent's hello or heartbeat may move to `online`. */
const AGENT_DRIVEN_STATUSES: NodeStatus[] = ["pending", "offline", "online", "degraded"];

/**
 * SET expression that marks a node online unless an operator has put it in
 * `draining` or `maintenance`, which only an operator may lift.
 */
function liveStatus() {
  return sql<NodeStatus>`CASE WHEN ${inArray(nodes.status, AGENT_DRIVEN_STATUSES)} THEN 'online' ELSE ${nodes.status} END`;
}

interface Attachment {
  nodeId: string;
  helloReceived: boolean;
  lastBeatAt: number;
  strikes: number;
}

/** Durable Object holding a single node's agent connection. */
export class NodeConnection extends DurableObject<Env> {
  private db: Db;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = createDb(env.DB);
  }

  override async fetch(request: Request): Promise<Response> {
    const nodeId = request.headers.get(NODE_ID_HEADER);
    if (!nodeId) return new Response("missing node id", { status: 400 });

    for (const ws of this.ctx.getWebSockets()) {
      ws.close(CloseCode.replaced, "superseded by a newer connection");
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      nodeId,
      helloReceived: false,
      lastBeatAt: 0,
      strikes: 0,
    } satisfies Attachment);
    // Stored now (not on hello) so the alarm can also evict a socket that
    // authenticates but never says hello.
    await this.ctx.storage.put("node_id", nodeId);
    await this.ctx.storage.setAlarm(Date.now() + OFFLINE_AFTER_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment;
    const size = typeof raw === "string" ? raw.length : raw.byteLength;
    if (size > MAX_FRAME_BYTES) return ws.close(CloseCode.tooBig, "frame too large");
    if (typeof raw !== "string") return ws.close(CloseCode.policy, "binary frames not supported");

    let message: AgentMessage;
    try {
      const parsed = AgentMessageSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return ws.close(CloseCode.policy, "invalid message");
      message = parsed.data;
    } catch {
      return ws.close(CloseCode.policy, "invalid json");
    }

    if (message.type === "hello") {
      // Each hello costs a D1 write and two signatures; one per connection is all a real agent sends.
      if (attachment.helloReceived) return ws.close(CloseCode.policy, "duplicate hello");
      if (message.node_id !== attachment.nodeId)
        return ws.close(CloseCode.policy, "node id mismatch");
      if (message.protocol_version > PROTOCOL_VERSION) {
        return ws.close(
          CloseCode.policy,
          `unsupported protocol version ${message.protocol_version}`,
        );
      }
      // Marked before the first await: a second hello arriving while D1 is
      // busy must see it, or both would pass the duplicate check.
      const greeted = { ...attachment, helloReceived: true } satisfies Attachment;
      ws.serializeAttachment(greeted);
      await this.onHello(ws, greeted, message);
      return;
    }
    if (!attachment.helloReceived) return ws.close(CloseCode.policy, "hello required first");

    // SECURITY: A leaked node credential must not be able to flood D1 with writes.
    const now = Date.now();
    if (now - attachment.lastBeatAt < MIN_HEARTBEAT_GAP_MS) {
      const strikes = attachment.strikes + 1;
      if (strikes >= MAX_RATE_STRIKES) return ws.close(CloseCode.policy, "heartbeat rate exceeded");
      ws.serializeAttachment({ ...attachment, strikes } satisfies Attachment);
      return;
    }
    ws.serializeAttachment({ ...attachment, lastBeatAt: now, strikes: 0 } satisfies Attachment);
    await this.onHeartbeat(attachment.nodeId, message);
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // Reconnects are common; let the alarm decide whether the node is really gone.
    // 1005/1006/1015 are reserved for "no status" situations and can't be sent.
    const sendable =
      code === 1000 ||
      (code >= 1001 && code <= 1004) ||
      (code >= 1007 && code <= 1014) ||
      code >= 3000;
    try {
      ws.close(sendable ? code : 1000, "closing");
    } catch {
      // Already closed by the runtime's automatic close reply.
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    ws.close(1011, "error");
  }

  override async alarm(): Promise<void> {
    const lastSeen = (await this.ctx.storage.get<number>("last_seen")) ?? 0;
    const silentFor = Date.now() - lastSeen;
    if (silentFor < OFFLINE_AFTER_MS) {
      await this.ctx.storage.setAlarm(lastSeen + OFFLINE_AFTER_MS);
      return;
    }
    const nodeId = (await this.ctx.storage.get<string>("node_id")) ?? null;
    if (!nodeId) return;
    for (const ws of this.ctx.getWebSockets()) ws.close(CloseCode.policy, "heartbeat timeout");

    const [node] = await this.db
      .update(nodes)
      .set({ status: "offline" })
      .where(
        and(
          eq(nodes.id, nodeId),
          isNull(nodes.deletedAt),
          inArray(nodes.status, ["online", "degraded", "pending"]),
        ),
      )
      .returning({ workspaceId: nodes.workspaceId });
    if (node) {
      await recordAudit(this.db, {
        workspaceId: node.workspaceId,
        actorType: "system",
        actorId: null,
        action: "node.went_offline",
        targetType: "node",
        targetId: nodeId,
        metadata: { silent_for_ms: silentFor },
      });
    }
  }

  /**
   * Closes the agent's socket. Called when a node is removed.
   *
   * @param reason - Short reason sent in the close frame.
   */
  async disconnect(reason: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(CloseCode.removed, reason);
    await this.ctx.storage.deleteAll();
  }

  private async onHello(ws: WebSocket, attachment: Attachment, hello: Hello): Promise<void> {
    const now = Date.now();
    const [node] = await this.db
      .update(nodes)
      .set({
        status: liveStatus(),
        os: hello.os,
        arch: hello.arch,
        kernel: hello.kernel,
        dockerVersion: hello.docker_version,
        agentVersion: hello.agent_version,
        capabilities: hello.capabilities,
        cpuTotal: hello.hardware.cpu_cores,
        memTotal: hello.hardware.mem_bytes,
        diskTotal: hello.hardware.disk_bytes,
        observedGeneration: hello.observed_generation,
        lastHeartbeatAt: new Date(now),
      })
      .where(and(eq(nodes.id, attachment.nodeId), isNull(nodes.deletedAt)))
      .returning({ desiredGeneration: nodes.desiredGeneration });
    if (!node) return ws.close(CloseCode.removed, "node removed");

    await this.ctx.storage.put({ node_id: attachment.nodeId, last_seen: now });
    await this.ctx.storage.setAlarm(now + OFFLINE_AFTER_MS);

    await this.send(ws, {
      type: "welcome",
      ...this.header(attachment.nodeId, now),
      heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
    });
    // TODO(phase-1): populate workloads from placements once deployments exist.
    await this.send(ws, {
      type: "desired_state",
      ...this.header(attachment.nodeId, now),
      generation: node.desiredGeneration,
      workloads: [],
    });
  }

  private async onHeartbeat(nodeId: string, hb: Heartbeat): Promise<void> {
    const now = Date.now();
    await this.db
      .update(nodes)
      .set({
        status: liveStatus(),
        cpuPercent: hb.usage.cpu_percent,
        memUsed: hb.usage.mem_used_bytes,
        memTotal: hb.usage.mem_total_bytes,
        diskUsed: hb.usage.disk_used_bytes,
        diskTotal: hb.usage.disk_total_bytes,
        load1: hb.usage.load1,
        observedGeneration: hb.observed_generation,
        lastHeartbeatAt: new Date(now),
      })
      .where(and(eq(nodes.id, nodeId), isNull(nodes.deletedAt)));
    await this.ctx.storage.put("last_seen", now);
    await this.ctx.storage.setAlarm(now + OFFLINE_AFTER_MS);

    this.env.METRICS?.writeDataPoint({
      indexes: [nodeId],
      blobs: [nodeId, "node"],
      doubles: [
        hb.usage.cpu_percent,
        hb.usage.mem_used_bytes,
        hb.usage.mem_total_bytes,
        hb.usage.disk_used_bytes,
        hb.usage.disk_total_bytes,
        hb.usage.load1,
      ],
    });
  }

  private header(nodeId: string, now: number) {
    return { id: newId("message"), node_id: nodeId, iat: now, exp: now + CONTROL_TTL_MS };
  }

  private async send(ws: WebSocket, message: ControlMessage): Promise<void> {
    const masterKey = this.env.MASTER_KEY;
    if (!masterKey) return ws.close(1011, "control plane misconfigured");
    const key = await loadSigningKey(this.db, masterKey.trim());
    ws.send(JSON.stringify(await signEnvelope(message, key.privateKey, key.kid)));
  }
}
