/**
 * One Durable Object per project: the dashboard's realtime socket at
 * `/v1/projects/{projectId}/realtime`.
 *
 * Responsibilities:
 * - holds browsers' WebSockets (hibernatable, so an idle project page costs
 *   nothing) and caps how many each user may open;
 * - tracks per-socket log subscriptions (`subscribe` / `unsubscribe`) and
 *   replays a topic's recent lines to a new subscriber, since stored pages
 *   lag live lines by the node's flush delay;
 * - fans out `deployment.updated`, `deployment.event`, `service.updated` and
 *   `presence` to every socket, and `log.lines` only to subscribers;
 * - lists only browser sessions in `presence`: CLI sockets and API tokens
 *   watch without being shown;
 * - re-checks every socket's session or token, membership and project once
 *   a minute (an alarm), closing it with 4401, 4403 or 4404 when one lapses;
 * - buffers outgoing messages per socket with a byte bound, dropping the
 *   oldest log lines first, so a slow browser can't pin memory.
 *
 * Only the Worker reaches this object, after checking the session, workspace
 * membership and Origin, so the identity headers are trusted here.
 *
 * @module
 */
import { DurableObject } from "cloudflare:workers";
import {
  apiTokens,
  createDb,
  projects,
  sessions,
  workspaceMembers,
  workspaces,
} from "@openrail/db";
import type { LogLine, LogSource } from "@openrail/protocol";
import { REALTIME_CLOSE_CODES, REALTIME_RECHECK_INTERVAL_MS } from "@openrail/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Env } from "../env";
import {
  type RealtimeClientMessage,
  RealtimeClientMessageSchema,
  type RealtimeServerMessage,
} from "../schemas";

/** Header carrying the authenticated viewer as JSON (`RoomViewer`). */
export const ROOM_VIEWER_HEADER = "x-openrail-viewer";

/** Sockets one user may hold open on one project (tabs, windows). */
export const MAX_SOCKETS_PER_USER = 8;

/** Sockets a project may hold open in total. */
export const MAX_SOCKETS_PER_ROOM = 256;

/** Log topics one socket may subscribe to at once. */
export const MAX_SUBSCRIPTIONS = 32;

/** Largest browser → server frame; client messages are tiny. */
const MAX_CLIENT_FRAME_BYTES = 4096;

/** Pending outgoing bytes per socket before old log batches are dropped. */
export const MAX_QUEUED_BYTES = 512 * 1024;

/**
 * Recent log lines kept per topic for replay on subscribe. A node's Durable
 * Object writes lines to R2 up to a couple of seconds after it forwards them
 * live, so a viewer that loads the stored page and then subscribes would
 * miss lines from that gap; the replay covers it, and clients drop the
 * duplicates it carries.
 */
export const REPLAY_LINES_PER_TOPIC = 200;

/** Byte cap of one topic's replay buffer (line text). */
const REPLAY_BYTES_PER_TOPIC = 64 * 1024;

/** Topics with a replay buffer; the least recently written is evicted. */
const REPLAY_TOPICS = 64;

/** How often queued messages are flushed. Coalesces bursts of log frames. */
const FLUSH_INTERVAL_MS = 50;

/** WebSocket close codes this object uses; see `REALTIME_CLOSE_CODES`. */
export const RoomCloseCode = REALTIME_CLOSE_CODES;

/** The authenticated caller behind a socket, as checked by the Worker. */
export interface RoomViewer {
  user_id: string;
  name: string;
  image: string | null;
  workspace_id: string;
  project_id: string;
  /** Better Auth session the socket was opened with; `null` for a token. */
  session_id: string | null;
  /** API token the socket was opened with; `null` for a session. */
  token_id: string | null;
  /** Whether the viewer appears in `presence` (browser sessions only). */
  presence: boolean;
}

/** Why a re-check closes a socket, as a close code and reason. */
type Lapse = { code: number; reason: string } | null;

interface Attachment {
  viewer: RoomViewer;
  /** `deployment_logs:<id>` or `build_logs:<id>`. */
  topics: string[];
}

type LogLinesMessage = Extract<RealtimeServerMessage, { type: "log.lines" }>;

/** Recent batches of one topic, oldest first. */
interface Replay {
  batches: LogLinesMessage[];
  lines: number;
  bytes: number;
}

interface Queue {
  messages: { data: string; droppable: boolean }[];
  bytes: number;
}

function topicKey(topic: RealtimeClientMessage["topic"]): string {
  return topic.kind === "deployment_logs"
    ? `deployment_logs:${topic.deployment_id}`
    : `build_logs:${topic.build_id}`;
}

