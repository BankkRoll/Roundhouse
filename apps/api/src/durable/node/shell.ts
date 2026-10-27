/**
 * The web shell relay inside a node's `NodeConnection` (ADR 0012 "Web
 * shell", bound by ADR 0014 §15). Browser and CLI terminals connect to the
 * node's Durable Object, the only place that can talk to its agent.
 *
 * Responsibilities:
 * - accepts a terminal socket the Worker already gated (it arrives with a
 *   {@link ShellDescriptor} and no credentials), refusing it with a
 *   `SHELL_CLOSE_CODES` close when the agent is missing (4503), predates
 *   `EXEC_PROTOCOL_VERSION` (4426) or already runs
 *   `MAX_EXEC_SESSIONS_PER_NODE` sessions (4409), then sends `exec_open`;
 * - relays input: binary frames are batched every {@link INPUT_BATCH_MS}
 *   into chunks of at most `MAX_EXEC_INPUT_BYTES`, each sealed to the node's
 *   X25519 key under `execInputAad(node, session, seq)` and sent as
 *   `exec_input` with the session's next `seq` (kept in the socket
 *   attachment, so it survives hibernation); JSON text frames carry
 *   `resize` and `close`;
 * - relays the agent's `exec_opened` (as `opened`), `exec_output` (as binary
 *   frames) and `exec_exit` (as `exit`, then close 1000);
 * - ends a session on the browser leaving (no grace period), on its idle and
 *   maximum-duration limits, when the agent doesn't answer the open within
 *   {@link OPEN_TIMEOUT_MS}, when the agent's connection goes, and when a
 *   re-check (every `REALTIME_RECHECK_INTERVAL_MS`, and on demand through
 *   {@link ShellRelay.revalidate}) finds access lapsed;
 * - finishes each session's row once (`shell.closed`, see `lib/shell`).
 *
 * Every frame to the agent goes through the host's signed `send` with the
 * credential TTL.
 *
 * SECURITY: terminal input and output are never logged, stored or audited.
 * The command's arguments are never persisted either: they travel only in
 * the `exec_open` frame.
 *
 * @module
 */
import { type Db, nodes, shellSessions } from "@roundhouse/db";
import {
  type ControlMessage,
  CREDENTIAL_FRAME_TTL_MS,
  EXEC_PROTOCOL_VERSION,
  type ExecCloseReason,
  type ExecExit,
  type ExecOpened,
  type ExecOutput,
  execInputAad,
  MAX_EXEC_INPUT_BYTES,
  MAX_EXEC_SESSIONS_PER_NODE,
  sealBox,
} from "@roundhouse/protocol";
import {
  newId,
  REALTIME_RECHECK_INTERVAL_MS,
  SHELL_CLOSE_CODES,
  SHELL_MAX_CLIENT_FRAME_BYTES,
  type ShellClientMessage,
  ShellClientMessageSchema,
  type ShellCloseCode,
  type ShellExitReason,
  type ShellServerMessage,
} from "@roundhouse/shared";
import { and, eq, isNull } from "drizzle-orm";
import {
  finishShellSession,
  recheckShellAccess,
  SHELL_SESSION_HEADER,
  type ShellDescriptor,
  type ShellEndReason,
} from "../../lib/shell";

/** WebSocket tag of every terminal socket. */
export const SHELL_TAG = "shell";

/** How often buffered input is sealed and sent. */
export const INPUT_BATCH_MS = 20;

/** How long the agent has to answer `exec_open`. */
export const OPEN_TIMEOUT_MS = 15_000;

/** Input a session may buffer before its process opens; more is refused. */
const MAX_PENDING_INPUT_BYTES = 256 * 1024;

/** Tag of one session's socket. */
function sessionTag(sessionId: string): string {
  return `${SHELL_TAG}:${sessionId}`;
}

/**
 * Whether a request to the node's Durable Object is a terminal upgrade.
 * The Worker's agent route always sets the node ID header (and strips the
 * shell header), so only the shell route can produce one.
 *
 * @param request - The request the Durable Object received.
 * @param nodeIdHeader - The agent route's node ID header name.
 * @returns `true` for a shell upgrade.
 */
export function isShellUpgrade(request: Request, nodeIdHeader: string): boolean {
  return request.headers.has(SHELL_SESSION_HEADER) && !request.headers.has(nodeIdHeader);
}

