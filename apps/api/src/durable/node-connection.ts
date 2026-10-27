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
 * - send `job_run` and `job_cancel` (ADR 0010) to agents at
 *   `JOBS_PROTOCOL_VERSION`, apply `job_status` to cron runs and file `job`
 *   log sources under their run (`./node/handlers/jobs.ts`);
 * - redact (with each deployment's frozen secret set and its encodings),
 *   store (R2 + `log_chunks`) and forward `logs` to the project
 *   room, flushing on the Durable Object's alarm and dropping lines whose
 *   deployment or build no longer exists;
 * - ask metrics-capable agents for `metrics` in `welcome`, and write their
 *   samples and every heartbeat to the metrics dataset (ADR 0008,
 *   `./node/handlers/metrics.ts`);
 * - record `volume_status` reports (`./node/handlers/volumes.ts`), run
 *   data-browser queries (`runQuery`, answered by `db_query_result`,
 *   `./node/handlers/data.ts`), create each database's read-only principal
 *   once it runs healthy, and send `volume_delete` (ADR 0004); backup and
 *   restore frames are dispatched to `./node/handlers/backups.ts`;
 * - record `hello.mesh` (the node's WireGuard key, `wg0` mode and
 *   reachability, with the address the connection came from), let the node
 *   join the mesh, and apply `mesh_status` and `mesh_key` (ADR 0005,
 *   `../lib/mesh.ts`), moving key rotations along on heartbeats;
 * - answer `cert_request` with `cert_sync` (keys sealed to the node),
 *   record `cert_ack` and `cert_status` (ADR 0009,
 *   `./node/handlers/certs.ts`);
 * - sign and send control frames: `welcome`, `desired_state` (always
 *   computed from D1, so a reconnect gets the truth), `build_job` and
 *   `build_cancel`, never sending a frame or field to an agent whose
 *   protocol version predates it (workloads and builds need
 *   `SEALED_ENV_PROTOCOL_VERSION`), and giving credential-carrying frames at
 *   most `CREDENTIAL_FRAME_TTL_MS`;
 * - during a signing-key rollover (ADR 0014 §13), sign each frame with the
 *   key the agent pins (`hello.pinned_kids`, else what D1 recorded) and
 *   announce the successor in `welcome.next_keys` and `key_announce`,
 *   recording the announced kids as pinned.
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
  cronRuns,
  type Db,
  deployments,
  logChunks,
  nodes,
  placements,
  services,
} from "@roundhouse/db";
import {
  type AgentFrame,
  AgentFrameSchema,
  type AnyLogs,
  BACKUPS_PROTOCOL_VERSION,
  BUILD_CANCEL_PROTOCOL_VERSION,
  type BuildJob,
  type BuildResult,
  CERTS_PROTOCOL_VERSION,
  type ControlMessage,
  ControlMessageSchema,
  CREDENTIAL_FRAME_TTL_MS,
  carriesCredentials,
  DB_QUERY_PROTOCOL_VERSION,
  type Heartbeat,
  type Hello,
  JOBS_PROTOCOL_VERSION,
  type JobRun,
  KEY_ROLLOVER_PROTOCOL_VERSION,
  type LogLine,
  MAX_AGENT_FRAME_BYTES,
  MAX_CONTROL_FRAME_BYTES,
  MESH_PROTOCOL_VERSION,
  METRICS_PROTOCOL_VERSION,
  MIN_PROTOCOL_VERSION,
  type NodeEncryptionKey,
  PROTOCOL_VERSION,
  SEALED_ENV_PROTOCOL_VERSION,
  SECRET_BUILD_ARGS_PROTOCOL_VERSION,
  signEnvelope,
  VOLUMES_PROTOCOL_VERSION,
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
  DB_QUERY_WAIT_MS,
  type DbQueryBody,
  provisionReadonlyOnNode,
  type RunQueryOutcome,
} from "../lib/db-query";
import {
  addDeploymentEvent,
  IllegalTransitionError,
  transitionDeployment,
  wakeWorkflow,
} from "../lib/deployments";
import { buildDesiredState, refreshNodes } from "../lib/desired-state";
import { deploymentRedaction, logChunkKey, type StoredLogLine, toNdjson } from "../lib/logs";
import {
  dropPairPsks,
  isMeshed,
  joinMesh,
  meshEndpoint,
  meshRefreshTargets,
  onMeshKey,
  onMeshStatus,
  progressRotations,
} from "../lib/mesh";
import { metricsIntervalMs } from "../lib/metrics/backend";
import { nodeRow, writeMetricRows } from "../lib/metrics/write";
import { NODE_ID_HEADER } from "../lib/nodes";
import { projectRoom } from "../lib/realtime";
import { getMeshSettings } from "../lib/settings";
import {
  announcementsFor,
  invalidateSigningKeys,
  loadSigningKeys,
  signingKeyFor,
} from "../lib/signing-keys";
import { type BackupJobFrameBody, onBackupFrame } from "./node/handlers/backups";
import { onCertFrame } from "./node/handlers/certs";
import { MAX_QUERIES_PER_NODE, PendingQueries, UserQueryLimiter } from "./node/handlers/data";
import { jobLogOwner, onJobStatus } from "./node/handlers/jobs";
import { MetricOwners, onMetrics } from "./node/handlers/metrics";
import { onVolumeStatus } from "./node/handlers/volumes";

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
 * `metrics` is one per second by contract, plus one for a frame that lands
 * at a window's edge. `other` covers frames this object validates but has
 * no handler for yet, which are dropped.
 */
