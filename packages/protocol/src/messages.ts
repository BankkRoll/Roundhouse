/**
 * Zod schemas for every frame on the agent WebSocket.
 *
 * - Agent → control: `hello`, `heartbeat`, `workload_status`, `logs`,
 *   `build_result`.
 * - Control → agent, always inside a signed envelope (./signing): `welcome`,
 *   `desired_state`, `build_job`, `build_cancel`.
 *
 * @module
 */
import { z } from "zod";
import {
  boundedString,
  CACHE_KEY_RE,
  COMMIT_SHA_RE,
  CREDENTIAL_FRAME_TTL_MS,
  DIGEST_RE,
  ENV_KEY_RE,
  HostnameString,
  IdString,
  IMAGE_REPOSITORY_RE,
  MAX_BUILD_ARG_VALUE_BYTES,
  MAX_BUILD_ARGS,
  MAX_LOG_FRAME_TEXT_BYTES,
  MAX_LOG_LINE_BYTES,
  MAX_LOG_LINES_PER_FRAME,
  MAX_MESSAGE_BYTES,
  MAX_STATUSES_PER_HELLO,
  MAX_WORKLOADS_PER_NODE,
  RelativePath,
  UnixMillis,
  utf8ByteLength,
} from "./limits";
import { REGISTRY_LISTEN, RegistryConfigSchema, TLS_MODES, WorkloadSpecSchema } from "./workload";

/**
 * Current wire protocol version, sent by agents in `hello`.
 *
 * - Version 2 (Phase 1) is additive: every version 1 frame is still valid,
 *   and a version 1 agent still decodes version 2 `desired_state` (it reads
 *   only `id` and `image` of each workload and ignores unknown fields). It is
 *   bumped anyway because the control plane must know whether an agent
 *   understands `build_job`, runs workloads, and reports statuses and logs:
 *   it never sends `build_job` to, or places workloads on, an agent below
 *   version 2.
 * - Version 3 is additive too: `build_cancel`, `build_job.secret_build_args`
 *   and `build_result.cancelled`. A version 2 agent would drop the first and,
 *   worse, ignore the second and bake secret build args into the image, so
 *   the control plane sends neither below {@link BUILD_CANCEL_PROTOCOL_VERSION}
 *   and {@link SECRET_BUILD_ARGS_PROTOCOL_VERSION}.
 */
export const PROTOCOL_VERSION = 3;

/**
 * Oldest `hello.protocol_version` the control plane accepts. Every version
 * since 1 has been additive, so version 1 agents are still accepted; they
 * just get no workloads and no builds.
 */
export const MIN_PROTOCOL_VERSION = 1;

/** First protocol version whose agents run workloads and builds. */
export const WORKLOADS_PROTOCOL_VERSION = 2;

/** First protocol version whose agents understand `build_cancel`. */
export const BUILD_CANCEL_PROTOCOL_VERSION = 3;

/**
 * First protocol version whose agents honour `build_job.secret_build_args`.
 * A build with secret args is never sent to an older agent.
 */
export const SECRET_BUILD_ARGS_PROTOCOL_VERSION = 3;

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

/** What a `logs` frame belongs to. */
export const LogSourceSchema = z.discriminatedUnion("type", [
  RuntimeLogSourceSchema,
  BuildLogSourceSchema,
]);

/** What a `logs` frame belongs to. */
export type LogSource = z.infer<typeof LogSourceSchema>;

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

/**
 * A batch of log lines from one source, flushed at least every second. At
 * most {@link MAX_LOG_LINES_PER_FRAME} lines and
 * {@link MAX_LOG_FRAME_TEXT_BYTES} of text per frame.
 */
export const LogsSchema = z.object({
  type: z.literal("logs"),
  source: LogSourceSchema,
  lines: z
    .array(LogLineSchema)
    .min(1)
    .max(MAX_LOG_LINES_PER_FRAME)
    .refine(
      (lines) => lines.reduce((n, l) => n + utf8ByteLength(l.text), 0) <= MAX_LOG_FRAME_TEXT_BYTES,
      { message: `at most ${MAX_LOG_FRAME_TEXT_BYTES} bytes of text per frame` },
    ),
});

/** A batch of log lines from one source. */
export type Logs = z.infer<typeof LogsSchema>;

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

/** Any frame an agent may send. */
export const AgentMessageSchema = z.discriminatedUnion("type", [
  HelloSchema,
  HeartbeatSchema,
  WorkloadStatusSchema,
  LogsSchema,
  BuildResultSchema,
]);

/** Any frame an agent may send. */
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

// -----------------------------------------------------------------------------
// Control → agent (always wrapped in a signed envelope, see ./signing)
// -----------------------------------------------------------------------------

/** Fields every signed control payload carries to prevent replay and misrouting. */
const ControlHeader = {
  /** Unique message ID. */
  id: z.string(),
  /** Target node; agents reject payloads addressed to another node. */
  node_id: z.string(),
  /** Issued-at, unix ms. */
  iat: z.number().int().nonnegative(),
  /**
   * Expiry, unix ms. Agents reject expired payloads. At most
   * {@link CREDENTIAL_FRAME_TTL_MS} after `iat` when the frame carries a
   * credential; see {@link carriesCredentials}.
   */
  exp: z.number().int().nonnegative(),
};

