/**
 * Display helpers for deployments: what was deployed, how long it took, and which
 * actions apply to it.
 *
 * @module
 */
import { CANCELLABLE_DEPLOYMENT_STATUSES, ROLLBACK_SOURCE_STATUSES } from "@openrail/shared";
import type { Deployment } from "../../../lib/api/deploy-types";
import { EMPTY, formatCommit, formatDuration } from "../../../lib/format";

/** Readable trigger names. */
export const TRIGGER_LABELS: Record<Deployment["trigger"], string> = {
  push: "git push",
  manual: "manual",
  rollback: "rollback",
  api: "api",
  template: "template",
};

/**
 * What a deployment runs: the commit for git builds, else the image.
 *
 * @param deployment - A deployment.
 * @returns A short ref (`3f9c2b1`), an image, or {@link EMPTY}.
 */
export function deploymentRef(deployment: Deployment): string {
  if (deployment.build) return formatCommit(deployment.build.commit_sha);
  if (deployment.image) return deployment.image.replace(/@sha256:[a-f0-9]{64}$/, "");
  return EMPTY;
}

/**
 * A deployment id short enough for a label but still unique in practice: the type
 * prefix and the last six characters of a long id.
 *
 * @param id - Deployment id.
 * @returns E.g. `dep_…7XK2QM`, or the id itself when it is already short.
 * @example
 * shortDeploymentId("dep_01JB9ZK8M4V7Q2R5T6Y8W7XK2QM"); // "dep_…7XK2QM"
 */
export function shortDeploymentId(id: string): string {
  const split = id.indexOf("_") + 1;
  const rest = id.slice(split);
  return rest.length <= 8 ? id : `${id.slice(0, split)}…${rest.slice(-6)}`;
}

/**
 * Accessible name of a deployment: its ref plus its short id, because two deployments
 * often run the same commit or image (a redeploy, a rollback) and screen reader users
 * need to tell their rows and actions apart.
 *
 * @param deployment - A deployment.
 * @returns E.g. `3f9c2b1 (dep_…7XK2QM)`.
 */
export function deploymentName(deployment: Deployment): string {
  return `${deploymentRef(deployment)} (${shortDeploymentId(deployment.id)})`;
}

/**
 * How long a deployment took, or has been running.
 *
 * @param deployment - A deployment.
 * @param now - Current time, for deployments still in flight.
 * @returns e.g. `"1m 42s"`, or {@link EMPTY} before it started.
 */
export function deploymentDuration(deployment: Deployment, now: number): string {
  const start = deployment.started_at ?? deployment.created_at;
  const end = deployment.finished_at ?? (isCancellable(deployment) ? now : null);
  return end === null ? EMPTY : formatDuration(Math.max(0, end - start));
}

/**
 * Whether a deployment can still be cancelled.
 *
 * @param deployment - A deployment.
 * @returns `true` while queued, building or deploying.
 */
export function isCancellable(deployment: Pick<Deployment, "status">): boolean {
  return CANCELLABLE_DEPLOYMENT_STATUSES.includes(deployment.status);
}

/**
 * Whether rolling back to a deployment makes sense: it once ran successfully and is not
 * the one serving traffic now.
 *
 * @param deployment - Candidate deployment.
 * @param currentId - Id of the deployment serving traffic, if any.
 * @returns `true` when a rollback to it is allowed.
 */
export function canRollBackTo(deployment: Deployment, currentId: string | undefined): boolean {
  return ROLLBACK_SOURCE_STATUSES.includes(deployment.status) && deployment.id !== currentId;
}

/**
 * The deployment serving traffic: the newest `active` (or `crashed`) one.
 *
 * @param deployments - Deployments, newest first.
 * @returns Its id, or `undefined`.
 */
export function currentDeploymentId(deployments: readonly Deployment[]): string | undefined {
  return deployments.find((entry) => entry.status === "active" || entry.status === "crashed")?.id;
}
