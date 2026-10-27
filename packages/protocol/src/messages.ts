/**
 * Zod schemas for every frame on the agent WebSocket.
 *
 * - Agent → control: `hello`, `heartbeat`, `workload_status`, `logs`,
 *   `build_result`; from protocol 5 `mesh_status`, `mesh_key`,
 *   `volume_status`, `backup_parts_request`, `backup_progress`,
 *   `backup_result`, `restore_result`, `db_query_result`; from protocol 6
 *   `job_status`, `metrics`, `cert_ack`, `cert_request`, `cert_status`; from
 *   protocol 7 `exec_opened`, `exec_output`, `exec_exit`,
 *   `image_push_result`. {@link AgentFrameSchema} is the complete union.
 * - Control → agent, always inside a signed envelope (./signing): `welcome`,
 *   `desired_state`, `build_job`, `build_cancel`; from protocol 5
 *   `key_announce`, `volume_delete`, `backup_job`, `backup_parts`,
 *   `restore_job`, `volume_copy_out`, `volume_copy_in`, `db_query`; from
 *   protocol 6 `job_run`, `job_cancel`, `cert_sync`; from protocol 7
 *   `exec_open`, `exec_input`, `exec_resize`, `exec_close`, `image_push`.
 *
 * Version constants live in ./versions; frames of one feature in ./data,
 * ./mesh, ./jobs, ./metrics, ./certs, ./signing-keys, ./exec and
 * ./image-push.
 *
 * @module
 */
import { z } from "zod";
import { EncryptionPublicKeyString, SealedBoxSchema } from "./box";
import {
  CertAckSchema,
  CertificateManifestSchema,
  CertRequestSchema,
  CertStatusSchema,
  CertSyncSchema,
  IngressSettingsSchema,
} from "./certs";
import { ControlHeader, isShortLived, SHORT_LIVED_ISSUE } from "./control";
import {
  BackupJobSchema,
  BackupPartsRequestSchema,
  BackupPartsSchema,
  BackupProgressSchema,
  BackupResultSchema,
  DbQueryResultSchema,
  DbQuerySchema,
  RestoreJobSchema,
  RestoreResultSchema,
  VOLUME_QUOTA_MODES,
  VolumeCopyInSchema,
  VolumeCopyOutSchema,
  VolumeDeleteSchema,
  VolumeStatusSchema,
} from "./data";
import {
  ExecCloseSchema,
  ExecExitSchema,
  ExecInputSchema,
  ExecOpenedSchema,
  ExecOpenSchema,
  ExecOutputSchema,
  ExecResizeSchema,
} from "./exec";
import { ImagePushResultSchema, ImagePushSchema } from "./image-push";
import { JobCancelSchema, JobRunSchema, JobStatusSchema } from "./jobs";
import {
  boundedString,
  CACHE_KEY_RE,
  COMMIT_SHA_RE,
  DIGEST_RE,
  ENV_KEY_RE,
  GitRefString,
  HostnameString,
  IdString,
  IMAGE_REPOSITORY_RE,
  MAX_BUILD_ARG_VALUE_BYTES,
  MAX_BUILD_ARGS,
  MAX_LOG_FRAME_TEXT_BYTES,
  MAX_LOG_LINE_BYTES,
  MAX_LOG_LINES_PER_FRAME,
  MAX_MESSAGE_BYTES,
  MAX_PINNED_SIGNING_KEYS,
  MAX_STATUSES_PER_HELLO,
  MAX_VOLUMES_PER_NODE,
  MAX_WORKLOADS_PER_NODE,
  NODE_ENCRYPTION_KEY_ID_RE,
  RelativePath,
  SIGNING_KEY_ID_RE,
  UnixMillis,
  utf8ByteLength,
} from "./limits";
import { HelloMeshSchema, MeshConfigSchema, MeshKeySchema, MeshStatusSchema } from "./mesh";
import { MAX_METRICS_INTERVAL_MS, MetricsSchema, MIN_METRICS_INTERVAL_MS } from "./metrics";
import {
  WalArchiveAckSchema,
  WalArchiveSchema,
  WalFetchRequestSchema,
  WalFetchSchema,
} from "./pitr";
import { KeyAnnounceSchema, SigningKeyAnnouncementsSchema } from "./signing-keys";
import {
  BUILD_ISOLATIONS,
  buildCacheKey,
  INGRESS_TLS_MODES,
  localImageRepository,
  REGISTRY_LISTEN,
  RegistryConfigSchema,
  VolumeSpecSchema,
  WorkloadSpecSchema,
} from "./workload";