/** What a terminal socket keeps across hibernation. */
interface ShellAttachment {
  kind: "shell";
  /** The descriptor without `command`, whose arguments may carry secrets. */
  d: Omit<ShellDescriptor, "command">;
  /** The `seq` of the next `exec_input`. */
  seq: number;
  opened: boolean;
  ended: boolean;
  /** The container user from `exec_opened`. */
  user: string | null;
  /** Unix ms by which `exec_opened` must arrive. */
  openBy: number;
  lastInputAt: number;
  nextRecheckAt: number;
  bytesIn: number;
  bytesOut: number;
}

/** The agent connection as the relay needs it. */
export interface ShellAgent {
  ws: WebSocket;
  protocolVersion: number;
}

/** What the relay needs from its `NodeConnection`. */
export interface ShellRelayHost {
  ctx: DurableObjectState;
  db: Db;
  /** The greeted agent socket, if one is connected. */
  agent(): ShellAgent | undefined;
  /** Signs a control frame with the key the agent pins, validates and sends it. */
  send(ws: WebSocket, message: ControlMessage): Promise<boolean>;
}

/** How {@link ShellRelay} ends a session. */
interface Ending {
  /** What the client's `exit` says. */
  reason: ShellExitReason;
  /** What the row records; `reason` when omitted. */
  rowReason?: ShellEndReason;
  exitCode?: number | null;
  message?: string;
  closeCode: ShellCloseCode;
  /** Tell the agent to stop the process first. */
  execClose?: ExecCloseReason;
}

/** Which sessions {@link ShellRelay.revalidate} re-checks; every session when empty. */
export interface ShellSocketFilter {
  projectIds?: readonly string[];
  userIds?: readonly string[];
  tokenIds?: readonly string[];
  sessionIds?: readonly string[];
  authSessionIds?: readonly string[];
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Joins byte chunks into one array. */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Accepts the upgrade only to close it, so the client learns why. */
function closedSocket(code: ShellCloseCode, reason: string, exit?: ShellServerMessage): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  if (exit) server.send(JSON.stringify(exit));
  // Close reasons are capped at 123 bytes.
  server.close(code, reason.slice(0, 120));
  return new Response(null, { status: 101, webSocket: client });
}

/** The relay of one node's shell sessions. */
export class ShellRelay {
  /** Input waiting for the next batch, by session. */
  private pending = new Map<string, Uint8Array[]>();
  private inputTimer: ReturnType<typeof setTimeout> | undefined;
  /** Serializes batches, so frames leave in `seq` order. */
  private flushing: Promise<void> = Promise.resolve();
  private nodeKey: { nodeId: string; key: string | null } | undefined;

  constructor(private readonly host: ShellRelayHost) {}

  /**
   * Whether a socket of this Durable Object is a terminal.
   *
   * @param ws - A socket of this object.
   * @returns `true` for terminal sockets, `false` for the agent's.
   */
  owns(ws: WebSocket): boolean {
    return this.host.ctx.getTags(ws).includes(SHELL_TAG);
  }

