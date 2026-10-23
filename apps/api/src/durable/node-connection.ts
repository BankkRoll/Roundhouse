/**
 * One Durable Object per node. It owns the agent's WebSocket (hibernatable,
 * so idle nodes cost nothing) and is the control plane's only channel to it.
 *
 * Responsibilities:
 * - validate every agent frame against the protocol schemas, with size and
 *   per-type rate limits, and close agents below `MIN_PROTOCOL_VERSION`
 *   with `agent_outdated`;
 * - register the signed `hello.encryption_key` of a node that joined
 *   without one (only while it has none);
 * - persist heartbeat snapshots and detect silent nodes with an alarm;
 * - apply `workload_status` (and `hello.statuses`) to placements, move
 *   deployments between `active` and `crashed`, and wake deploy workflows;
 * - record `build_result`s and wake the waiting workflow;
 * - redact (with each deployment's frozen secret set and its encodings),
 *   store (R2 + `log_chunks`) and forward `logs` to the project
 *   room, flushing on the Durable Object's alarm and dropping lines whose
 *   deployment or build no longer exists;
 * - sign and send control frames: `welcome`, `desired_state` (always
 *   computed from D1, so a reconnect gets the truth), `build_job` and
 *   `build_cancel`, never sending a frame or field to an agent whose
 *   protocol version predates it (workloads and builds need
 *   `SEALED_ENV_PROTOCOL_VERSION`), and giving credential-carrying frames at
 *   most `CREDENTIAL_FRAME_TTL_MS`.
 *
 * Only the Worker can reach this object, and it authenticates the agent
 * before forwarding the upgrade, so the node ID header is trusted here.
 *
 * @module
 */

import { DurableObject } from "cloudflare:workers";
import {
  builds,
  createDb,
  type Db,
  deployments,
  logChunks,
  nodes,
  placements,
  services,
} from "@roundhouse/db";
import {
  type AgentMessage,
  AgentMessageSchema,
  BUILD_CANCEL_PROTOCOL_VERSION,
  type BuildJob,
  type BuildResult,
  type ControlMessage,
  ControlMessageSchema,
  CREDENTIAL_FRAME_TTL_MS,
  carriesCredentials,
  type Heartbeat,
  type Hello,
  type LogLine,
  type Logs,
  MAX_AGENT_FRAME_BYTES,
  MAX_CONTROL_FRAME_BYTES,
  MIN_PROTOCOL_VERSION,
  type NodeEncryptionKey,
  PROTOCOL_VERSION,
  SEALED_ENV_PROTOCOL_VERSION,
  SECRET_BUILD_ARGS_PROTOCOL_VERSION,
  signEnvelope,
  verifyNodeEncryptionKey,
  WORKLOADS_PROTOCOL_VERSION,
  type WorkloadState,
  type WorkloadStatusReport,
} from "@roundhouse/protocol";
import {
  HEARTBEAT_INTERVAL_MS,
  type NodeStatus,
  newId,
  OFFLINE_AFTER_MS,
  redact,
} from "@roundhouse/shared";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Env } from "../env";
import { recordAudit } from "../lib/audit";
import {
  addDeploymentEvent,
  IllegalTransitionError,
  transitionDeployment,
  wakeWorkflow,
} from "../lib/deployments";
import { buildDesiredState } from "../lib/desired-state";
import { deploymentRedaction, logChunkKey, type StoredLogLine, toNdjson } from "../lib/logs";
import { NODE_ID_HEADER } from "../lib/nodes";
import { projectRoom } from "../lib/realtime";
import { loadSigningKey } from "../lib/settings";

/** Signed control frames expire quickly so a captured frame can't be replayed later. */
const CONTROL_TTL_MS = 5 * 60 * 1000;