// -----------------------------------------------------------------------------
// Shared shapes
// -----------------------------------------------------------------------------

/**
 * Free-form identifier text reported by an agent (OS name, kernel, versions).
 * Bounded because it is stored and rendered verbatim.
 */
export const ShortText = z.string().max(256);

/** Static hardware facts collected once at agent start. */
export const HardwareSchema = z.object({
  cpu_cores: z.number().int().positive(),
  mem_bytes: z.number().int().nonnegative(),
  disk_bytes: z.number().int().nonnegative(),
});

/** Static hardware facts collected once at agent start. */
export type Hardware = z.infer<typeof HardwareSchema>;

/** Optional features a node can offer; drives scheduling decisions. */
export const CapabilitiesSchema = z.object({
  docker: z.boolean(),
  gvisor: z.boolean(),
  /** The node runs BuildKit and the local registry, and accepts `build_job`. */
  builder: z.boolean(),
  /**
   * The node runs Caddy for every route (ADR 0005). Absent means `true`.
   * Sent from `MESH_PROTOCOL_VERSION`.
   */
  ingress: z.boolean().optional(),
  /**
   * The node enforces `publish_allowed_cidrs` with a firewall rule it
   * installs before the port is published, so it runs workloads with
   * `ports[].publish` (ADR 0004, "TCP proxy"). Absent means `false`.
   */
  tcp_proxy: z.boolean().optional(),
  /** The node's query runner accepts the `set_password` op. Absent means `false`. */
  db_set_password: z.boolean().optional(),
});

/** Optional features a node can offer. */
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** Point-in-time resource usage for the whole node. */
export const NodeUsageSchema = z.object({
  cpu_percent: z.number().min(0).max(100),
  mem_used_bytes: z.number().int().nonnegative(),
  mem_total_bytes: z.number().int().nonnegative(),
  disk_used_bytes: z.number().int().nonnegative(),
  disk_total_bytes: z.number().int().nonnegative(),
  load1: z.number().nonnegative(),
});

/** Point-in-time resource usage for the whole node. */
export type NodeUsage = z.infer<typeof NodeUsageSchema>;

// -----------------------------------------------------------------------------
// Agent → control
// -----------------------------------------------------------------------------

/**
 * Lifecycle of one workload on a node, as the agent observes it:
 * - `pending`: accepted, not started yet;
 * - `pulling`: pulling the image;
 * - `starting`: container created and starting;
 * - `running`: process up, health not yet established (in its start period
 *   or before the first passing probe);
 * - `healthy`: probe passing, or up with no probe;
 * - `unhealthy`: probe failed `retries` times in a row;
 * - `exited`: stopped with exit code 0, or stopped by policy;
 * - `crashed`: exited non-zero or was OOM-killed;
 * - `removed`: container deleted (superseded or no longer desired).
 */
export const WORKLOAD_STATES = [
  "pending",
  "pulling",
  "starting",
  "running",
  "healthy",
  "unhealthy",
  "exited",
  "crashed",
  "removed",
] as const;

/** Lifecycle state of one workload; see {@link WORKLOAD_STATES}. */
export type WorkloadState = (typeof WORKLOAD_STATES)[number];

/** One workload's current status, as reported in `workload_status` and `hello.statuses`. */
export const WorkloadStatusReportSchema = z.object({
  workload_id: IdString,
  /** `null` for system workloads. */
  deployment_id: IdString.nullable(),
  state: z.enum(WORKLOAD_STATES),
  /** Docker container ID, once a container exists. */
  container_id: z
    .string()
    .regex(/^[a-f0-9]{12,64}$/, "expected a docker container id")
    .optional(),
  /** Last exit code, for `exited` and `crashed`. */
  exit_code: z.number().int().min(-1).max(255).optional(),
  /** Short human explanation, e.g. a pull or probe error. */
  message: boundedString(MAX_MESSAGE_BYTES).optional(),
  /** Restarts since the container was created. */
  restarts: z.number().int().nonnegative(),
  /** When the agent observed this state, unix ms. */
  ts: UnixMillis,
});

