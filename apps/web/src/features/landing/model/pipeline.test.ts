import { describe, expect, it } from "vitest";
import {
  progressForStage,
  ROLLBACK_LOG,
  STAGES,
  stageAtProgress,
  stageStatuses,
  trackProgress,
} from "./pipeline";

describe("STAGES", () => {
  it("runs push to live in order, each with a few log lines", () => {
    expect(STAGES.map((stage) => stage.id)).toEqual([
      "push",
      "build",
      "registry",
      "schedule",
      "start",
      "health",
      "route",
      "live",
    ]);
    for (const stage of STAGES) {
      expect(stage.log.length).toBeGreaterThan(0);
      expect(stage.log.length).toBeLessThanOrEqual(3);
    }
  });

  it("rolls back without a build", () => {
    expect(ROLLBACK_LOG.map((line) => line.text).join("\n")).toMatch(/build skipped/);
  });
});

describe("stageAtProgress", () => {
  it("gives each stage an equal slice", () => {
    expect(stageAtProgress(0, 8)).toBe(0);
    expect(stageAtProgress(0.124, 8)).toBe(0);
    expect(stageAtProgress(0.125, 8)).toBe(1);
    expect(stageAtProgress(0.5, 8)).toBe(4);
    expect(stageAtProgress(0.99, 8)).toBe(7);
  });

  it("clamps out-of-range and invalid progress", () => {
    expect(stageAtProgress(-1)).toBe(0);
    expect(stageAtProgress(1)).toBe(STAGES.length - 1);
    expect(stageAtProgress(5)).toBe(STAGES.length - 1);
    expect(stageAtProgress(Number.NaN)).toBe(0);
    expect(stageAtProgress(0.5, 0)).toBe(0);
  });

  it("round-trips with progressForStage", () => {
    for (let index = 0; index < STAGES.length; index++) {
      expect(stageAtProgress(progressForStage(index))).toBe(index);
    }
    expect(progressForStage(-3)).toBe(progressForStage(0));
    expect(progressForStage(99)).toBe(progressForStage(STAGES.length - 1));
  });
});

describe("trackProgress", () => {
  it("is 0 before the track pins and 1 after it ends", () => {
    expect(trackProgress(200, 4000, 800)).toBe(0);
    expect(trackProgress(0, 4000, 800)).toBe(0);
    expect(trackProgress(-1600, 4000, 800)).toBe(0.5);
    expect(trackProgress(-3200, 4000, 800)).toBe(1);
    expect(trackProgress(-9000, 4000, 800)).toBe(1);
  });

  it("handles a track no taller than the viewport", () => {
    expect(trackProgress(10, 500, 800)).toBe(0);
    expect(trackProgress(-10, 500, 800)).toBe(1);
  });
});

describe("stageStatuses", () => {
  it("marks earlier stages done and the active one active", () => {
    expect(stageStatuses(2)).toEqual([
      "done",
      "done",
      "active",
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(stageStatuses(STAGES.length - 1).at(-1)).toBe("active");
  });
});