/** Durable Object fanning project updates out to browsers. */
export class ProjectRoom extends DurableObject<Env> {
  private queues = new Map<WebSocket, Queue>();
  /** By topic key; in memory only, so hibernation forgets it (nothing to replay then). */
  private replays = new Map<string, Replay>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  override async fetch(request: Request): Promise<Response> {
    let viewer: RoomViewer;
    try {
      viewer = JSON.parse(request.headers.get(ROOM_VIEWER_HEADER) ?? "") as RoomViewer;
    } catch {
      return new Response("missing viewer", { status: 400 });
    }
    if (this.ctx.getWebSockets(viewer.user_id).length >= MAX_SOCKETS_PER_USER) {
      return Response.json(
        {
          error: {
            code: "rate_limited",
            message: `At most ${MAX_SOCKETS_PER_USER} realtime connections per user`,
          },
        },
        { status: 429 },
      );
    }
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS_PER_ROOM) {
      return Response.json(
        { error: { code: "rate_limited", message: "Too many realtime connections" } },
        { status: 429 },
      );
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [viewer.user_id]);
    server.serializeAttachment({ viewer, topics: [] } satisfies Attachment);
    if (viewer.presence) this.sendPresence();
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + REALTIME_RECHECK_INTERVAL_MS);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Re-checks every open socket. A socket outlives the session, token and
   * membership checked at upgrade, so without this a signed-out or removed
   * user would keep receiving deployment updates.
   */
  override async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const verdicts = new Map<string, Promise<Lapse>>();
    let closed = 0;
    for (const ws of sockets) {
      const { viewer } = ws.deserializeAttachment() as Attachment;
      const key = JSON.stringify([viewer.session_id, viewer.token_id, viewer.user_id]);
      let verdict = verdicts.get(key);
      if (!verdict) {
        verdict = this.recheck(viewer);
        verdicts.set(key, verdict);
      }
      const lapse = await verdict;
      if (!lapse) continue;
      closed++;
      this.queues.delete(ws);
      try {
        ws.close(lapse.code, lapse.reason);
      } catch {
        // Already closed.
      }
    }
    if (closed) this.sendPresence();
    // Sockets closed above still count in getWebSockets() until their close completes.
    if (sockets.length > closed) {
      await this.ctx.storage.setAlarm(Date.now() + REALTIME_RECHECK_INTERVAL_MS);
    }
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const size = typeof raw === "string" ? raw.length : raw.byteLength;
    if (size > MAX_CLIENT_FRAME_BYTES) return ws.close(RoomCloseCode.tooBig, "frame too large");
    if (typeof raw !== "string")
      return ws.close(RoomCloseCode.policy, "binary frames not supported");
    let message: RealtimeClientMessage;
    try {
      const parsed = RealtimeClientMessageSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return ws.close(RoomCloseCode.policy, "invalid message");
      message = parsed.data;
    } catch {
      return ws.close(RoomCloseCode.policy, "invalid json");
    }
    const attachment = ws.deserializeAttachment() as Attachment;
    const key = topicKey(message.topic);
    if (message.type === "unsubscribe") {
      attachment.topics = attachment.topics.filter((t) => t !== key);
      ws.serializeAttachment(attachment);
      return;
    }
    // SECURITY: A socket outlives the membership checked at upgrade. Each
    // subscription re-checks it, so a removed member stops getting logs at
    // once rather than at the next alarm.
    if (!(await this.stillMember(attachment.viewer))) {
      return ws.close(RoomCloseCode.forbidden, "no longer a member");
    }
    if (attachment.topics.includes(key)) return;
    if (attachment.topics.length >= MAX_SUBSCRIPTIONS) {
      return ws.close(RoomCloseCode.policy, "too many subscriptions");
    }
    attachment.topics.push(key);
    ws.serializeAttachment(attachment);
    for (const batch of this.replays.get(key)?.batches ?? []) {
      this.enqueue(ws, JSON.stringify(batch), true);
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.queues.delete(ws);
    const sendable = code === 1000 || (code >= 3000 && code <= 4999);
    try {
      ws.close(sendable ? code : 1000, "closing");
    } catch {
      // Already closed.
    }
    this.sendPresence(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.queues.delete(ws);
    try {
      ws.close(1011, "error");
    } catch {
      // Already closed.
    }
    this.sendPresence(ws);
  }

  /**
   * Fans a message out: `log.lines` to sockets subscribed to its source,
   * everything else to every socket.
   *
   * @param message - A server → browser message.
   */
  async broadcast(message: RealtimeServerMessage): Promise<void> {
    let topic: string | null = null;
    if (message.type === "log.lines") {
      topic =
        message.source.type === "runtime"
          ? `deployment_logs:${message.source.deployment_id}`
          : `build_logs:${message.source.build_id}`;
    }
    if (topic && message.type === "log.lines") this.remember(topic, message);
    const data = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      if (topic) {
        const { topics } = ws.deserializeAttachment() as Attachment;
        if (!topics.includes(topic)) continue;
      }
      this.enqueue(ws, data, topic !== null);
    }
  }

  /**
   * Forwards log lines ingested by a node's Durable Object.
   *
   * @param serviceId - Service the lines belong to.
   * @param source - Runtime or build source from the agent frame.
   * @param lines - Lines, already redacted.
   */
  async publishLogs(serviceId: string, source: LogSource, lines: LogLine[]): Promise<void> {
    await this.broadcast({
      type: "log.lines",
      source:
        source.type === "runtime"
          ? {
              type: "runtime",
              service_id: serviceId,
              deployment_id: source.deployment_id,
              workload_id: source.workload_id,
            }
          : { type: "build", service_id: serviceId, build_id: source.build_id },
      lines: lines.map((l) => ({ ts: l.ts, stream: l.stream, text: l.text })),
    });
  }

  /**
   * Number of open sockets, for tests and diagnostics.
   *
   * @returns Open socket count.
   */
  async connectionCount(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }

  /** Adds a batch to its topic's replay buffer, trimming the oldest batches past the caps. */
  private remember(topic: string, message: LogLinesMessage): void {
    let replay = this.replays.get(topic);
    if (replay) this.replays.delete(topic);
    replay ??= { batches: [], lines: 0, bytes: 0 };
    // Re-inserted so map order is least recently written first.
    this.replays.set(topic, replay);
    replay.batches.push(message);
    replay.lines += message.lines.length;
    replay.bytes += message.lines.reduce((sum, l) => sum + l.text.length, 0);
    while (
      replay.batches.length > 1 &&
      (replay.lines > REPLAY_LINES_PER_TOPIC || replay.bytes > REPLAY_BYTES_PER_TOPIC)
    ) {
      const dropped = replay.batches.shift()!;
      replay.lines -= dropped.lines.length;
      replay.bytes -= dropped.lines.reduce((sum, l) => sum + l.text.length, 0);
    }
    while (this.replays.size > REPLAY_TOPICS) {
      this.replays.delete(this.replays.keys().next().value!);
    }
  }

  /** Checks a viewer's credential, membership and project, in that order. */
  private async recheck(viewer: RoomViewer, now = Date.now()): Promise<Lapse> {
    const db = createDb(this.env.DB);
    if (viewer.session_id) {
      const [session] = await db
        .select({ expiresAt: sessions.expiresAt })
        .from(sessions)
        .where(and(eq(sessions.id, viewer.session_id), eq(sessions.userId, viewer.user_id)))
        .limit(1);
      if (!session || +session.expiresAt <= now) {
        return { code: RoomCloseCode.unauthorized, reason: "session expired" };
      }
    } else if (viewer.token_id) {
      const [token] = await db
        .select({ revokedAt: apiTokens.revokedAt, expiresAt: apiTokens.expiresAt })
        .from(apiTokens)
        .where(eq(apiTokens.id, viewer.token_id))
        .limit(1);
      if (!token || token.revokedAt || (token.expiresAt && +token.expiresAt <= now)) {
        return { code: RoomCloseCode.unauthorized, reason: "token revoked or expired" };
      }
    } else {
      return { code: RoomCloseCode.unauthorized, reason: "no credential" };
    }
    if (!(await this.stillMember(viewer))) {
      return { code: RoomCloseCode.forbidden, reason: "no longer a member" };
    }
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
      .where(
        and(
          eq(projects.id, viewer.project_id),
          isNull(projects.deletedAt),
          isNull(workspaces.deletedAt),
        ),
      )
      .limit(1);
    if (!project) return { code: RoomCloseCode.notFound, reason: "project deleted" };
    return null;
  }

  private async stillMember(viewer: RoomViewer): Promise<boolean> {
    const row = await createDb(this.env.DB)
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, viewer.workspace_id),
          eq(workspaceMembers.userId, viewer.user_id),
        ),
      )
      .limit(1);
    return row.length > 0;
  }

  private sendPresence(except?: WebSocket): void {
    const users = new Map<string, { user_id: string; name: string; image: string | null }>();
    const sockets = this.ctx.getWebSockets().filter((ws) => ws !== except);
    for (const ws of sockets) {
      const { viewer } = ws.deserializeAttachment() as Attachment;
      if (!viewer.presence) continue;
      users.set(viewer.user_id, {
        user_id: viewer.user_id,
        name: viewer.name,
        image: viewer.image,
      });
    }
    const data = JSON.stringify({
      type: "presence",
      users: [...users.values()].sort((a, b) => (a.user_id < b.user_id ? -1 : 1)),
    } satisfies RealtimeServerMessage);
    for (const ws of sockets) this.enqueue(ws, data, false);
  }

  private enqueue(ws: WebSocket, data: string, droppable: boolean): void {
    let queue = this.queues.get(ws);
    if (!queue) {
      queue = { messages: [], bytes: 0 };
      this.queues.set(ws, queue);
    }
    queue.messages.push({ data, droppable });
    queue.bytes += data.length;
    // Drop the oldest log batches first; status messages are small and the
    // dashboard can't recover them without a refetch.
    while (queue.bytes > MAX_QUEUED_BYTES) {
      const index = queue.messages.findIndex((m) => m.droppable);
      if (index === -1) break;
      queue.bytes -= queue.messages[index]!.data.length;
      queue.messages.splice(index, 1);
    }
    this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  private flush(): void {
    this.flushTimer = undefined;
    for (const [ws, queue] of this.queues) {
      for (const m of queue.messages) {
        try {
          ws.send(m.data);
        } catch {
          break;
        }
      }
      queue.messages = [];
      queue.bytes = 0;
    }
    this.queues.clear();
  }
}