/** One workload's current status. */
export type WorkloadStatusReport = z.infer<typeof WorkloadStatusReportSchema>;

/**
 * A node's encryption key, signed by its Ed25519 identity key so a stolen
 * node credential alone can't swap in an attacker's key.
 */
export const NodeEncryptionKeySchema = z.object({
  /** X25519 public key, base64 (raw 32 bytes). */
  public_key: EncryptionPublicKeyString,
  /** `nodeEncryptionKeyId(public_key)`. */
  kid: z.string().regex(NODE_ENCRYPTION_KEY_ID_RE, "expected a key id"),
  /**
   * Ed25519 signature by the node's identity key over
   * `encryptionKeySignaturePayload(node_id, public_key)`, base64.
   */
  sig: z.string().regex(/^[A-Za-z0-9+/]{86}==$/, "expected a base64 Ed25519 signature"),
});

/** A node's signed encryption key. */
export type NodeEncryptionKey = z.infer<typeof NodeEncryptionKeySchema>;

/** First frame on every connection. Re-sent after each reconnect. */
export const HelloSchema = z.object({
  type: z.literal("hello"),
  protocol_version: z.number().int().positive(),
  node_id: z.string().max(64),
  agent_version: ShortText,
  os: ShortText,
  arch: z.enum(["amd64", "arm64"]),
  kernel: ShortText,
  docker_version: ShortText.nullable(),
  hardware: HardwareSchema,
  capabilities: CapabilitiesSchema,
  /** Last `desired_state` generation the agent applied; 0 on a fresh node. */
  observed_generation: z.number().int().nonnegative(),
  /**
   * Status of every workload the agent manages, so the control plane can
   * resynchronise after a reconnect. Sent from protocol version 2; absent
   * from version 1 agents.
   */
  statuses: z.array(WorkloadStatusReportSchema).max(MAX_STATUSES_PER_HELLO).optional(),
  /**
   * The agent's X25519 encryption key, for nodes that joined before
   * protocol 4 or lost theirs. Sent from `SEALED_ENV_PROTOCOL_VERSION`.
   * The control plane stores it only when the node has none yet; replacing a
   * key needs a re-join.
   */
  encryption_key: NodeEncryptionKeySchema.optional(),
  /**
   * WireGuard public key and reachability, when the agent's mesh is enabled.
   * Sent from `MESH_PROTOCOL_VERSION`.
   */
  mesh: HelloMeshSchema.optional(),
  /**
   * How this node enforces volume quotas, decided at agent start. The
   * scheduler won't migrate a quota-enforced volume onto a `none` node.
   * Sent from `VOLUMES_PROTOCOL_VERSION`.
   */
  volume_quota: z.enum(VOLUME_QUOTA_MODES).optional(),
  /**
   * Control-plane signing key IDs the agent accepts, current first. Sent
   * from `KEY_ROLLOVER_PROTOCOL_VERSION`.
   */
  pinned_kids: z
    .array(z.string().regex(SIGNING_KEY_ID_RE, "expected a signing key id"))
    .min(1)
    .max(MAX_PINNED_SIGNING_KEYS)
    .optional(),
});

/** First frame on every connection. */
export type Hello = z.infer<typeof HelloSchema>;

/** Periodic liveness + usage report. */
export const HeartbeatSchema = z.object({
  type: z.literal("heartbeat"),
  /** Monotonic per-process counter; lets the control plane spot gaps. */
  seq: z.number().int().nonnegative(),
  /** Agent wall-clock time, unix ms. Used only for skew diagnostics. */
  ts: z.number().int().nonnegative(),
  observed_generation: z.number().int().nonnegative(),
  usage: NodeUsageSchema,
});

/** Periodic liveness + usage report. */
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

/** Sent whenever a workload changes state. */
export const WorkloadStatusSchema = WorkloadStatusReportSchema.extend({
  type: z.literal("workload_status"),
});

/** Sent whenever a workload changes state. */
export type WorkloadStatus = z.infer<typeof WorkloadStatusSchema>;

