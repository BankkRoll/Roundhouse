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