/** WebSocket close codes we use. */
export const CloseCode = {
  policy: 1008,
  tooBig: 1009,
  replaced: 4000,
  removed: 4001,
  /** `agent_outdated`: the agent is below `MIN_PROTOCOL_VERSION` and must be upgraded (ADR 0013). */
  agentOutdated: 4002,
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

/**
 * Frames of each type accepted per {@link RATE_WINDOW_MS}. An agent flushes
 * logs once a second per source and reports statuses on change, so these
 * leave headroom for a node running `MAX_WORKLOADS_PER_NODE` replicas.
 */
export const FRAME_RATE_LIMITS = {
  workload_status: 64,
  logs: 256,
  build_result: 8,
} as const;

/** Window of {@link FRAME_RATE_LIMITS}. */
const RATE_WINDOW_MS = 1000;

/** Frames over the limit dropped in one connection before it is closed. */
const MAX_DROPPED_FRAMES = 200;

/** Buffered log bytes for one source before it is flushed to R2. */
const LOG_FLUSH_BYTES = 256 * 1024;

/** How long log lines may sit in memory before they are flushed to R2. */
const LOG_FLUSH_DELAY_MS = 2000;

/**
 * How long log-source lookups, and the redaction sets of deployments from
 * before frozen secret sets, are reused.
 */
const LOOKUP_TTL_MS = 30_000;

/** Deployments whose redaction sets one Durable Object keeps in memory. */
const REDACTION_CACHE_LIMIT = 256;

/** Statuses an agent's hello or heartbeat may move to `online`. */
const AGENT_DRIVEN_STATUSES: NodeStatus[] = ["pending", "offline", "online", "degraded"];

/** Replica states that mean a deployment is not (or no longer) serving. */
const BAD_STATES: readonly WorkloadState[] = ["unhealthy", "crashed", "exited"];

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
  protocolVersion: number;
  lastBeatAt: number;
  strikes: number;
  windowStart: number;
  counts: Partial<Record<keyof typeof FRAME_RATE_LIMITS, number>>;
  dropped: number;
}

/** Where a log source's lines belong. */
interface LogOwner {
  projectId: string;
  serviceId: string;
  environmentId: string;
  deploymentId: string | null;
  buildId: string | null;
  /** Deployment whose frozen secret set redacts the lines (a build's own, for build logs). */
  redactionDeploymentId: string;
}

interface LogBuffer {
  owner: LogOwner;
  lines: StoredLogLine[];
  bytes: number;
}

/** Fields a caller supplies for a build job; the header is added when sent. */
export type BuildJobBody = Omit<BuildJob, "id" | "node_id" | "iat" | "exp" | "type">;

/**
 * Why {@link NodeConnection.sendBuildJob} could not deliver: no agent, an
 * agent that runs no builds, or one that would ignore `secret_build_args`
 * and bake the values into the image.
 */
export type BuildJobRejection =
  | "not_connected"
  | "protocol_too_old"
  | "secret_build_args_unsupported";

/** Why {@link NodeConnection.sendBuildCancel} could not deliver. */
export type BuildCancelRejection = "not_connected" | "protocol_too_old";

/** Whether a D1 error is a failed foreign key check. */
function isForeignKeyViolation(err: unknown): boolean {
  for (let e: unknown = err; e instanceof Error; e = e.cause) {
    if (/FOREIGN KEY constraint failed/i.test(e.message)) return true;
  }
  return false;
}