/** Output streams a log line can come from. `system` lines are written by the agent itself. */
export const LOG_STREAMS = ["stdout", "stderr", "system"] as const;

/** Log stream; see {@link LOG_STREAMS}. */
export type LogStream = (typeof LOG_STREAMS)[number];

/** Logs of a running replica. */
export const RuntimeLogSourceSchema = z.object({
  type: z.literal("runtime"),
  workload_id: IdString,
  deployment_id: IdString,
});

/** Logs of a build. */
export const BuildLogSourceSchema = z.object({
  type: z.literal("build"),
  build_id: IdString,
});

/** Logs of a job run (ADR 0010), from `JOBS_PROTOCOL_VERSION`. */
export const JobLogSourceSchema = z.object({
  type: z.literal("job"),
  run_id: IdString,
  workload_id: IdString,
});

/**
 * Output of a backup, restore or volume copy (ADR 0004), from
 * `BACKUPS_PROTOCOL_VERSION`. `task_id` is the `bak_`, `rst_` or `mig_` ID.
 */
export const TaskLogSourceSchema = z.object({
  type: z.literal("task"),
  task_id: IdString,
});

/**
 * Phase 1 log sources: a replica or a build. Kept as its own union because
 * the node DO's log ingest narrows on exactly these two; see
 * {@link AnyLogSourceSchema} for every source.
 */
export const LogSourceSchema = z.discriminatedUnion("type", [
  RuntimeLogSourceSchema,
  BuildLogSourceSchema,
]);

/** A Phase 1 log source. */
export type LogSource = z.infer<typeof LogSourceSchema>;

/** Every log source: replica, build, job run, or task. */
export const AnyLogSourceSchema = z.discriminatedUnion("type", [
  RuntimeLogSourceSchema,
  BuildLogSourceSchema,
  JobLogSourceSchema,
  TaskLogSourceSchema,
]);

/** Every log source. */
export type AnyLogSource = z.infer<typeof AnyLogSourceSchema>;

/** One log line. */
export const LogLineSchema = z.object({
  /** When the line was written, unix ms. */
  ts: UnixMillis,
  stream: z.enum(LOG_STREAMS),
  /** Line text without the trailing newline, truncated with `truncateLogLine`. */
  text: boundedString(MAX_LOG_LINE_BYTES),
});

/** One log line. */
export type LogLine = z.infer<typeof LogLineSchema>;

const LogLines = z
  .array(LogLineSchema)
  .min(1)
  .max(MAX_LOG_LINES_PER_FRAME)
  .refine(
    (lines) => lines.reduce((n, l) => n + utf8ByteLength(l.text), 0) <= MAX_LOG_FRAME_TEXT_BYTES,
    { message: `at most ${MAX_LOG_FRAME_TEXT_BYTES} bytes of text per frame` },
  );

/**
 * A batch of log lines from one Phase 1 source, flushed at least every
 * second. At most {@link MAX_LOG_LINES_PER_FRAME} lines and
 * {@link MAX_LOG_FRAME_TEXT_BYTES} of text per frame.
 */
export const LogsSchema = z.object({
  type: z.literal("logs"),
  source: LogSourceSchema,
  lines: LogLines,
});

/** A batch of log lines from one Phase 1 source. */
export type Logs = z.infer<typeof LogsSchema>;

/** A `logs` frame from any source; see {@link AnyLogSourceSchema}. */
export const AnyLogsSchema = z.object({
  type: z.literal("logs"),
  source: AnyLogSourceSchema,
  lines: LogLines,
});

/** A `logs` frame from any source. */
export type AnyLogs = z.infer<typeof AnyLogsSchema>;

/** An image pushed to the builder's local registry. */
export const BuiltImageSchema = z.object({
  repository: z.string().max(512).regex(IMAGE_REPOSITORY_RE, "expected an image repository"),
  digest: z.string().regex(DIGEST_RE, "expected a sha256 digest"),
});

/** An image pushed to the builder's local registry. */
export type BuiltImage = z.infer<typeof BuiltImageSchema>;

