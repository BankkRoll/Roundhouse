/**
 * Deployment and build lifecycles: the statuses stored in D1, what may follow
 * what ({@link canTransition}), and what starts a deployment.
 *
 * A deployment moves `queued → building → deploying → active`. Image sources
 * skip `building`. It ends `failed`, `crashed` or `cancelled`, or, after it
 * was `active`, `removed` (superseded) or `rolled_back` (superseded by a
 * rollback).
 *
 * @module
 */

/** Every status a deployment can have. */
export const DEPLOYMENT_STATUSES = [
  "queued",
  "building",
  "deploying",
  "active",
  "failed",
  "crashed",
  "cancelled",
  "removed",
  "rolled_back",
] as const;

/** Status of a deployment; see {@link DEPLOYMENT_STATUSES}. */
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/**
 * Allowed transitions. `crashed` is reachable only from `active` (a running
 * deployment whose replicas keep failing) and can recover to `active` when
 * they become healthy again; a deployment that never becomes healthy is
 * `failed` instead.
 */
const TRANSITIONS: Record<DeploymentStatus, readonly DeploymentStatus[]> = {
  queued: ["building", "deploying", "failed", "cancelled"],
  building: ["deploying", "failed", "cancelled"],
  deploying: ["active", "failed", "cancelled"],
  active: ["crashed", "removed", "rolled_back"],
  crashed: ["active", "removed", "rolled_back"],
  failed: [],
  cancelled: [],
  removed: [],
  rolled_back: [],
};

/**
 * Whether a deployment may move from one status to another. Updates should
 * also guard on the current status in their `WHERE` clause, so a concurrent
 * change can't slip in between the check and the write.
 *
 * @param from - Current status.
 * @param to - Proposed status.
 * @returns `true` when the transition is allowed. Staying in the same status
 *   is not a transition and returns `false`.
 * @example
 * canTransition("building", "deploying"); // true
 * canTransition("failed", "active"); // false
 */
export function canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Statuses a deployment may move to from `from`.
 *
 * @param from - Current status.
 * @returns Allowed next statuses, empty for terminal ones.
 */
export function nextStatuses(from: DeploymentStatus): readonly DeploymentStatus[] {
  return TRANSITIONS[from];
}

/**
 * Whether no further transition is possible.
 *
 * @param status - A deployment status.
 * @returns `true` for `failed`, `cancelled`, `removed` and `rolled_back`.
 */
export function isTerminalDeploymentStatus(status: DeploymentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** Statuses during which a deployment can still be cancelled. */
export const CANCELLABLE_DEPLOYMENT_STATUSES: readonly DeploymentStatus[] =
  DEPLOYMENT_STATUSES.filter((s) => canTransition(s, "cancelled"));

/** Statuses whose image and config can be rolled back to. */
export const ROLLBACK_SOURCE_STATUSES: readonly DeploymentStatus[] = [
  "active",
  "crashed",
  "removed",
  "rolled_back",
];

/** What started a deployment. */
export const DEPLOYMENT_TRIGGERS = [
  "push",
  "manual",
  "rollback",
  "api",
  "template",
  "change_set",
  "migration",
  /** Redeploy onto a new node after its volume was recovered there from a backup. */
  "recovery",
  /** Runs another environment's image, unchanged (ADR 0007, "Promote"). */
  "promote",
] as const;

/** What started a deployment; see {@link DEPLOYMENT_TRIGGERS}. */
export type DeploymentTrigger = (typeof DEPLOYMENT_TRIGGERS)[number];

/** Every status a build can have. */
export const BUILD_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;

/** Status of a build; see {@link BUILD_STATUSES}. */
export type BuildStatus = (typeof BUILD_STATUSES)[number];

/**
 * Event types recorded in `deployment_events` and streamed as
 * `deployment.event`. The message is human-readable; `data` carries details.
 */
export const DEPLOYMENT_EVENT_TYPES = [
  "status_changed",
  "build_started",
  "build_finished",
  "scheduled",
  "schedule_failed",
  "replica_status",
  "route_switched",
  "rollout_finished",
  "pre_deploy_started",
  "pre_deploy_finished",
  "image_pushed",
  "cf_rollout_started",
  "cf_rollout_finished",
  "routes_switched",
  "error",
] as const;

/** Type of a deployment event; see {@link DEPLOYMENT_EVENT_TYPES}. */
export type DeploymentEventType = (typeof DEPLOYMENT_EVENT_TYPES)[number];

/** How long a build may run before the builder cancels it. */
export const BUILD_TIMEOUT_S = 30 * 60;

/** How long a rollout waits for every replica to become healthy. */
export const ROLLOUT_TIMEOUT_MS = 10 * 60 * 1000;