export const FRAME_RATE_LIMITS = {
  workload_status: 64,
  logs: 256,
  build_result: 8,
  metrics: 2,
  /** Every 60 s and on change; a burst of changes coalesces on the agent. */
  volume_status: 4,
  /** Every 30 s and on change, at most 4 a second by contract (ADR 0005). */
  mesh_status: 4,
  /** Once per rotation; a few resends after reconnects. */
  mesh_key: 2,
  /** At most 4 queries run per node at once (ADR 0004). */
  db_query_result: 8,
  backup_parts_request: 8,
  backup_progress: 16,
  backup_result: 4,
  restore_result: 4,
  /** Sent after a manifest mismatch; each one costs a desired-state build. */
  cert_request: 2,
  cert_ack: 8,
  /** On change, and for every routed host after a reconnect. */
  cert_status: 32,
  /** A few per run (pulling, running, terminal), re-sent for every run after a reconnect. */
  job_status: 32,
  other: 64,
} as const;

/** Window of {@link FRAME_RATE_LIMITS}. */
const RATE_WINDOW_MS = 1000;

/** A budget of {@link FRAME_RATE_LIMITS}. */
type RateBucket = keyof typeof FRAME_RATE_LIMITS;

/** Frames over the limit dropped in one connection before it is closed. */
const MAX_DROPPED_FRAMES = 200;

/**
 * Least time between two attempts to create one database's read-only
 * principal. Just under the agent's 60 s `volume_status` period, so every
 * report can retry a failed attempt.
 */
const READONLY_RETRY_MS = 50_000;

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

/** Whether a hello carries `pinned_kids` the control plane should trust as current. */
function reportsPins(hello: Hello): hello is Hello & { pinned_kids: string[] } {
  return hello.protocol_version >= KEY_ROLLOVER_PROTOCOL_VERSION && !!hello.pinned_kids?.length;
}

interface Attachment {
  nodeId: string;
  helloReceived: boolean;
  protocolVersion: number;
  /**
   * Signing kids the agent accepts: from its hello, else as recorded in D1,
   * plus successors announced on this connection. `null` when unknown (an
   * agent that predates rollover pins the key it joined with).
   */
  pinnedKids: string[] | null;
  lastBeatAt: number;
  strikes: number;
  windowStart: number;
  counts: Partial<Record<RateBucket, number>>;
  dropped: number;
  /** `CF-Connecting-IP` of the agent's connection: its public address, when it has one. */
  observedIp?: string | null;
}

/** Where a log source's lines belong. */
interface LogOwner {
  projectId: string;
  serviceId: string;
  environmentId: string;
  deploymentId: string | null;
  buildId: string | null;
  /** Set for a cron run's output (ADR 0010). */
  cronRunId: string | null;
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

/** Fields a caller supplies for a `job_run`; the signed header is added when sent. */
export type JobRunBody = Omit<JobRun, "id" | "node_id" | "iat" | "exp" | "type">;

/** Why {@link NodeConnection.sendJobRun} or {@link NodeConnection.sendJobCancel} could not deliver. */
export type JobRejection = "not_connected" | "protocol_too_old";

/** A `logs` frame this object ingests: a replica's, a build's or a job run's. */
type IngestedLogs = AnyLogs & { source: Exclude<AnyLogs["source"], { type: "task" }> };

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
  private metricOwners: MetricOwners;
  private queries = new PendingQueries();
  private queryLimiter = new UserQueryLimiter();
  /** Volumes whose read-only principal is being created, or was last tried, and when. */
  private readonlyAttempts = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = createDb(env.DB);
    this.metricOwners = new MetricOwners(this.db);
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
      pinnedKids: null,
      lastBeatAt: 0,
      strikes: 0,
      windowStart: 0,
      counts: {},
      dropped: 0,
      observedIp: request.headers.get("cf-connecting-ip"),
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