/** Durable Object holding a single node's agent connection. */
export class NodeConnection extends DurableObject<Env> {
  private db: Db;
  private logBuffers = new Map<string, LogBuffer>();
  private owners = new Map<string, { owner: LogOwner | null; at: number }>();
  private redactionSets = new Map<string, { needles: string[]; expires: number }>();

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
      protocolVersion: 0,
      lastBeatAt: 0,
      strikes: 0,
      windowStart: 0,
      counts: {},
      dropped: 0,
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
    if (size > MAX_AGENT_FRAME_BYTES) return ws.close(CloseCode.tooBig, "frame too large");
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
      if (message.protocol_version < MIN_PROTOCOL_VERSION) {
        return ws.close(CloseCode.agentOutdated, "agent_outdated");
      }
      if (message.protocol_version > PROTOCOL_VERSION) {
        return ws.close(
          CloseCode.policy,
          `unsupported protocol version ${message.protocol_version}`,
        );
      }
      // Marked before the first await: a second hello arriving while D1 is
      // busy must see it, or both would pass the duplicate check.
      const greeted = {
        ...attachment,
        helloReceived: true,
        protocolVersion: message.protocol_version,
      } satisfies Attachment;
      ws.serializeAttachment(greeted);
      await this.onHello(ws, greeted, message);
      return;
    }
    if (!attachment.helloReceived) return ws.close(CloseCode.policy, "hello required first");

    if (message.type === "heartbeat") {
      // SECURITY: A leaked node credential must not be able to flood D1 with writes.
      const now = Date.now();
      if (now - attachment.lastBeatAt < MIN_HEARTBEAT_GAP_MS) {
        const strikes = attachment.strikes + 1;
        if (strikes >= MAX_RATE_STRIKES)
          return ws.close(CloseCode.policy, "heartbeat rate exceeded");
        ws.serializeAttachment({ ...attachment, strikes } satisfies Attachment);
        return;
      }
      ws.serializeAttachment({ ...attachment, lastBeatAt: now, strikes: 0 } satisfies Attachment);
      await this.onHeartbeat(attachment.nodeId, message);
      return;
    }

    // Workload frames are a version 2 feature; an older agent has none to send.
    if (attachment.protocolVersion < WORKLOADS_PROTOCOL_VERSION) return;
    if (!this.admit(ws, attachment, message.type)) return;
    switch (message.type) {
      case "workload_status":
        await this.applyStatuses(attachment.nodeId, [message]);
        return;
      case "build_result":
        await this.onBuildResult(attachment.nodeId, message);
        return;
      case "logs":
        await this.onLogs(attachment.nodeId, message);
        return;
    }
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
    await this.flushLogs();
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    ws.close(1011, "error");
  }

  override async alarm(): Promise<void> {
    // The alarm doubles as the log flush timer, so buffered lines go out
    // whichever deadline it fired for.
    await this.flushLogs();
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

  // ---------------------------------------------------------------------------
  // RPC
  // ---------------------------------------------------------------------------

  /**
   * Closes the agent's socket. Called when a node is removed.
   *
   * @param reason - Short reason sent in the close frame.
   */
  async disconnect(reason: string): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(CloseCode.removed, reason);
    await this.ctx.storage.deleteAll();
  }

  /**
   * Recomputes the node's desired state from D1 and sends it, if the agent
   * is connected. Callers bump `desired_generation` first.
   *
   * @returns Whether a frame was sent.
   */
  async pushDesiredState(): Promise<boolean> {
    const ws = this.greetedSocket();
    if (!ws) return false;
    const { nodeId } = ws.deserializeAttachment() as Attachment;
    return this.sendDesiredState(ws, nodeId);
  }

  /**
   * Signs and sends a `build_job`. Its `exp` is at most
   * `CREDENTIAL_FRAME_TTL_MS` after issue whether or not it carries a token.
   *
   * @param job - Job fields.
   * @returns `{ sent: true }`, or why the job could not be delivered.
   */
  async sendBuildJob(
    job: BuildJobBody,
  ): Promise<{ sent: true } | { sent: false; reason: BuildJobRejection }> {
    const ws = this.greetedSocket();
    if (!ws) return { sent: false, reason: "not_connected" };
    const attachment = ws.deserializeAttachment() as Attachment;
    if (attachment.protocolVersion < SEALED_ENV_PROTOCOL_VERSION) {
      return { sent: false, reason: "protocol_too_old" };
    }
    if (
      job.secret_build_args?.length &&
      attachment.protocolVersion < SECRET_BUILD_ARGS_PROTOCOL_VERSION
    ) {
      // SECURITY: an older agent ignores the field and would pass the
      // values as plain build args, recorded in the image's history.
      return { sent: false, reason: "secret_build_args_unsupported" };
    }
    const now = Date.now();
    await this.send(ws, {
      type: "build_job",
      ...this.header(attachment.nodeId, now, CREDENTIAL_FRAME_TTL_MS),
      ...job,
    });
    return { sent: true };
  }

  /**
   * Signs and sends a `build_cancel`, so the builder stops the build and is
   * free for the next one. Agents below `BUILD_CANCEL_PROTOCOL_VERSION`
   * would drop the frame, so it is not sent to them.
   *
   * @param buildId - The build to stop.
   * @returns `{ sent: true }`, or why the cancel could not be delivered.
   */
  async sendBuildCancel(
    buildId: string,
  ): Promise<{ sent: true } | { sent: false; reason: BuildCancelRejection }> {
    const ws = this.greetedSocket();
    if (!ws) return { sent: false, reason: "not_connected" };
    const attachment = ws.deserializeAttachment() as Attachment;
    if (attachment.protocolVersion < BUILD_CANCEL_PROTOCOL_VERSION) {
      return { sent: false, reason: "protocol_too_old" };
    }
    await this.send(ws, {
      type: "build_cancel",
      ...this.header(attachment.nodeId, Date.now()),
      build_id: buildId,
    });
    return { sent: true };
  }

  /**
   * Writes every buffered log line to R2 now. Called by the alarm, when a
   * buffer fills, and when the socket closes; exposed for tests.
   */
  async flushLogs(): Promise<void> {
    const buffers = [...this.logBuffers.values()];
    this.logBuffers.clear();
    for (const b of buffers) await this.writeChunk(b);
  }

  // ---------------------------------------------------------------------------
  // Frames
  // ---------------------------------------------------------------------------

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
        protocolVersion: hello.protocol_version,
        capabilities: hello.capabilities,
        cpuTotal: hello.hardware.cpu_cores,
        memTotal: hello.hardware.mem_bytes,
        diskTotal: hello.hardware.disk_bytes,
        observedGeneration: hello.observed_generation,
        lastHeartbeatAt: new Date(now),
      })
      .where(and(eq(nodes.id, attachment.nodeId), isNull(nodes.deletedAt)))
      .returning({
        id: nodes.id,
        workspaceId: nodes.workspaceId,
        identityPublicKey: nodes.identityPublicKey,
        encryptionPublicKey: nodes.encryptionPublicKey,
      });
    if (!node) return ws.close(CloseCode.removed, "node removed");
    // Registered before the desired state below is computed, so a node that
    // just gained a key gets its workloads in this very frame.
    if (
      hello.encryption_key &&
      node.encryptionPublicKey === null &&
      hello.protocol_version >= SEALED_ENV_PROTOCOL_VERSION
    ) {
      await this.registerEncryptionKey(node, hello.encryption_key);
    }

    await this.ctx.storage.put({ node_id: attachment.nodeId, last_seen: now });
    await this.ctx.storage.setAlarm(now + OFFLINE_AFTER_MS);

    await this.send(ws, {
      type: "welcome",
      ...this.header(attachment.nodeId, now),
      heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
    });
    await this.sendDesiredState(ws, attachment.nodeId);
    if (hello.statuses?.length && hello.protocol_version >= WORKLOADS_PROTOCOL_VERSION) {
      await this.applyStatuses(attachment.nodeId, hello.statuses);
    }
  }

  /**
   * Stores the X25519 key a node that joined without one sends in
   * `hello.encryption_key`, once it verifies against the identity key the
   * node registered at join.
   *
   * SECURITY: a key is stored only while the node has none (the update is
   * conditional, so two racing hellos can't both win). Replacing a key needs
   * a re-join: a stolen node credential alone must not be able to swap in an
   * attacker's key and receive the node's secrets (ADR 0014, "Keys").
   *
   * @param node - The node's row as `onHello` updated it.
   * @param key - The signed key from hello.
   */
  private async registerEncryptionKey(
    node: { id: string; workspaceId: string; identityPublicKey: string },
    key: NodeEncryptionKey,
  ): Promise<void> {
    if (!(await verifyNodeEncryptionKey(node.identityPublicKey, node.id, key))) {
      console.warn(`node ${node.id}: hello.encryption_key does not verify; ignoring it`);
      return;
    }
    const [stored] = await this.db
      .update(nodes)
      .set({
        encryptionPublicKey: key.public_key,
        encryptionKeyId: key.kid,
        encryptionKeyRegisteredAt: new Date(),
      })
      .where(and(eq(nodes.id, node.id), isNull(nodes.deletedAt), isNull(nodes.encryptionPublicKey)))
      .returning({ id: nodes.id });
    if (!stored) return;
    await recordAudit(this.db, {
      workspaceId: node.workspaceId,
      actorType: "node",
      actorId: node.id,
      action: "node.encryption_key_registered",
      targetType: "node",
      targetId: node.id,
      metadata: { kid: key.kid, source: "hello" },
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

  /**
   * Applies status reports to this node's placements, then re-evaluates each
   * affected deployment once.
   */
  private async applyStatuses(nodeId: string, reports: readonly WorkloadStatusReport[]) {
    const touched = new Set<string>();
    for (const r of reports) {
      // System workloads have no placement.
      if (!r.deployment_id) continue;
      // SECURITY: Scoped to this node's placements, so an agent can only
      // report on replicas it was asked to run. Older reports never
      // overwrite newer ones.
      const [row] = await this.db
        .update(placements)
        .set({
          state: r.state,
          ...(r.container_id ? { containerId: r.container_id } : {}),
          lastStatusAt: new Date(r.ts),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(placements.workloadId, r.workload_id),
            eq(placements.nodeId, nodeId),
            eq(placements.deploymentId, r.deployment_id),
            or(isNull(placements.lastStatusAt), lte(placements.lastStatusAt, new Date(r.ts))),
          ),
        )
        .returning({ deploymentId: placements.deploymentId, replica: placements.replica });
      if (!row) continue;
      touched.add(row.deploymentId);
      await this.onReplicaStatus(row.deploymentId, row.replica, r);
    }
    for (const deploymentId of touched) await this.evaluateDeployment(deploymentId);
  }

  private async deploymentContext(deploymentId: string) {
    const [row] = await this.db
      .select({ deployment: deployments, projectId: services.projectId })
      .from(deployments)
      .innerJoin(services, eq(services.id, deployments.serviceId))
      .where(eq(deployments.id, deploymentId))
      .limit(1);
    return row;
  }

  private async onReplicaStatus(deploymentId: string, replica: number, r: WorkloadStatusReport) {
    const row = await this.deploymentContext(deploymentId);
    // Rollouts get a timeline entry per replica change; settled deployments
    // only record transitions, or a crash loop would flood the table.
    if (row?.deployment.status !== "deploying") return;
    await addDeploymentEvent(
      this.lifecycle(),
      row.projectId,
      deploymentId,
      "replica_status",
      `Replica ${replica} is ${r.state}${r.message ? `: ${r.message}` : ""}`,
      {
        replica,
        workload_id: r.workload_id,
        state: r.state,
        restarts: r.restarts,
        ...(r.exit_code !== undefined ? { exit_code: r.exit_code } : {}),
      },
    );
  }

  private async evaluateDeployment(deploymentId: string) {
    const row = await this.deploymentContext(deploymentId);
    if (!row) return;
    const { deployment, projectId } = row;
    const states = (
      await this.db
        .select({ state: placements.state })
        .from(placements)
        .where(eq(placements.deploymentId, deploymentId))
    ).map((p) => p.state);
    const allHealthy = states.length > 0 && states.every((s) => s === "healthy");
    const anyBad = states.some((s) => BAD_STATES.includes(s));
    const ctx = this.lifecycle();
    try {
      if (deployment.status === "deploying" && (allHealthy || anyBad)) {
        await wakeWorkflow(this.env, deployment, "health", { healthy: allHealthy });
      } else if (deployment.status === "active" && anyBad) {
        await transitionDeployment(ctx, projectId, deploymentId, "crashed", {
          reason: "A replica stopped being healthy",
        });
      } else if (deployment.status === "crashed" && allHealthy) {
        await transitionDeployment(ctx, projectId, deploymentId, "active", { reason: "Recovered" });
      }
    } catch (err) {
      // A concurrent finalize or cancel already moved it on.
      if (!(err instanceof IllegalTransitionError)) throw err;
    }
  }

  private async onBuildResult(nodeId: string, result: BuildResult) {
    const build = await this.db.query.builds.findFirst({
      where: and(eq(builds.id, result.build_id), eq(builds.nodeId, nodeId)),
    });
    if (!build) return;
    const now = new Date();
    // SECURITY: The image must land in the repository the job named, or a
    // compromised builder could point a service at another service's image.
    const ok = result.ok && result.image?.repository === build.imageRepository;
    const error = result.ok
      ? ok
        ? null
        : `Builder pushed to ${result.image?.repository}, expected ${build.imageRepository}`
      : (result.error ?? "build failed");
    const [updated] = await this.db
      .update(builds)
      .set({
        status: ok ? "succeeded" : result.cancelled ? "cancelled" : "failed",
        imageDigest: ok ? result.image!.digest : null,
        error,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(eq(builds.id, build.id), inArray(builds.status, ["queued", "running"])))
      .returning();
    if (!updated) return;
    const deployment = await this.db.query.deployments.findFirst({
      where: eq(deployments.id, build.deploymentId),
    });
    if (deployment) await wakeWorkflow(this.env, deployment, "build", { ok });
  }

  private async onLogs(nodeId: string, frame: Logs) {
    const owner = await this.logOwner(nodeId, frame);
    if (!owner) return;
    const secrets = await this.redactions(owner);
    const lines: LogLine[] = frame.lines.map((l) => ({ ...l, text: redact(l.text, secrets) }));
    const workloadId = frame.source.type === "runtime" ? frame.source.workload_id : undefined;

    const key = owner.deploymentId ? `d:${owner.deploymentId}` : `b:${owner.buildId}`;
    let buffer = this.logBuffers.get(key);
    if (!buffer) {
      buffer = { owner, lines: [], bytes: 0 };
      this.logBuffers.set(key, buffer);
    }
    for (const l of lines) {
      buffer.lines.push(workloadId ? { ...l, workload_id: workloadId } : { ...l });
      buffer.bytes += l.text.length + 64;
    }
    if (buffer.bytes >= LOG_FLUSH_BYTES) {
      this.logBuffers.delete(key);
      await this.writeChunk(buffer);
    } else {
      await this.scheduleFlush();
    }

    try {
      await projectRoom(this.env, owner.projectId).publishLogs(
        owner.serviceId,
        frame.source,
        lines,
      );
    } catch (err) {
      console.warn("log fan-out failed", err);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private lifecycle() {
    return { db: this.db, env: this.env };
  }

  private greetedSocket(): WebSocket | undefined {
    return this.ctx
      .getWebSockets()
      .find((ws) => (ws.deserializeAttachment() as Attachment).helloReceived);
  }

  /**
   * Counts a frame against its per-second budget. Over-budget frames are
   * dropped; a connection that keeps exceeding it is closed.
   */
  private admit(ws: WebSocket, a: Attachment, type: keyof typeof FRAME_RATE_LIMITS): boolean {
    const now = Date.now();
    if (now - a.windowStart >= RATE_WINDOW_MS) {
      a.windowStart = now;
      a.counts = {};
    }
    const count = (a.counts[type] ?? 0) + 1;
    a.counts[type] = count;
    if (count > FRAME_RATE_LIMITS[type]) {
      a.dropped += 1;
      ws.serializeAttachment(a);
      if (a.dropped >= MAX_DROPPED_FRAMES) ws.close(CloseCode.policy, `${type} rate exceeded`);
      return false;
    }
    ws.serializeAttachment(a);
    return true;
  }

  /**
   * Resolves (and caches) where a `logs` frame belongs, accepting only
   * sources this node runs: its own placements or builds sent to it.
   */
  private async logOwner(nodeId: string, frame: Logs): Promise<LogOwner | null> {
    const src = frame.source;
    const key =
      src.type === "runtime" ? `r:${src.workload_id}:${src.deployment_id}` : `b:${src.build_id}`;
    const cached = this.owners.get(key);
    if (cached && Date.now() - cached.at < LOOKUP_TTL_MS) return cached.owner;

    let owner: LogOwner | null = null;
    if (src.type === "runtime") {
      const [row] = await this.db
        .select({
          projectId: services.projectId,
          serviceId: deployments.serviceId,
          environmentId: deployments.environmentId,
        })
        .from(placements)
        .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
        .innerJoin(services, eq(services.id, deployments.serviceId))
        .where(
          and(
            eq(placements.workloadId, src.workload_id),
            eq(placements.deploymentId, src.deployment_id),
            eq(placements.nodeId, nodeId),
          ),
        )
        .limit(1);
      if (row) {
        owner = {
          ...row,
          deploymentId: src.deployment_id,
          buildId: null,
          redactionDeploymentId: src.deployment_id,
        };
      }
    } else {
      const [row] = await this.db
        .select({
          projectId: services.projectId,
          serviceId: builds.serviceId,
          environmentId: deployments.environmentId,
          redactionDeploymentId: builds.deploymentId,
        })
        .from(builds)
        .innerJoin(deployments, eq(deployments.id, builds.deploymentId))
        .innerJoin(services, eq(services.id, builds.serviceId))
        .where(and(eq(builds.id, src.build_id), eq(builds.nodeId, nodeId)))
        .limit(1);
      if (row) owner = { ...row, deploymentId: null, buildId: src.build_id };
    }
    if (this.owners.size > 1024) this.owners.clear();
    this.owners.set(key, { owner, at: Date.now() });
    return owner;
  }

  /**
   * The redaction needles for the owner's lines: its deployment's frozen
   * secret set (see `deploymentRedaction`). Cached by deployment and kind
   * with no expiry, since a frozen set never changes; only sets of
   * deployments from before frozen sets expire, after {@link LOOKUP_TTL_MS}.
   */
  private async redactions(owner: LogOwner): Promise<string[]> {
    const build = owner.buildId !== null;
    const key = `${build ? "b" : "r"}:${owner.redactionDeploymentId}`;
    const cached = this.redactionSets.get(key);
    if (cached && Date.now() < cached.expires) return cached.needles;
    const masterKey = this.env.MASTER_KEY?.trim();
    const set = masterKey
      ? await deploymentRedaction(this.db, masterKey, owner.redactionDeploymentId, build)
      : { needles: [], frozen: false };
    if (this.redactionSets.size >= REDACTION_CACHE_LIMIT) {
      const oldest = this.redactionSets.keys().next().value;
      if (oldest !== undefined) this.redactionSets.delete(oldest);
    }
    this.redactionSets.set(key, {
      needles: set.needles,
      expires: set.frozen ? Number.POSITIVE_INFINITY : Date.now() + LOOKUP_TTL_MS,
    });
    return set.needles;
  }

  /**
   * Brings the alarm forward so buffered lines are flushed within
   * {@link LOG_FLUSH_DELAY_MS}.
   *
   * NOTE: a Durable Object alarm rather than setTimeout: the runtime owns
   * its lifetime, so a flush never fires into a torn-down isolate, and it is
   * retried if the flush throws.
   */
  private async scheduleFlush(): Promise<void> {
    const due = Date.now() + LOG_FLUSH_DELAY_MS;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > due) await this.ctx.storage.setAlarm(due);
  }

  /** Whether the deployment or build a buffer belongs to still exists. */
  private async ownerExists(owner: LogOwner): Promise<boolean> {
    const row = owner.deploymentId
      ? await this.db.query.deployments.findFirst({
          where: eq(deployments.id, owner.deploymentId),
          columns: { id: true },
        })
      : await this.db.query.builds.findFirst({
          where: eq(builds.id, owner.buildId!),
          columns: { id: true },
        });
    return row !== undefined;
  }

  private async writeChunk(buffer: LogBuffer): Promise<void> {
    if (!buffer.lines.length) return;
    const { owner, lines } = buffer;
    // Lines of a deployment or build deleted meanwhile (its project was
    // removed) have nowhere to go; writing them would orphan an R2 object
    // and fail the index's foreign key.
    if (!(await this.ownerExists(owner))) return;
    const id = newId("logChunk");
    const firstTs = lines[0]!.ts;
    const lastTs = lines[lines.length - 1]!.ts;
    const r2Key = logChunkKey(owner.projectId, owner.serviceId, firstTs, id);
    const body = toNdjson(lines);
    try {
      await this.env.LOGS.put(r2Key, body, {
        httpMetadata: { contentType: "application/x-ndjson" },
      });
      await this.db.insert(logChunks).values({
        id,
        projectId: owner.projectId,
        serviceId: owner.serviceId,
        deploymentId: owner.deploymentId,
        buildId: owner.buildId,
        r2Key,
        firstTs: new Date(Math.min(firstTs, lastTs)),
        lastTs: new Date(Math.max(firstTs, lastTs)),
        lineCount: lines.length,
        bytes: new TextEncoder().encode(body).byteLength,
      });
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        // The owner was deleted between the check and the insert.
        await this.env.LOGS.delete(r2Key).catch(() => {});
        return;
      }
      // Live lines already reached the dashboard; losing a stored chunk must
      // not take the agent connection down with it.
      console.error("log chunk write failed", r2Key, err);
    }
  }

  private async sendDesiredState(ws: WebSocket, nodeId: string): Promise<boolean> {
    const masterKey = this.env.MASTER_KEY?.trim();
    if (!masterKey) {
      ws.close(1011, "control plane misconfigured");
      return false;
    }
    const body = await buildDesiredState(this.db, masterKey, nodeId);
    if (!body) return false;
    const now = Date.now();
    const ttl = carriesCredentials(body) ? CREDENTIAL_FRAME_TTL_MS : CONTROL_TTL_MS;
    await this.send(ws, { ...body, ...this.header(nodeId, now, ttl) });
    return true;
  }

  private header(nodeId: string, now: number, ttl = CONTROL_TTL_MS) {
    return { id: newId("message"), node_id: nodeId, iat: now, exp: now + ttl };
  }

  private async send(ws: WebSocket, message: ControlMessage): Promise<void> {
    const masterKey = this.env.MASTER_KEY;
    if (!masterKey) return ws.close(1011, "control plane misconfigured");
    // The agent rejects malformed or over-long-lived frames anyway; checking
    // here turns a silent agent-side rejection into a control-plane error.
    const checked = ControlMessageSchema.parse(message);
    const key = await loadSigningKey(this.db, this.env);
    const frame = JSON.stringify(await signEnvelope(checked, key.privateKey, key.kid));
    if (frame.length > MAX_CONTROL_FRAME_BYTES) {
      throw new Error(`control frame of ${frame.length} bytes exceeds the agent's read limit`);
    }
    ws.send(frame);
  }
}
