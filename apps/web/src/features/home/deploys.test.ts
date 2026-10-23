import { describe, expect, it } from "vitest";
import { makeAuditEntry } from "../../mocks/db";
import { bucketDeploys, DEPLOY_HISTORY_DAYS } from "../../queries/audit";
import { activityTag } from "./activity-card";
import { axisMax } from "./deploys-chart";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Noon, so "an hour ago" is always the same calendar day.
const NOW = new Date(2026, 9, 22, 12, 0, 0).getTime();

const entry = (action: "deployment.created" | "deployment.failed" | "node.joined", ago: number) =>
  makeAuditEntry({ id: `aud_${action}_${ago}`, action, created_at: NOW - ago });

describe("bucketDeploys", () => {
  it("counts deploys per calendar day, today last", () => {
    const history = bucketDeploys(
      [
        entry("deployment.created", HOUR),
        entry("deployment.created", 2 * HOUR),
        entry("deployment.created", DAY),
        entry("deployment.failed", DAY),
        entry("node.joined", HOUR),
      ],
      NOW,
    );
    expect(history.days).toHaveLength(DEPLOY_HISTORY_DAYS);
    expect(history.days.at(-1)).toMatchObject({ deploys: 2, failed: 0 });
    expect(history.days.at(-2)).toMatchObject({ deploys: 1, failed: 1 });
    expect(history.total).toBe(3);
    expect(history.lastAt).toBe(NOW - HOUR);
    expect(history.partial).toBe(false);
  });

  it("ignores deploys older than the window and keeps zeros as zeros", () => {
    const history = bucketDeploys([entry("deployment.created", 30 * DAY)], NOW, true);
    expect(history.total).toBe(0);
    expect(history.lastAt).toBeNull();
    expect(history.days.every((day) => day.deploys === 0)).toBe(true);
    expect(history.partial).toBe(true);
  });
});

describe("axisMax", () => {
  it.each([
    [0, 2],
    [2, 2],
    [3, 4],
    [5, 6],
    [7, 10],
    [11, 20],
    [47, 60],
    [130, 200],
  ])("rounds %i up to %i", (max, expected) => {
    expect(axisMax(max)).toBe(expected);
  });
});

describe("activityTag", () => {
  it("names what an action touched, tinting only failures", () => {
    expect(activityTag("deployment.created")).toEqual({ label: "Deploy", tone: "neutral" });
    expect(activityTag("deployment.failed")).toEqual({ label: "Deploy", tone: "danger" });
    expect(activityTag("node.went_offline")).toEqual({ label: "Server", tone: "warning" });
    expect(activityTag("invite.created").label).toBe("Member");
    expect(activityTag("variables.updated").label).toBe("Service");
    expect(activityTag("instance.settings_updated").label).toBe("Settings");
  });
});