  /**
   * Accepts a gated terminal upgrade and asks the agent to start the process.
   *
   * @param request - The upgrade, carrying {@link SHELL_SESSION_HEADER}.
   * @returns The 101 response, possibly a socket that closes at once.
   */
  async accept(request: Request): Promise<Response> {
    let d: ShellDescriptor;
    try {
      d = JSON.parse(request.headers.get(SHELL_SESSION_HEADER) ?? "") as ShellDescriptor;
    } catch {
      return new Response("missing shell session", { status: 400 });
    }
    const refuse = async (
      code: ShellCloseCode,
      reason: ShellExitReason,
      message: string,
    ): Promise<Response> => {
      await this.finish(d, { reason, exitCode: null, bytesIn: 0, bytesOut: 0 });
      return closedSocket(code, message, { type: "exit", code: null, reason, message });
    };
    const agent = this.host.agent();
    if (!agent) {
      return refuse(
        SHELL_CLOSE_CODES.nodeUnavailable,
        "node_disconnected",
        "The node's agent isn't connected",
      );
    }
    if (agent.protocolVersion < EXEC_PROTOCOL_VERSION) {
      return refuse(
        SHELL_CLOSE_CODES.agentOutdated,
        "error",
        "The node's agent is too old for shells; upgrade it",
      );
    }
    if (this.live().length >= MAX_EXEC_SESSIONS_PER_NODE) {
      return refuse(
        SHELL_CLOSE_CODES.busy,
        "error",
        `The node already runs ${MAX_EXEC_SESSIONS_PER_NODE} shell sessions`,
      );
    }
    if (!(await this.encryptionKey(d.node_id))) {
      return refuse(
        SHELL_CLOSE_CODES.agentOutdated,
        "error",
        "The node has no encryption key; upgrade its agent",
      );
    }

    const { command, ...kept } = d;
    const now = Date.now();
    const { 0: client, 1: server } = new WebSocketPair();
    this.host.ctx.acceptWebSocket(server, [SHELL_TAG, sessionTag(d.session_id)]);
    const attachment: ShellAttachment = {
      kind: "shell",
      d: kept,
      seq: 0,
      opened: false,
      ended: false,
      user: null,
      openBy: now + OPEN_TIMEOUT_MS,
      lastInputAt: now,
      nextRecheckAt: now + REALTIME_RECHECK_INTERVAL_MS,
      bytesIn: 0,
      bytesOut: 0,
    };
    server.serializeAttachment(attachment);
    let sent = false;
    try {
      sent = await this.host.send(agent.ws, {
        type: "exec_open",
        ...this.header(d.node_id, now),
        session_id: d.session_id,
        workload_id: d.workload_id,
        command,
        tty: true,
        cols: d.cols,
        rows: d.rows,
        env: { TERM: d.term },
        idle_timeout_s: d.idle_timeout_s,
        max_duration_s: d.max_duration_s,
      });
    } catch (err) {
      console.error("exec_open failed", err instanceof Error ? err.name : "error");
    }
    if (!sent) {
      await this.end(server, {
        reason: "error",
        message: "Could not reach the node's agent",
        closeCode: SHELL_CLOSE_CODES.nodeUnavailable,
      });
    } else {
      await this.armAlarm();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Handles a frame from a terminal: binary input, or a JSON `resize` or
   * `close`.
   *
   * @param ws - The terminal socket.
   * @param raw - The frame.
   */
  async onClientMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const a = this.read(ws);
    if (!a || a.ended) return;
    const size = typeof raw === "string" ? raw.length : raw.byteLength;
    if (size > SHELL_MAX_CLIENT_FRAME_BYTES) {
      await this.end(ws, {
        reason: "closed",
        message: "Frame too large",
        closeCode: SHELL_CLOSE_CODES.tooBig,
        execClose: "user",
      });
      return;
    }
    if (typeof raw !== "string") {
      if (raw.byteLength) this.queueInput(ws, a, new Uint8Array(raw));
      return;
    }
    let message: ShellClientMessage | null = null;
    try {
      const parsed = ShellClientMessageSchema.safeParse(JSON.parse(raw));
      if (parsed.success) message = parsed.data;
    } catch {
      // Not JSON; refused below.
    }
    if (!message) {
      await this.end(ws, {
        reason: "closed",
        message: "Invalid message",
        closeCode: SHELL_CLOSE_CODES.policy,
        execClose: "user",
      });
      return;
    }
    if (message.type === "close") {
      await this.end(ws, {
        reason: "closed",
        closeCode: SHELL_CLOSE_CODES.normal,
        execClose: "user",
      });
      return;
    }
    const agent = this.host.agent();
    if (!agent) return;
    await this.host.send(agent.ws, {
      type: "exec_resize",
      ...this.header(a.d.node_id, Date.now()),
      session_id: a.d.session_id,
      cols: message.cols,
      rows: message.rows,
    });
  }

  /**
   * Ends the session of a terminal that disconnected. There is no resume:
   * a shell nobody watches must not keep running.
   *
   * @param ws - The terminal socket.
   */
  async onClientClose(ws: WebSocket): Promise<void> {
    if (!this.read(ws)) return;
    await this.end(ws, {
      reason: "closed",
      closeCode: SHELL_CLOSE_CODES.normal,
      execClose: "user",
    });
  }

  /**
   * Relays an agent's `exec_opened`, `exec_output` or `exec_exit`. Frames for
   * unknown or ended sessions are ignored.
   *
   * @param frame - A validated agent frame.
   */
  async onAgentFrame(frame: ExecOpened | ExecOutput | ExecExit): Promise<void> {
    const ws = this.socket(frame.session_id);
    const a = ws && this.read(ws);
    if (!ws || !a || a.ended) return;
    switch (frame.type) {
      case "exec_opened": {
        if (a.opened) return;
        const now = Date.now();
        this.write(ws, { ...a, opened: true, user: frame.user, lastInputAt: now });
        this.send(ws, {
          type: "opened",
          session_id: a.d.session_id,
          node_id: a.d.node_id,
          node_name: a.d.node_name,
          user: frame.user,
          replica: a.d.replica,
          idle_timeout_s: a.d.idle_timeout_s,
          max_duration_s: a.d.max_duration_s,
        });
        if (this.pending.has(a.d.session_id)) this.scheduleFlush();
        try {
          await this.host.db
            .update(shellSessions)
            .set({ openedAt: new Date(now), containerUser: frame.user })
            .where(and(eq(shellSessions.id, a.d.session_id), isNull(shellSessions.endedAt)));
        } catch (err) {
          console.error("shell session update failed", err instanceof Error ? err.name : "error");
        }
        return;
      }
      case "exec_output": {
        const bytes = decodeBase64(frame.data);
        this.write(ws, { ...a, bytesOut: a.bytesOut + bytes.byteLength });
        // NOTE: Workers WebSockets expose no send buffer to measure, so the
        // relay can't tell a slow client to drop output (ADR 0012's 1 MiB
        // cap); the agent's 64 frames/s cap bounds the rate instead.
        try {
          ws.send(bytes);
        } catch {
          // The client left; its close handler ends the session.
        }
        return;
      }
      case "exec_exit":
        await this.end(ws, {
          reason: frame.reason,
          exitCode: frame.exit_code,
          ...(frame.message !== undefined ? { message: frame.message } : {}),
          closeCode: SHELL_CLOSE_CODES.normal,
        });
        return;
    }
  }

  /**
   * Ends every session, e.g. when the agent's connection closed or was
   * replaced: its processes are gone, or unreachable.
   *
   * @returns Sessions ended.
   */
  async endAll(): Promise<number> {
    let ended = 0;
    for (const ws of this.live()) {
      const done = await this.end(ws, {
        reason: "node_disconnected",
        message: "The node's agent disconnected",
        closeCode: SHELL_CLOSE_CODES.nodeUnavailable,
      });
      if (done) ended++;
    }
    return ended;
  }

  /**
   * Enforces deadlines on the Durable Object's alarm: the open timeout, the
   * idle and maximum-duration limits, and the periodic access re-check.
   *
   * @param now - Current time, unix ms.
   */
  async onAlarm(now = Date.now()): Promise<void> {
    const sockets = this.live();
    if (!sockets.length) return;
    if (!this.host.agent()) {
      await this.endAll();
      return;
    }
    const due: WebSocket[] = [];
    for (const ws of sockets) {
      const a = this.read(ws)!;
      if (!a.opened && now >= a.openBy) {
        await this.end(ws, {
          reason: "timeout",
          message: "The node's agent didn't start the shell",
          closeCode: SHELL_CLOSE_CODES.nodeUnavailable,
          execClose: "shutdown",
        });
      } else if (now >= a.d.started_at + a.d.max_duration_s * 1000) {
        await this.end(ws, {
          reason: "max_duration",
          closeCode: SHELL_CLOSE_CODES.normal,
          execClose: "max_duration",
        });
      } else if (now >= a.lastInputAt + a.d.idle_timeout_s * 1000) {
        await this.end(ws, {
          reason: "idle_timeout",
          closeCode: SHELL_CLOSE_CODES.normal,
          execClose: "idle",
        });
      } else if (now >= a.nextRecheckAt) {
        due.push(ws);
      }
    }
    await this.recheck(due, now);
  }

  /**
   * Re-checks the matching sessions now and ends those whose access lapsed
   * with `revoked` (ADR 0014 §15 "Revocation").
   *
   * @param filter - Which sessions; every session when empty.
   * @returns Sessions ended.
   */
  async revalidate(filter: ShellSocketFilter = {}): Promise<number> {
    const sockets = this.live().filter((ws) => {
      const { d } = this.read(ws)!;
      const matches = (ids: readonly string[] | undefined, value: string | null) =>
        ids === undefined || (value !== null && ids.includes(value));
      return (
        matches(filter.projectIds, d.project_id) &&
        matches(filter.userIds, d.user_id) &&
        matches(filter.tokenIds, d.token_id) &&
        matches(filter.sessionIds, d.session_id) &&
        matches(filter.authSessionIds, d.auth_session_id)
      );
    });
    return this.recheck(sockets, Date.now());
  }

  /**
   * Ends one session at someone's request (`POST /v1/shell-sessions/{id}/terminate`).
   *
   * @param sessionId - `shl_…`.
   * @param actor - Who terminated it, for the `shell.closed` record.
   * @returns Whether a live session was ended.
   */
  async terminate(
    sessionId: string,
    actor: { actorType: "user" | "token"; actorId: string },
  ): Promise<boolean> {
    const ws = this.socket(sessionId);
    if (!ws || this.read(ws)?.ended !== false) return false;
    return this.end(
      ws,
      {
        reason: "revoked",
        rowReason: "terminated",
        message: "The session was terminated",
        closeCode: SHELL_CLOSE_CODES.forbidden,
        execClose: "revoked",
      },
      actor,
    );
  }

  /**
   * Open sessions, for tests and the node's session cap.
   *
   * @returns How many.
   */
  count(): number {
    return this.live().length;
  }

  /**
   * The earliest deadline of any open session, for the Durable Object's
   * alarm.
   *
   * @returns Unix ms, or `null` without open sessions.
   */
  nextDeadline(): number | null {
    let next: number | null = null;
    for (const ws of this.live()) {
      const a = this.read(ws)!;
      const candidates = [
        a.d.started_at + a.d.max_duration_s * 1000,
        a.lastInputAt + a.d.idle_timeout_s * 1000,
        a.nextRecheckAt,
        ...(a.opened ? [] : [a.openBy]),
      ];
      for (const at of candidates) if (next === null || at < next) next = at;
    }
    return next;
  }

  /**
   * Brings the alarm forward to the next session deadline; never later.
   */
  async armAlarm(): Promise<void> {
    const next = this.nextDeadline();
    if (next === null) return;
    const current = await this.host.ctx.storage.getAlarm();
    if (current === null || current > next) await this.host.ctx.storage.setAlarm(next);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private header(nodeId: string, now: number) {
    return { id: newId("message"), node_id: nodeId, iat: now, exp: now + CREDENTIAL_FRAME_TTL_MS };
  }

  private read(ws: WebSocket): ShellAttachment | null {
    const a = ws.deserializeAttachment() as ShellAttachment | null;
    return a?.kind === "shell" ? a : null;
  }

  private write(ws: WebSocket, a: ShellAttachment): void {
    ws.serializeAttachment(a);
  }

  private send(ws: WebSocket, message: ShellServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Already closed.
    }
  }

  private socket(sessionId: string): WebSocket | undefined {
    return this.host.ctx.getWebSockets(sessionTag(sessionId))[0];
  }

  /** Sessions not yet ended; a closing socket stays listed until its close completes. */
  private live(): WebSocket[] {
    return this.host.ctx.getWebSockets(SHELL_TAG).filter((ws) => this.read(ws)?.ended === false);
  }

  private async encryptionKey(nodeId: string): Promise<string | null> {
    if (this.nodeKey?.nodeId === nodeId && this.nodeKey.key) return this.nodeKey.key;
    const [row] = await this.host.db
      .select({ key: nodes.encryptionPublicKey })
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), isNull(nodes.deletedAt)))
      .limit(1);
    this.nodeKey = { nodeId, key: row?.key ?? null };
    return this.nodeKey.key;
  }

  private queueInput(ws: WebSocket, a: ShellAttachment, bytes: Uint8Array): void {
    const id = a.d.session_id;
    const chunks = this.pending.get(id) ?? [];
    chunks.push(bytes);
    this.pending.set(id, chunks);
    if (!a.opened) {
      const buffered = chunks.reduce((n, c) => n + c.byteLength, 0);
      if (buffered > MAX_PENDING_INPUT_BYTES) {
        void this.end(ws, {
          reason: "closed",
          message: "Too much input before the shell started",
          closeCode: SHELL_CLOSE_CODES.tooBig,
          execClose: "user",
        });
      }
      return;
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    this.inputTimer ??= setTimeout(() => {
      this.inputTimer = undefined;
      this.flushing = this.flushing
        .then(() => this.flushInput())
        .catch((err) => {
          console.error("shell input relay failed", err instanceof Error ? err.name : "error");
        });
    }, INPUT_BATCH_MS);
  }

  /**
   * Seals and sends every opened session's buffered input. Runs on the
   * {@link flushing} chain only, so `exec_input` frames leave in `seq` order.
   */
  private async flushInput(): Promise<void> {
    for (const [id, chunks] of [...this.pending]) {
      const ws = this.socket(id);
      const a = ws && this.read(ws);
      if (!ws || !a || a.ended) {
        this.pending.delete(id);
        continue;
      }
      if (!a.opened) continue;
      this.pending.delete(id);
      const agent = this.host.agent();
      const key = await this.encryptionKey(a.d.node_id);
      if (!agent || !key) continue;
      const data = concat(chunks);
      for (let offset = 0; offset < data.byteLength; offset += MAX_EXEC_INPUT_BYTES) {
        const chunk = data.subarray(offset, offset + MAX_EXEC_INPUT_BYTES);
        // Read, bumped and written with no await in between, so a frame
        // handled meanwhile can't overwrite the counters.
        const current = this.read(ws);
        if (!current || current.ended) break;
        const seq = current.seq;
        const now = Date.now();
        this.write(ws, {
          ...current,
          seq: seq + 1,
          bytesIn: current.bytesIn + chunk.byteLength,
          lastInputAt: now,
        });
        const sealed = await sealBox(
          key,
          JSON.stringify({ data: encodeBase64(chunk) }),
          "exec-input",
          execInputAad(a.d.node_id, id, seq),
        );
        await this.host.send(agent.ws, {
          type: "exec_input",
          ...this.header(a.d.node_id, now),
          session_id: id,
          seq,
          data_sealed: sealed,
        });
      }
    }
  }

  /** Re-checks sessions' access and ends the lapsed ones with `revoked`. */
  private async recheck(sockets: WebSocket[], now: number): Promise<number> {
    let closed = 0;
    for (const ws of sockets) {
      const a = this.read(ws);
      if (!a || a.ended) continue;
      let allowed: boolean;
      try {
        allowed = await recheckShellAccess(this.host.db, a.d, now);
      } catch (err) {
        // A failed lookup is retried at the next re-check rather than
        // ending a session on a transient error.
        console.error("shell re-check failed", err instanceof Error ? err.name : "error");
        allowed = true;
      }
      if (allowed) {
        const fresh = this.read(ws);
        if (fresh && !fresh.ended) {
          this.write(ws, { ...fresh, nextRecheckAt: now + REALTIME_RECHECK_INTERVAL_MS });
        }
        continue;
      }
      const done = await this.end(ws, {
        reason: "revoked",
        message: "Your access to this shell was revoked",
        closeCode: SHELL_CLOSE_CODES.forbidden,
        execClose: "revoked",
      });
      if (done) closed++;
    }
    await this.armAlarm();
    return closed;
  }

  /**
   * Ends a session once: tells the agent (when asked), sends the client its
   * `exit` and closes the socket, then finishes the row.
   *
   * @returns Whether this call ended it.
   */
  private async end(
    ws: WebSocket,
    ending: Ending,
    actor?: { actorType: "user" | "token"; actorId: string },
  ): Promise<boolean> {
    const a = this.read(ws);
    if (!a || a.ended) return false;
    this.write(ws, { ...a, ended: true });
    this.pending.delete(a.d.session_id);
    if (ending.execClose) {
      const agent = this.host.agent();
      if (agent && agent.protocolVersion >= EXEC_PROTOCOL_VERSION) {
        try {
          await this.host.send(agent.ws, {
            type: "exec_close",
            ...this.header(a.d.node_id, Date.now()),
            session_id: a.d.session_id,
            reason: ending.execClose,
          });
        } catch (err) {
          console.error("exec_close failed", err instanceof Error ? err.name : "error");
        }
      }
    }
    const exitCode = ending.exitCode ?? null;
    this.send(ws, {
      type: "exit",
      code: exitCode,
      reason: ending.reason,
      ...(ending.message !== undefined ? { message: ending.message } : {}),
    });
    try {
      ws.close(ending.closeCode, (ending.message ?? ending.reason).slice(0, 120));
    } catch {
      // Already closed.
    }
    const latest = this.read(ws) ?? a;
    await this.finish(
      a.d,
      {
        reason: ending.rowReason ?? ending.reason,
        exitCode,
        bytesIn: latest.bytesIn,
        bytesOut: latest.bytesOut,
        containerUser: latest.user,
      },
      actor,
    );
    return true;
  }

  private async finish(
    d: Pick<ShellDescriptor, "session_id">,
    ending: {
      reason: ShellEndReason;
      exitCode: number | null;
      bytesIn: number;
      bytesOut: number;
      containerUser?: string | null;
    },
    actor?: { actorType: "user" | "token"; actorId: string },
  ): Promise<void> {
    try {
      await finishShellSession(this.host.db, d.session_id, {
        ...ending,
        ...(actor ? { actor } : {}),
      });
    } catch (err) {
      // The minute tick ends rows left open past their maximum duration.
      console.error("shell session finish failed", err instanceof Error ? err.name : "error");
    }
  }
}
