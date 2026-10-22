/**
 * Zod schemas for every frame on the agent WebSocket: agent → control frames
 * (`hello`, `heartbeat`) and the control → agent payloads that travel inside
 * signed envelopes (`welcome`, `desired_state`).
 *
 * @module
 */
import { z } from "zod";

/** Current wire protocol version, sent by agents in `hello`. */
export const PROTOCOL_VERSION = 1;

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

/** Optional features a node can offer; drives scheduling decisions later. */
export const CapabilitiesSchema = z.object({
  docker: z.boolean(),
  gvisor: z.boolean(),
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

/** Any frame an agent may send. */
export const AgentMessageSchema = z.discriminatedUnion("type", [HelloSchema, HeartbeatSchema]);

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
  /** Expiry, unix ms. Agents reject expired payloads. */
  exp: z.number().int().nonnegative(),
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
 * One container the node should be running. Deliberately minimal until
 * Phase 1 defines builds and deployments.
 */
export const WorkloadSchema = z.object({
  id: z.string(),
  image: z.string(),
});

/** One container the node should be running. */
export type Workload = z.infer<typeof WorkloadSchema>;

/** The complete set of workloads for a node. Agents converge to it. */
export const DesiredStateSchema = z.object({
  type: z.literal("desired_state"),
  ...ControlHeader,
  /** Monotonic; agents ignore anything older than what they've applied. */
  generation: z.number().int().nonnegative(),
  workloads: z.array(WorkloadSchema),
});

/** The complete set of workloads for a node. */
export type DesiredState = z.infer<typeof DesiredStateSchema>;

/** Any payload the control plane may sign and send. */
export const ControlMessageSchema = z.discriminatedUnion("type", [
  WelcomeSchema,
  DesiredStateSchema,
]);

/** Any payload the control plane may sign and send. */
export type ControlMessage = z.infer<typeof ControlMessageSchema>;