/** Outcome of a `build_job`: an image on success, an error otherwise. */
export const BuildResultSchema = z
  .object({
    type: z.literal("build_result"),
    build_id: IdString,
    ok: z.boolean(),
    /** Present exactly when `ok`. */
    image: BuiltImageSchema.optional(),
    /** Present exactly when not `ok`. */
    error: boundedString(MAX_MESSAGE_BYTES, 1).optional(),
    /**
     * The build stopped because of a `build_cancel` (or the agent shutting
     * down) rather than failing. Only on failed results; sent from protocol
     * version 3.
     */
    cancelled: z.boolean().optional(),
    duration_ms: z.number().int().nonnegative(),
  })
  .refine((r) => (r.ok ? r.image && !r.error : !r.image && r.error), {
    message: "a successful result has an image and no error; a failed one, the reverse",
  })
  .refine((r) => !(r.ok && r.cancelled), {
    message: "only a failed result can be cancelled",
    path: ["cancelled"],
  });

/** Outcome of a `build_job`. */
export type BuildResult = z.infer<typeof BuildResultSchema>;

/**
 * The Phase 1 agent frames, which the node DO's dispatch handles today.
 * {@link AgentFrameSchema} adds every Phase 2–3 frame; the DO moves to it
 * with the frame-table split of ADR 0013.
 */
export const AgentMessageSchema = z.discriminatedUnion("type", [
  HelloSchema,
  HeartbeatSchema,
  WorkloadStatusSchema,
  LogsSchema,
  BuildResultSchema,
]);

/** A Phase 1 agent frame. */
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

/**
 * Every frame an agent may send, each only at or above its gate: the
 * Phase 1 frames (with `logs` from any source) plus mesh, volume, backup,
 * query, job, metrics and certificate reports. `schema/agent-message.json`
 * is generated from it.
 */
export const AgentFrameSchema = z.discriminatedUnion("type", [
  HelloSchema,
  HeartbeatSchema,
  WorkloadStatusSchema,
  AnyLogsSchema,
  BuildResultSchema,
  MeshStatusSchema,
  MeshKeySchema,
  VolumeStatusSchema,
  BackupPartsRequestSchema,
  BackupProgressSchema,
  BackupResultSchema,
  RestoreResultSchema,
  DbQueryResultSchema,
  JobStatusSchema,
  MetricsSchema,
  CertAckSchema,
  CertRequestSchema,
  CertStatusSchema,
  ExecOpenedSchema,
  ExecOutputSchema,
  ExecExitSchema,
  ImagePushResultSchema,
  WalArchiveSchema,
  WalFetchRequestSchema,
]);

/** Every frame an agent may send. */
export type AgentFrame = z.infer<typeof AgentFrameSchema>;

// -----------------------------------------------------------------------------
// Control → agent (always wrapped in a signed envelope, see ./signing)
// -----------------------------------------------------------------------------

/** Acknowledges `hello` and tells the agent how to behave on this connection. */
export const WelcomeSchema = z.object({
  type: z.literal("welcome"),
  ...ControlHeader,
  heartbeat_interval_ms: z.number().int().positive(),
  /**
   * Successor signing keys to pin next to the current one, signed by it.
   * Sent from `KEY_ROLLOVER_PROTOCOL_VERSION`. Never names the envelope's
   * own kid; see `announcesSigningKid`.
   */
  next_keys: SigningKeyAnnouncementsSchema.optional(),
  /**
   * Asks a metrics-capable agent to send `metrics` at this interval; absent
   * means none. Sent from `METRICS_PROTOCOL_VERSION`.
   */
  metrics_interval_ms: z
    .number()
    .int()
    .min(MIN_METRICS_INTERVAL_MS)
    .max(MAX_METRICS_INTERVAL_MS)
    .optional(),
});

/** Acknowledges `hello`. */
export type Welcome = z.infer<typeof WelcomeSchema>;

/**
 * The complete desired state of a node. The agent converges Docker and Caddy
 * to it and removes managed containers that are no longer listed.
 */