    let message: AgentFrame;
    try {
      const parsed = AgentFrameSchema.safeParse(JSON.parse(raw));
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
    const bucket = message.type in FRAME_RATE_LIMITS ? (message.type as RateBucket) : "other";
    if (!this.admit(ws, attachment, bucket)) return;
    switch (message.type) {
      case "workload_status":
        await this.applyStatuses(attachment.nodeId, [message]);
        return;
      case "build_result":
        await this.onBuildResult(attachment.nodeId, message);
        return;
      case "logs": {
        // NOTE: task sources (protocol 5) have no ingest here yet; their
        // lines are dropped rather than filed under a replica.
        const { source } = message;
        if (source.type === "task") return;
        if (source.type === "job" && attachment.protocolVersion < JOBS_PROTOCOL_VERSION) return;
        await this.onLogs(attachment.nodeId, { ...message, source });
        return;
      }
      case "job_status":
        if (attachment.protocolVersion < JOBS_PROTOCOL_VERSION) return;
        await onJobStatus({ db: this.db, env: this.env, nodeId: attachment.nodeId }, message);
        return;
      case "mesh_status":
      case "mesh_key":
        if (attachment.protocolVersion < MESH_PROTOCOL_VERSION) return;
        try {
          if (message.type === "mesh_status") {
            await onMeshStatus(this.db, attachment.nodeId, message, (ids) => this.refresh(ids));
          } else {
            await onMeshKey(this.db, attachment.nodeId, message, (ids) => this.refresh(ids));
          }
        } catch (err) {
          // The next report retries; the connection stays up.
          console.error(
            "mesh frame failed",
            message.type,
            err instanceof Error ? err.message : "error",
          );
        }
        return;
      case "metrics":
        // A frame the control plane never asked for (an older protocol) is dropped.
        if (attachment.protocolVersion < METRICS_PROTOCOL_VERSION) return;
        try {
          await onMetrics(this.env, this.metricOwners, attachment.nodeId, message);
        } catch (err) {
          // Losing one sample must not take the agent connection down.
          console.error("metrics write failed", err instanceof Error ? err.message : "error");
        }
        return;
      case "volume_status":
        if (attachment.protocolVersion < VOLUMES_PROTOCOL_VERSION) return;
        await onVolumeStatus(this.db, this.env, attachment.nodeId, message);
        // The 60 s report doubles as the retry tick for read-only principals.
        this.provisionReadonlySoon(attachment.nodeId);
        return;
      case "db_query_result":
        if (attachment.protocolVersion < DB_QUERY_PROTOCOL_VERSION) return;
        this.queries.settle(message);
        return;
      // Backups and restores (ADR 0004): `./node/handlers/backups.ts`.
      case "backup_parts_request":
      case "backup_progress":
      case "backup_result":
      case "restore_result":
        if (attachment.protocolVersion < BACKUPS_PROTOCOL_VERSION) return;
        await onBackupFrame(
          {
            db: this.db,
            env: this.env,
            nodeId: attachment.nodeId,
            reply: async (body) => {
              await this.send(ws, {
                ...this.header(attachment.nodeId, Date.now(), CREDENTIAL_FRAME_TTL_MS),
                ...body,
              });
            },
          },
          message,
        );
        return;
      // Certificates (ADR 0009): `./node/handlers/certs.ts`.
      case "cert_request":
      case "cert_ack":
      case "cert_status":
        if (attachment.protocolVersion < CERTS_PROTOCOL_VERSION) return;
        try {
          await onCertFrame(
            {
              db: this.db,
              env: this.env,
              nodeId: attachment.nodeId,
              reply: async (body) => {
                await this.send(ws, {
                  ...this.header(attachment.nodeId, Date.now(), CREDENTIAL_FRAME_TTL_MS),
                  ...body,
                });
              },
            },
            message,
          );
        } catch (err) {
          // A certificate the agent can't get now is requested again on the
          // next manifest check; the connection stays up.
          console.error(
            "certificate frame failed",
            message.type,
            err instanceof Error ? err.message : "error",
          );
        }
        return;
      default:
        // Validated Phase 2–3 frames whose handlers land with their streams.
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
   * Signs and sends a `job_run` (ADR 0010) with the credential TTL: its
   * environment is a box the caller sealed to this node, bound to the run
   * and workload, so no plaintext reaches this object.
   *
   * @param job - Frame fields.
   * @returns `{ sent: true }`, or why it could not be delivered.
   */
  async sendJobRun(
    job: JobRunBody,
  ): Promise<{ sent: true } | { sent: false; reason: JobRejection }> {
    const ws = this.greetedSocket();
    if (!ws) return { sent: false, reason: "not_connected" };
    const attachment = ws.deserializeAttachment() as Attachment;
    if (attachment.protocolVersion < JOBS_PROTOCOL_VERSION) {
      return { sent: false, reason: "protocol_too_old" };
    }
    await this.send(ws, {
      type: "job_run",
      ...this.header(attachment.nodeId, Date.now(), CREDENTIAL_FRAME_TTL_MS),
      ...job,
    });
    return { sent: true };
  }

  /**
   * Signs and sends a `job_cancel`; the agent answers with a `cancelled`
   * `job_status`, or ignores it for a run it no longer runs.
   *
   * @param runId - The run to stop.
   * @param reason - Shown in the run's log, e.g. `replaced by crn_…`.
   * @returns `{ sent: true }`, or why it could not be delivered.
   */
  async sendJobCancel(
    runId: string,
    reason: string,
  ): Promise<{ sent: true } | { sent: false; reason: JobRejection }> {
    const ws = this.greetedSocket();
    if (!ws) return { sent: false, reason: "not_connected" };
    const attachment = ws.deserializeAttachment() as Attachment;
    if (attachment.protocolVersion < JOBS_PROTOCOL_VERSION) {
      return { sent: false, reason: "protocol_too_old" };
    }
    await this.send(ws, {
      type: "job_cancel",
      ...this.header(attachment.nodeId, Date.now()),
      run_id: runId,
      reason: reason.slice(0, 256),
    });
    return { sent: true };
  }

  /**
   * Signs and sends a `db_query` and waits for its `db_query_result`. The
   * caller seals the credential to this node, bound to `request_id`, so the
   * plaintext never reaches this object.
   *
   * @param query - The frame body.
   * @param options - `userId` applies the per-user rate limit (system
   *   queries have none); `waitMs` overrides {@link DB_QUERY_WAIT_MS}.
   * @returns The result, or why there is none.
   */
  async runQuery(
    query: DbQueryBody,
    options: { userId?: string; waitMs?: number } = {},
  ): Promise<RunQueryOutcome> {
    const ws = this.greetedSocket();
    if (!ws) return { ok: false, reason: "not_connected" };
    const attachment = ws.deserializeAttachment() as Attachment;
    if (attachment.protocolVersion < DB_QUERY_PROTOCOL_VERSION) {
      return { ok: false, reason: "protocol_too_old" };
    }
    if (options.userId !== undefined && !this.queryLimiter.admit(options.userId, Date.now())) {
      return { ok: false, reason: "rate_limited" };
    }
    if (this.queries.size >= MAX_QUERIES_PER_NODE) return { ok: false, reason: "busy" };
    const waitMs = options.waitMs ?? DB_QUERY_WAIT_MS;
    const answer = this.queries.wait(query.request_id, waitMs);
    try {
      await this.send(ws, {
        type: "db_query",
        ...this.header(attachment.nodeId, Date.now(), CREDENTIAL_FRAME_TTL_MS),
        ...query,
      });
    } catch (err) {
      this.queries.cancel(query.request_id);
      throw err;
    }
    const result = await answer;
    return result ? { ok: true, result } : { ok: false, reason: "timeout" };
  }

  /**
   * Signs and sends a `backup_job` or `restore_job` (ADR 0004) with the
   * credential TTL. The caller has sealed its URLs and identity to this
   * node, so no plaintext credential reaches this object.
   *
   * @param body - The frame body, `type` included.
   * @returns `{ sent: true }`, or why it could not be delivered.
   */
  async sendBackupJob(
    body: BackupJobFrameBody,
  ): Promise<{ sent: true } | { sent: false; reason: "not_connected" | "protocol_too_old" }> {
    const ws = this.greetedSocket();
    if (!ws) return { sent: false, reason: "not_connected" };
    const attachment = ws.deserializeAttachment() as Attachment;
    if (attachment.protocolVersion < BACKUPS_PROTOCOL_VERSION) {
      return { sent: false, reason: "protocol_too_old" };
    }
    await this.send(ws, {
      ...this.header(attachment.nodeId, Date.now(), CREDENTIAL_FRAME_TTL_MS),
      ...body,
    } as ControlMessage);
    return { sent: true };
  }

  /**
   * Signs and sends a `volume_delete`, the only frame that removes a
   * volume's data. The node confirms with `volume_status` state `deleted`.
   *
   * @param volumeId - A volume past its deletion grace.
   * @returns `{ sent: true }`, or why it could not be delivered.
   */
  async sendVolumeDelete(
    volumeId: string,
  ): Promise<{ sent: true } | { sent: false; reason: "not_connected" | "protocol_too_old" }> {
    const ws = this.greetedSocket();
    if (!ws) return { sent: false, reason: "not_connected" };
    const attachment = ws.deserializeAttachment() as Attachment;
    if (attachment.protocolVersion < VOLUMES_PROTOCOL_VERSION) {
      return { sent: false, reason: "protocol_too_old" };
    }
    await this.send(ws, {
      type: "volume_delete",
      ...this.header(attachment.nodeId, Date.now()),
      volume_id: volumeId,
    });
    return { sent: true };
  }

  /**
   * Drops this isolate's cached signing keys and, when a successor is
   * scheduled, announces it to the connected agent in a `key_announce` (if
   * its protocol has rollover). Called after a rollover is scheduled,
   * completed or cancelled.
   *
   * @returns Whether a `key_announce` was sent.
   */
  async refreshSigningKeys(): Promise<boolean> {
    invalidateSigningKeys();
    const ws = this.greetedSocket();
    if (!ws) return false;
    const attachment = ws.deserializeAttachment() as Attachment;
    if (attachment.protocolVersion < KEY_ROLLOVER_PROTOCOL_VERSION) return false;
    return this.send(ws, {
      type: "key_announce",
      ...this.header(attachment.nodeId, Date.now()),
      // Filled in by `send` for the key the frame is signed with.
      keys: [],
    });
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
        ...(reportsPins(hello) ? { pinnedSigningKids: hello.pinned_kids } : {}),
      })
      .where(and(eq(nodes.id, attachment.nodeId), isNull(nodes.deletedAt)))
      .returning({
        id: nodes.id,
        workspaceId: nodes.workspaceId,
        identityPublicKey: nodes.identityPublicKey,
        encryptionPublicKey: nodes.encryptionPublicKey,
        pinnedSigningKids: nodes.pinnedSigningKids,
      });
    if (!node) return ws.close(CloseCode.removed, "node removed");
    ws.serializeAttachment({
      ...(ws.deserializeAttachment() as Attachment),
      pinnedKids: node.pinnedSigningKids ?? null,
    } satisfies Attachment);
    // Registered before the desired state below is computed, so a node that
    // just gained a key gets its workloads in this very frame.
    if (
      hello.encryption_key &&
      node.encryptionPublicKey === null &&
      hello.protocol_version >= SEALED_ENV_PROTOCOL_VERSION
    ) {
      await this.registerEncryptionKey(node, hello.encryption_key);
    }

    if (hello.protocol_version >= MESH_PROTOCOL_VERSION) {
      try {
        await this.onHelloMesh(node, hello, attachment.observedIp ?? null);
      } catch (err) {
        // The node still runs its local workloads; the mesh waits for the next hello.
        console.error("mesh registration failed", err instanceof Error ? err.message : "error");
      }
    }

    await this.ctx.storage.put({ node_id: attachment.nodeId, last_seen: now });
    await this.ctx.storage.setAlarm(now + OFFLINE_AFTER_MS);

    await this.send(ws, {
      type: "welcome",
      ...this.header(attachment.nodeId, now),
      heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
      ...(hello.protocol_version >= METRICS_PROTOCOL_VERSION
        ? { metrics_interval_ms: metricsIntervalMs(this.env) }
        : {}),
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

  /**
   * Records `hello.mesh` and lets the node join the mesh.
   *
   * A key that differs from the stored one without a rotation (a reinstalled
   * agent that lost its key file) replaces it, and the node's preshared keys
   * are drawn again.
   *
   * SECURITY: `hello` isn't signed, so a stolen node credential could
   * announce its own WireGuard key. It would still never complete a
   * handshake: every pair's preshared key reaches the node only sealed to
   * its registered X25519 key, which only a re-join can replace.
   */
  private async onHelloMesh(
    node: { id: string; workspaceId: string },
    hello: Hello,
    observedIp: string | null,
  ): Promise<void> {
    const [before] = await this.db.select().from(nodes).where(eq(nodes.id, node.id)).limit(1);
    if (!before) return;
    const m = hello.mesh;
    const settings = await getMeshSettings(this.db);
    const wasMeshed = isMeshed(before, settings);
    if (!m) {
      if (before.meshMode === null) return;
      await this.db
        .update(nodes)
        .set({ meshMode: null, meshReady: false, meshEndpoint: null })
        .where(eq(nodes.id, node.id));
      if (wasMeshed) await this.refreshPeers(node.id);
      return;
    }
    const endpoint = meshEndpoint(m, observedIp);
    const keyChanged =
      before.wgPubkey !== null &&
      m.public_key !== before.wgPubkey &&
      m.public_key !== before.wgPubkeyNext;
    const [after] = await this.db
      .update(nodes)
      .set({
        ...(before.wgPubkey === null || keyChanged
          ? {
              wgPubkey: m.public_key,
              wgKeyEpoch: 0,
              wgPubkeyNext: null,
              wgKeyNextEpoch: null,
              wgKeyRotatedAt: new Date(),
              meshRotateRequestedAt: null,
              meshRotateGeneration: null,
              meshRotateAnnouncedAt: null,
              meshActivateEpoch: null,
            }
          : {}),
        meshMode: m.mode,
        meshNat: m.nat,
        meshEndpoint: endpoint,
        meshEndpointOverride: m.endpoint_override,
        meshListenPort: m.listen_port,
        meshDockerFirewall: m.docker_firewall,
        meshAcceptFwmark: m.accept_fwmark,
      })
      .where(eq(nodes.id, node.id))
      .returning();
    if (!after) return;
    if (keyChanged) {
      await dropPairPsks(this.db, node.id);
      await recordAudit(this.db, {
        workspaceId: node.workspaceId,
        actorType: "node",
        actorId: node.id,
        action: "node.mesh_key_rotated",
        targetType: "node",
        targetId: node.id,
        metadata: { reason: "agent_key_changed" },
      });
    }
    const index = await joinMesh(this.db, node.id, settings);
    if (index !== null) {
      await recordAudit(this.db, {
        workspaceId: node.workspaceId,
        actorType: "node",
        actorId: node.id,
        action: "node.mesh_joined",
        targetType: "node",
        targetId: node.id,
        metadata: { mesh_index: index, mode: m.mode, nat: m.nat },
      });
    }
    const changed =
      keyChanged ||
      index !== null ||
      before.meshEndpoint !== endpoint ||
      before.meshMode !== m.mode ||
      before.meshListenPort !== m.listen_port;
    const nowMeshed = isMeshed({ ...after, meshIndex: after.meshIndex ?? index }, settings);
    if (changed && (wasMeshed || nowMeshed)) await this.refreshPeers(node.id);
  }

  /**
   * Pushes desired state to the other meshed nodes of this node's workspace;
   * this node's own frame follows the hello it is answering.
   */
  private async refreshPeers(nodeId: string): Promise<void> {
    const targets = await meshRefreshTargets(this.db, [nodeId], await getMeshSettings(this.db));
    const others = targets.filter((id) => id !== nodeId);
    if (others.length) await refreshNodes(this.env, this.db, others);
  }

  /**
   * Pushes desired state to nodes. This node's own frame is sent from here,
   * not through its own stub.
   */
  private async refresh(nodeIds: readonly string[]): Promise<void> {
    const ws = this.greetedSocket();
    const self = ws ? (ws.deserializeAttachment() as Attachment).nodeId : null;
    const others = nodeIds.filter((id) => id !== self);
    if (others.length) await refreshNodes(this.env, this.db, others);
    if (self && ws && nodeIds.includes(self)) {
      await this.db
        .update(nodes)
        .set({ desiredGeneration: sql`${nodes.desiredGeneration} + 1` })
        .where(and(eq(nodes.id, self), isNull(nodes.deletedAt)));
      await this.sendDesiredState(ws, self);
    }
  }

  private async onHeartbeat(nodeId: string, hb: Heartbeat): Promise<void> {
    const now = Date.now();
    const [node] = await this.db
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
      .where(and(eq(nodes.id, nodeId), isNull(nodes.deletedAt)))
      .returning({
        workspaceId: nodes.workspaceId,
        rotating: nodes.meshRotateRequestedAt,
      });
    await this.ctx.storage.put("last_seen", now);
    await this.ctx.storage.setAlarm(now + OFFLINE_AFTER_MS);

    if (!node) return;
    if (node.rotating) {
      try {
        await progressRotations(this.db, (ids) => this.refresh(ids), { now, nodeId });
      } catch (err) {
        console.error("mesh rotation step failed", err instanceof Error ? err.message : "error");
      }
    }
    try {
      // Stamped with the receive time: the agent's clock may be skewed.
      await writeMetricRows(this.env, [
        nodeRow(nodeId, node.workspaceId, { ...hb, ts: now }, HEARTBEAT_INTERVAL_MS / 1000),
      ]);
    } catch (err) {
      console.error("node metrics write failed", err instanceof Error ? err.message : "error");
    }
  }

  /**
   * Applies status reports to this node's placements, then re-evaluates each
   * affected deployment once.
   */
  private async applyStatuses(nodeId: string, reports: readonly WorkloadStatusReport[]) {
    const touched = new Set<string>();
    // Other nodes' private DNS and ingress answer healthy replicas first.
    let meshHealth = false;
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
        .returning({
          deploymentId: placements.deploymentId,
          replica: placements.replica,
          meshIp: placements.meshIp,
        });
      if (!row) continue;
      touched.add(row.deploymentId);
      if (row.meshIp && (r.state === "healthy" || BAD_STATES.includes(r.state))) {
        meshHealth = true;
      }
      await this.onReplicaStatus(row.deploymentId, row.replica, r);
    }
    for (const deploymentId of touched) await this.evaluateDeployment(deploymentId);
    if (meshHealth) {
      try {
        await this.refreshPeers(nodeId);
      } catch (err) {
        console.error("mesh refresh failed", err instanceof Error ? err.message : "error");
      }
    }
    if (touched.size && reports.some((r) => r.state === "healthy")) {
      this.provisionReadonlySoon(nodeId);
    }
  }

  /**
   * Creates the read-only principal of each database on this node that
   * runs healthy without one (ADR 0004, "Read-only principal"), in the
   * background so the frame that triggered it isn't held up by the query.
   * A volume is retried at most every {@link READONLY_RETRY_MS} until it
   * succeeds; healthy reports and every `volume_status` trigger it.
   */
  private provisionReadonlySoon(nodeId: string): void {
    const ws = this.greetedSocket();
    if (!ws) return;
    if ((ws.deserializeAttachment() as Attachment).protocolVersion < DB_QUERY_PROTOCOL_VERSION) {
      return;
    }
    const now = Date.now();
    const skip = (volumeId: string) => {
      const last = this.readonlyAttempts.get(volumeId);
      if (last !== undefined && now - last < READONLY_RETRY_MS) return true;
      this.readonlyAttempts.set(volumeId, now);
      return false;
    };
    const run = provisionReadonlyOnNode(
      this.db,
      this.env,
      nodeId,
      (q) => this.runQuery(q),
      skip,
    ).then(({ provisioned }) => {
      for (const id of provisioned) this.readonlyAttempts.delete(id);
    });
    run.catch((err) => {
      console.error("read-only provisioning failed", err instanceof Error ? err.message : "error");
    });
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

  private async onLogs(nodeId: string, frame: IngestedLogs) {
    const owner = await this.logOwner(nodeId, frame);
    if (!owner) return;
    const secrets = await this.redactions(owner);
    const lines: LogLine[] = frame.lines.map((l) => ({ ...l, text: redact(l.text, secrets) }));
    const workloadId = frame.source.type === "build" ? undefined : frame.source.workload_id;

    const key = owner.cronRunId
      ? `j:${owner.cronRunId}`
      : owner.deploymentId
        ? `d:${owner.deploymentId}`
        : `b:${owner.buildId}`;
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
  private admit(ws: WebSocket, a: Attachment, type: RateBucket): boolean {
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
  private async logOwner(nodeId: string, frame: IngestedLogs): Promise<LogOwner | null> {
    const src = frame.source;
    const key =
      src.type === "runtime"
        ? `r:${src.workload_id}:${src.deployment_id}`
        : src.type === "build"
          ? `b:${src.build_id}`
          : `j:${src.run_id}:${src.workload_id}`;
    const cached = this.owners.get(key);
    if (cached && Date.now() - cached.at < LOOKUP_TTL_MS) return cached.owner;

    let owner: LogOwner | null = null;
    if (src.type === "job") {
      const job = await jobLogOwner(this.db, nodeId, src);
      if (job) owner = { ...job, deploymentId: null, buildId: null };
    } else if (src.type === "runtime") {
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
          cronRunId: null,
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
      if (row) owner = { ...row, deploymentId: null, buildId: src.build_id, cronRunId: null };
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
    const set = this.env.MASTER_KEY?.trim()
      ? await deploymentRedaction(this.db, this.env, owner.redactionDeploymentId, build)
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

  /** Whether the deployment, build or cron run a buffer belongs to still exists. */
  private async ownerExists(owner: LogOwner): Promise<boolean> {
    if (owner.cronRunId) {
      const [run] = await this.db
        .select({ id: cronRuns.id })
        .from(cronRuns)
        .where(eq(cronRuns.id, owner.cronRunId))
        .limit(1);
      return run !== undefined;
    }
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
        cronRunId: owner.cronRunId,
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
    if (!this.env.MASTER_KEY?.trim()) {
      ws.close(1011, "control plane misconfigured");
      return false;
    }
    const body = await buildDesiredState(this.db, this.env, nodeId);
    if (!body) return false;
    const now = Date.now();
    const ttl = carriesCredentials(body) ? CREDENTIAL_FRAME_TTL_MS : CONTROL_TTL_MS;
    await this.send(ws, { ...body, ...this.header(nodeId, now, ttl) });
    return true;
  }

  private header(nodeId: string, now: number, ttl = CONTROL_TTL_MS) {
    return { id: newId("message"), node_id: nodeId, iat: now, exp: now + ttl };
  }

  /**
   * Signs a frame with the key this connection's agent pins and sends it.
   * A `welcome` (to an agent with rollover) gets `next_keys`, and a
   * `key_announce` its `keys`, for that key; a `key_announce` with
   * nothing to announce isn't sent.
   *
   * @returns Whether the frame was sent.
   */
  private async send(ws: WebSocket, message: ControlMessage): Promise<boolean> {
    const masterKey = this.env.MASTER_KEY;
    if (!masterKey) {
      ws.close(1011, "control plane misconfigured");
      return false;
    }
    const attachment = ws.deserializeAttachment() as Attachment;
    const set = await loadSigningKeys(this.db, this.env);
    const key = signingKeyFor(set, attachment.pinnedKids);
    const announced =
      attachment.protocolVersion >= KEY_ROLLOVER_PROTOCOL_VERSION
        ? announcementsFor(set, key.kid)
        : [];
    let outgoing = message;
    if (message.type === "welcome") {
      const { next_keys: _, ...rest } = message;
      outgoing = announced.length ? { ...rest, next_keys: announced } : rest;
    } else if (message.type === "key_announce") {
      if (!announced.length) return false;
      outgoing = { ...message, keys: announced };
    }
    // The agent rejects malformed or over-long-lived frames anyway; checking
    // here turns a silent agent-side rejection into a control-plane error.
    const checked = ControlMessageSchema.parse(outgoing);
    const frame = JSON.stringify(await signEnvelope(checked, key.privateKey, key.kid));
    if (frame.length > MAX_CONTROL_FRAME_BYTES) {
      throw new Error(`control frame of ${frame.length} bytes exceeds the agent's read limit`);
    }
    ws.send(frame);
    if (checked.type === "welcome" || checked.type === "key_announce") {
      await this.recordPins(ws, key.kid, announced);
    }
    return true;
  }

  /**
   * Records the kids an agent pins after it was sent announcements under
   * `signingKid`. There is no acknowledgement frame: an agent that failed to
   * keep them says so in its next hello, which replaces this record.
   */
  private async recordPins(
    ws: WebSocket,
    signingKid: string,
    announced: readonly { kid: string }[],
  ): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment;
    const before = attachment.pinnedKids ?? [];
    const pins = [
      ...new Set([...(before.length ? before : [signingKid]), ...announced.map((a) => a.kid)]),
    ];
    if (pins.length === before.length && pins.every((k) => before.includes(k))) return;
    ws.serializeAttachment({ ...attachment, pinnedKids: pins } satisfies Attachment);
    await this.db
      .update(nodes)
      .set({ pinnedSigningKids: pins })
      .where(and(eq(nodes.id, attachment.nodeId), isNull(nodes.deletedAt)));
  }
}