const shortLived = (m: { iat: number; exp: number }) => m.exp - m.iat <= CREDENTIAL_FRAME_TTL_MS;
const SHORT_LIVED_ISSUE = {
  message: `frames carrying credentials must expire within ${CREDENTIAL_FRAME_TTL_MS} ms`,
  path: ["exp"],
};

/** Acknowledges `hello` and tells the agent how to behave on this connection. */
export const WelcomeSchema = z.object({
  type: z.literal("welcome"),
  ...ControlHeader,
  heartbeat_interval_ms: z.number().int().positive(),
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
    /** Every `service` workload the node should run. System workloads are never listed. */
    workloads: z.array(WorkloadSpecSchema).max(MAX_WORKLOADS_PER_NODE),
    tls_mode: z.enum(TLS_MODES),
    /** Domain generated hostnames live under; `null` until an operator sets one. */
    apps_domain: HostnameString.nullable(),
    /** Registry the node must run; set only for builder nodes. */
    registry: RegistryConfigSchema.nullable(),
  })
  .superRefine((m, ctx) => {
    const ids = new Set<string>();
    m.workloads.forEach((w, i) => {
      if (w.kind !== "service") {
        ctx.addIssue({
          code: "custom",
          message: "only service workloads are sent",
          path: ["workloads", i, "kind"],
        });
      }
      if (ids.has(w.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate workload ${w.id}`,
          path: ["workloads", i, "id"],
        });
      }
      ids.add(w.id);
    });
    if (carriesCredentials(m) && !shortLived(m))
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
  /** Ref the commit was resolved from, for display and shallow fetch. */
  ref: boundedString(256, 1).optional(),
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
    source: GitBuildSourceSchema,
    builder: z.enum(BUILDERS),
    /** Relative to `context_dir`; defaults to `Dockerfile`. Only for the `dockerfile` builder. */
    dockerfile_path: RelativePath.optional(),
    /** Build context inside the repository; `.` for the root. */
    context_dir: RelativePath,
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
     * protocol version 3; see {@link SECRET_BUILD_ARGS_PROTOCOL_VERSION}.
     */
    secret_build_args: z
      .array(z.string().max(256).regex(ENV_KEY_RE, "expected a build arg name"))
      .max(MAX_BUILD_ARGS)
      .optional(),
    /** Repository to push to, in the local registry; see `localImageRepository`. */
    image_repository: z
      .string()
      .max(512)
      .regex(IMAGE_REPOSITORY_RE, "expected an image repository")
      .refine((r) => r.startsWith(`${REGISTRY_LISTEN}/`), {
        message: `must be in the local registry at ${REGISTRY_LISTEN}`,
      }),
    /** BuildKit cache scope; builds sharing a key share layers. */
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
  .refine((j) => !carriesCredentials(j) || shortLived(j), SHORT_LIVED_ISSUE);

/** Build an image and push it to the node's local registry. */
export type BuildJob = z.infer<typeof BuildJobSchema>;

/**
 * Stops a running build. The builder aborts the solve and kills its git and
 * Railpack processes, then answers the build's `build_job` with a failed
 * `build_result` marked `cancelled`, which frees it for the next job. A
 * cancel for a build that has not arrived yet is remembered briefly, so the
 * job is answered as cancelled without running; one for a build already
 * finished is ignored. Sent from protocol version 3; see
 * {@link BUILD_CANCEL_PROTOCOL_VERSION}.
 */
export const BuildCancelSchema = z.object({
  type: z.literal("build_cancel"),
  ...ControlHeader,
  build_id: IdString,
});

/** Stops a running build. */
export type BuildCancel = z.infer<typeof BuildCancelSchema>;

/** Any payload the control plane may sign and send. */
export const ControlMessageSchema = z.discriminatedUnion("type", [
  WelcomeSchema,
  DesiredStateSchema,
  BuildJobSchema,
  BuildCancelSchema,
]);

/** Any payload the control plane may sign and send. */
export type ControlMessage = z.infer<typeof ControlMessageSchema>;

/**
 * Whether a control payload carries a credential (a git token, a registry
 * password, or object-storage keys). Such frames must expire within
 * {@link CREDENTIAL_FRAME_TTL_MS} of `iat`; the schemas reject longer ones.
 *
 * @param message - A control payload, before or after signing.
 * @returns `true` when the short expiry applies.
 */
export function carriesCredentials(
  message:
    | {
        type: "desired_state";
        workloads: readonly { registry_auth?: unknown }[];
        registry: { storage: { type: string } } | null;
      }
    | { type: "build_job"; source: { token?: string } }
    | { type: "welcome" }
    | { type: "build_cancel" },
): boolean {
  switch (message.type) {
    case "desired_state":
      return (
        message.registry?.storage.type === "s3" || message.workloads.some((w) => !!w.registry_auth)
      );
    case "build_job":
      return message.source.token !== undefined;
    default:
      return false;
  }
}