export const DesiredStateSchema = z
  .object({
    type: z.literal("desired_state"),
    ...ControlHeader,
    /** Monotonic; agents ignore anything older than what they've applied. */
    generation: z.number().int().nonnegative(),
    /**
     * Every `service` and `route` workload the node should run. System
     * workloads are never listed, nor are jobs (they arrive in `job_run`).
     */
    workloads: z.array(WorkloadSpecSchema).max(MAX_WORKLOADS_PER_NODE),
    /** `managed` only from `CERTS_PROTOCOL_VERSION`. */
    tls_mode: z.enum(INGRESS_TLS_MODES),
    /** Domain generated hostnames live under; `null` until an operator sets one. */
    apps_domain: HostnameString.nullable(),
    /**
     * Registry the node must run: builders always; from
     * `MESH_PROTOCOL_VERSION`, meshed non-builders as `replica` or `proxy`.
     */
    registry: RegistryConfigSchema.nullable(),
    /**
     * Every volume the node holds, including those of services scaled to
     * zero. Sent from `VOLUMES_PROTOCOL_VERSION`; absent from older frames.
     */
    volumes: z.array(VolumeSpecSchema).max(MAX_VOLUMES_PER_NODE).optional(),
    /**
     * The mesh; `null` tears it down. Sent from `MESH_PROTOCOL_VERSION`;
     * absent (as from an older control plane) behaves like `null`.
     */
    mesh: MeshConfigSchema.nullish(),
    /** Node-level Caddy settings. Sent from `CERTS_PROTOCOL_VERSION`. */
    ingress: IngressSettingsSchema.optional(),
    /** Certificates the node must hold, bodies via `cert_sync`. From `CERTS_PROTOCOL_VERSION`. */
    certificates: CertificateManifestSchema.optional(),
  })
  .superRefine((m, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });
    const volumes = new Map((m.volumes ?? []).map((v) => [v.id, v]));
    if (volumes.size !== (m.volumes ?? []).length) issue("duplicate volume", ["volumes"]);
    const ids = new Set<string>();
    m.workloads.forEach((w, i) => {
      if (w.kind !== "service" && w.kind !== "route") {
        issue("only service and route workloads are sent", ["workloads", i, "kind"]);
      }
      if (ids.has(w.id)) issue(`duplicate workload ${w.id}`, ["workloads", i, "id"]);
      ids.add(w.id);
      for (const mount of w.mounts ?? []) {
        const v = volumes.get(mount.volume_id);
        if (!v) {
          issue(`mount of unlisted volume ${mount.volume_id}`, ["workloads", i, "mounts"]);
        } else if (
          v.project_id !== w.project_id ||
          v.environment_id !== w.environment_id ||
          v.service_id !== w.service_id
        ) {
          issue(`volume ${v.id} belongs to another service`, ["workloads", i, "mounts"]);
        }
      }
      if (!m.mesh && (w.kind === "route" || w.mesh_ip !== undefined || w.private_dns)) {
        issue("route workloads, mesh_ip and private_dns need the mesh", ["workloads", i]);
      }
    });
    if (m.tls_mode === "managed" && !m.ingress) issue("managed TLS needs ingress", ["ingress"]);
    if (carriesCredentials(m) && !isShortLived(m))
      ctx.addIssue({ code: "custom", ...SHORT_LIVED_ISSUE });
  });

/** The complete desired state of a node. */
export type DesiredState = z.infer<typeof DesiredStateSchema>;

