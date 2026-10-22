import { describe, expect, it } from "vitest";
import {
  CANCELLABLE_DEPLOYMENT_STATUSES,
  canTransition,
  DEPLOYMENT_STATUSES,
  type DeploymentStatus,
  isTerminalDeploymentStatus,
  nextStatuses,
} from "./deployments";

describe("canTransition", () => {
  it.each<[DeploymentStatus, DeploymentStatus]>([
    ["queued", "building"],
    ["queued", "deploying"],
    ["queued", "cancelled"],
    ["queued", "failed"],
    ["building", "deploying"],
    ["building", "failed"],
    ["building", "cancelled"],
    ["deploying", "active"],
    ["deploying", "failed"],
    ["deploying", "cancelled"],
    ["active", "crashed"],
    ["active", "removed"],
    ["active", "rolled_back"],
    ["crashed", "active"],
    ["crashed", "removed"],
    ["crashed", "rolled_back"],
  ])("allows %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each<[DeploymentStatus, DeploymentStatus]>([
    ["queued", "active"],
    ["building", "active"],
    ["building", "queued"],
    ["deploying", "building"],
    ["deploying", "crashed"],
    ["active", "cancelled"],
    ["active", "failed"],
    ["active", "deploying"],
    ["failed", "active"],
    ["cancelled", "queued"],
    ["removed", "active"],
    ["rolled_back", "active"],
  ])("forbids %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it("never allows staying in place", () => {
    for (const s of DEPLOYMENT_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  it("makes every status reachable from queued", () => {
    const seen = new Set<DeploymentStatus>(["queued"]);
    const queue: DeploymentStatus[] = ["queued"];
    while (queue.length) {
      for (const next of nextStatuses(queue.shift()!)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    expect([...seen].sort()).toEqual([...DEPLOYMENT_STATUSES].sort());
  });

  it("has exactly the four terminal statuses", () => {
    const terminal = DEPLOYMENT_STATUSES.filter(isTerminalDeploymentStatus);
    expect(terminal.sort()).toEqual(["cancelled", "failed", "removed", "rolled_back"]);
  });

  it("can cancel only before the deployment is live", () => {
    expect([...CANCELLABLE_DEPLOYMENT_STATUSES]).toEqual(["queued", "building", "deploying"]);
  });
});
