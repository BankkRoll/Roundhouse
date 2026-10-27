/** Human-facing product name. Kept in one place until naming is decided. */
export const PRODUCT_NAME = "Roundhouse";

/** Agent heartbeat interval. The control plane derives offline detection from it. */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Silence after which a node counts as offline: three missed heartbeats, so a
 * dead node is flagged within 30 seconds.
 */
export const OFFLINE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 3;

/**
 * How much longer than {@link OFFLINE_AFTER_MS} a node stays silent before
 * its stateless replicas are rescheduled elsewhere (ADR 0005, "Offline
 * handling"): long enough to ride out an agent restart or a network blip.
 */
export const RESCHEDULE_AFTER_MS = 120_000;

/**
 * Placement states the control plane sets on its own, never an agent
 * (ADR 0005):
 * - `lost`: the replica's node went offline and it was rescheduled; the row
 *   is deleted once the replacement is healthy or the node confirms removal;
 * - `parked`: a forced drain stopped a volume service's replica for
 *   maintenance; it runs again when the node is resumed.
 *
 * Both are left out of desired state, serving and the mesh.
 */
export const PLACEMENT_ONLY_STATES = ["lost", "parked"] as const;

/** See {@link PLACEMENT_ONLY_STATES}. */
export type PlacementOnlyState = (typeof PLACEMENT_ONLY_STATES)[number];

/** Service-level health, separate from deployment status (ADR 0005). */
export const SERVICE_HEALTH = ["ok", "degraded"] as const;

/** A service's health; see {@link SERVICE_HEALTH}. */
export type ServiceHealth = (typeof SERVICE_HEALTH)[number];

/**
 * Why a service is `degraded`: its stateful replica's node went offline, or
 * a forced drain stopped it for maintenance.
 */
export const SERVICE_HEALTH_REASONS = ["node_offline", "node_maintenance"] as const;

/** See {@link SERVICE_HEALTH_REASONS}. */
export type ServiceHealthReason = (typeof SERVICE_HEALTH_REASONS)[number];

/**
 * Lifecycle of a node drain (ADR 0005): `running` while replicas move,
 * `blocked` when volume services stop it without `force`, `failed` when a
 * move found no other node or never became healthy, `completed` once the
 * node is in maintenance, `cancelled` when the node was resumed first.
 */
export const NODE_DRAIN_STATUSES = [
  "running",
  "blocked",
  "failed",
  "completed",
  "cancelled",
] as const;

/** See {@link NODE_DRAIN_STATUSES}. */
export type NodeDrainStatus = (typeof NODE_DRAIN_STATUSES)[number];

/** One replica move of a drain: waiting, replacement started, done, failed, or stopped (forced volume service). */
export const DRAIN_MOVE_STATES = ["pending", "moving", "done", "failed", "stopped"] as const;

/** See {@link DRAIN_MOVE_STATES}. */
export type DrainMoveState = (typeof DRAIN_MOVE_STATES)[number];

/**
 * Lifetime of a node join token. Tokens are also single-use; the short window
 * limits how long a token copied into a terminal stays useful to anyone else.
 */
export const JOIN_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Lifecycle states a node can be in. */
export const NODE_STATUSES = [
  "pending",
  "online",
  "degraded",
  "offline",
  "draining",
  "maintenance",
] as const;

/** Lifecycle state of a node. */
export type NodeStatus = (typeof NODE_STATUSES)[number];

/**
 * Agent release the install script downloads by default (e.g. `"0.1.0"`).
 * Pinning it per control-plane release keeps new installs within the N-1
 * protocol window. Empty until the first agent release; the script then
 * falls back to the latest release.
 */
export const PINNED_AGENT_VERSION = "";

/** Days runtime and build logs are kept until an owner changes the `log_retention_days` setting. */
export const DEFAULT_LOG_RETENTION_DAYS = 7;

/** Longest log retention an owner can choose, in days. */
export const MAX_LOG_RETENTION_DAYS = 365;