/** Where a build's source comes from. Only git in Phase 1. */
export const GitBuildSourceSchema = z.object({
  type: z.literal("git"),
  /** `https://` clone URL, without credentials. */
  url: z
    .string()
    .max(2048)
    .regex(/^https:\/\/[^\s/@?#]+\/[^\s?#]+$/, "expected an https clone URL without credentials"),
  commit_sha: z.string().regex(COMMIT_SHA_RE, "expected a full commit sha"),
  /**
   * Ref the commit was resolved from, for display and shallow fetch. Agents
   * pass it after `--end-of-options` and fetch by `commit_sha` regardless.
   */
  ref: GitRefString.optional(),
  /** GitHub installation token for private repositories. Forces a short `exp`. */
  token: boundedString(4096, 1).optional(),
});

/** Where a build's source comes from. */
export type GitBuildSource = z.infer<typeof GitBuildSourceSchema>;

/** Image builders. `dockerfile` uses the repository's Dockerfile; `railpack` detects the stack. */
export const BUILDERS = ["railpack", "dockerfile"] as const;

/** Image builder; see {@link BUILDERS}. */
export type Builder = (typeof BUILDERS)[number];

/** Build an image and push it to the node's local registry; answered by `build_result`. */
export const BuildJobSchema = z
  .object({
    type: z.literal("build_job"),
    ...ControlHeader,
    build_id: IdString,
    deployment_id: IdString,
    /** Owning project; selects the project's isolated BuildKit instance. */
    project_id: IdString,
    service_id: IdString,
    source: GitBuildSourceSchema,
    builder: z.enum(BUILDERS),
    /** Relative to `context_dir`; defaults to `Dockerfile`. Only for the `dockerfile` builder. */
    dockerfile_path: RelativePath.optional(),
    /** Build context inside the repository; `.` for the root. */
    context_dir: RelativePath,
    /** Plain values passed as `--build-arg` (Dockerfile `ARG`). Never secrets. */
    build_args: z
      .record(
        z.string().max(256).regex(ENV_KEY_RE, "expected a build arg name"),
        boundedString(MAX_BUILD_ARG_VALUE_BYTES),
      )
      .refine((a) => Object.keys(a).length <= MAX_BUILD_ARGS, {
        message: `at most ${MAX_BUILD_ARGS} build args`,
      }),
    /**
     * Names of `build_args` whose values are secret. The builder passes them
     * as BuildKit secrets, never as build args (which end up in the image's
     * history), and redacts their values from build output. Sent from
     * protocol version 3; see `SECRET_BUILD_ARGS_PROTOCOL_VERSION`.
     */
    secret_build_args: z
      .array(z.string().max(256).regex(ENV_KEY_RE, "expected a build arg name"))
      .max(MAX_BUILD_ARGS)
      .optional(),
    /**
     * BuildKit secrets (`RUN --mount=type=secret,id=KEY`), sealed to the
     * builder node; see `SealedBuildSecretsSchema` and `buildSecretsAad`.
     * Absent when the build uses none.
     */
    build_secrets_sealed: SealedBoxSchema.optional(),
    /** Exactly `localImageRepository(project_id, service_id)`. */
    image_repository: z
      .string()
      .max(512)
      .regex(IMAGE_REPOSITORY_RE, "expected an image repository")
      .refine((r) => r.startsWith(`${REGISTRY_LISTEN}/`), {
        message: `must be in the local registry at ${REGISTRY_LISTEN}`,
      }),
    /**
     * `preview` for pull request code: built in the project's preview BuildKit
     * daemon (`<project_id>-preview`) with its own cache (ADR 0014 section
     * 14). Sent from protocol version 7; see `PREVIEW_BUILDS_PROTOCOL_VERSION`.
     */
    isolation: z.enum(BUILD_ISOLATIONS).optional(),
    /** Exactly `buildCacheKey(project_id, service_id, isolation)`. */
    cache_key: z.string().regex(CACHE_KEY_RE, "expected a cache key"),
    /** The builder cancels and fails the build after this many seconds. */
    timeout_s: z.number().int().min(60).max(7200),
  })
  .refine((j) => j.builder === "dockerfile" || j.dockerfile_path === undefined, {
    message: "dockerfile_path is only allowed with the dockerfile builder",
    path: ["dockerfile_path"],
  })
  .refine(
    (j) =>
      !j.secret_build_args ||
      (new Set(j.secret_build_args).size === j.secret_build_args.length &&
        j.secret_build_args.every((name) => Object.hasOwn(j.build_args, name))),
    {
      message: "secret_build_args must name distinct keys of build_args",
      path: ["secret_build_args"],
    },
  )
  .refine((j) => j.image_repository === localImageRepository(j.project_id, j.service_id), {
    message: "image_repository must be the service's local repository",
    path: ["image_repository"],
  })
  .refine((j) => j.cache_key === buildCacheKey(j.project_id, j.service_id, j.isolation), {
    message: "cache_key must be buildCacheKey(project_id, service_id, isolation)",
    path: ["cache_key"],
  })
  .refine((j) => !carriesCredentials(j) || isShortLived(j), SHORT_LIVED_ISSUE);

/** Build an image and push it to the node's local registry. */
export type BuildJob = z.infer<typeof BuildJobSchema>;

/**
 * Stops a running build. The builder aborts the solve and kills its git and
 * Railpack processes, then answers the build's `build_job` with a failed
 * `build_result` marked `cancelled`, which frees it for the next job. A
 * cancel for a build that has not arrived yet is remembered briefly, so the
 * job is answered as cancelled without running; one for a build already
 * finished is ignored. Sent from protocol version 3; see
 * `BUILD_CANCEL_PROTOCOL_VERSION`.
 */
export const BuildCancelSchema = z.object({
  type: z.literal("build_cancel"),
  ...ControlHeader,
  build_id: IdString,
});

/** Stops a running build. */
export type BuildCancel = z.infer<typeof BuildCancelSchema>;

/** Any payload the control plane may sign and send, each only at or above its gate. */
export const ControlMessageSchema = z.discriminatedUnion("type", [
  WelcomeSchema,
  DesiredStateSchema,
  BuildJobSchema,
  BuildCancelSchema,
  KeyAnnounceSchema,
  VolumeDeleteSchema,
  BackupJobSchema,
  BackupPartsSchema,
  RestoreJobSchema,
  VolumeCopyOutSchema,
  VolumeCopyInSchema,
  DbQuerySchema,
  JobRunSchema,
  JobCancelSchema,
  CertSyncSchema,
  ExecOpenSchema,
  ExecInputSchema,
  ExecResizeSchema,
  ExecCloseSchema,
  ImagePushSchema,
  WalArchiveAckSchema,
  WalFetchSchema,
]);

/** Any payload the control plane may sign and send. */
export type ControlMessage = z.infer<typeof ControlMessageSchema>;

/**
 * Control frames that always carry a credential (a sealed box or presigned
 * URLs), and so live at most `CREDENTIAL_FRAME_TTL_MS`. Every `exec_*`
 * frame is listed even where it carries no box: ADR 0014 §15 gives the whole
 * shell protocol the short lifetime, so a captured frame can't be replayed
 * into a later session.
 */
export const CREDENTIAL_FRAME_TYPES = [
  "backup_job",
  "backup_parts",
  "restore_job",
  "volume_copy_out",
  "volume_copy_in",
  "db_query",
  "job_run",
  "exec_open",
  "exec_input",
  "exec_resize",
  "exec_close",
  "image_push",
  "wal_archive_ack",
  "wal_fetch",
] as const;

/**
 * Whether a control payload carries a credential (a git token, a registry
 * password, object-storage keys, or a sealed box). Such frames must expire
 * within `CREDENTIAL_FRAME_TTL_MS` of `iat`; the schemas reject longer ones.
 *
 * - `desired_state`: S3 registry storage, a proxy registry's upstream, a
 *   workload's `registry_auth` or `env_sealed`, or the mesh's sealed PSKs.
 * - `build_job`: a git token or sealed build secrets.
 * - `cert_sync`: any upsert (sealed private keys).
 * - Every type in {@link CREDENTIAL_FRAME_TYPES}.
 *
 * @param message - A control payload, before or after signing.
 * @returns `true` when the short expiry applies.
 */
export function carriesCredentials(
  message:
    | {
        type: "desired_state";
        workloads: readonly { registry_auth?: unknown; env_sealed?: unknown }[];
        registry: { storage: { type: string }; upstream?: unknown } | null;
        mesh?: { psks_sealed: unknown } | null;
      }
    | { type: "build_job"; source: { token?: string }; build_secrets_sealed?: unknown }
    | { type: "cert_sync"; upserts: readonly unknown[] }
    | { type: (typeof CREDENTIAL_FRAME_TYPES)[number] }
    | { type: "welcome" | "build_cancel" | "key_announce" | "volume_delete" | "job_cancel" },
): boolean {
  switch (message.type) {
    case "desired_state":
      return (
        message.registry?.storage.type === "s3" ||
        !!message.registry?.upstream ||
        !!message.mesh?.psks_sealed ||
        message.workloads.some((w) => !!w.registry_auth || !!w.env_sealed)
      );
    case "build_job":
      return message.source.token !== undefined || !!message.build_secrets_sealed;
    case "cert_sync":
      return message.upserts.length > 0;
    default:
      return (CREDENTIAL_FRAME_TYPES as readonly string[]).includes(message.type);
  }
}
