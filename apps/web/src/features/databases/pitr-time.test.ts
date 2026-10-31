import { describe, expect, it } from "vitest";
import {
  earliestIn,
  formatInZone,
  inWindow,
  latestIn,
  parseInputValue,
  targetProblem,
  toInputValue,
} from "./pitr-time";

const at = (iso: string) => Date.parse(iso);
const window = { from: at("2026-10-29T10:00:00.400Z"), to: at("2026-10-31T09:30:00Z") };
const now = at("2026-10-31T12:00:00Z");

describe("point-in-time helpers", () => {
  it("writes and reads datetime-local values in UTC, with or without seconds", () => {
    const ms = at("2026-10-31T14:03:22Z");
    expect(toInputValue(ms, "utc")).toBe("2026-10-31T14:03:22");
    expect(parseInputValue("2026-10-31T14:03:22", "utc")).toBe(ms);
    expect(parseInputValue("2026-10-31T14:03", "utc")).toBe(at("2026-10-31T14:03:00Z"));
    expect(parseInputValue("2026-10-31T14:03:22.250", "utc")).toBe(ms);
    expect(formatInZone(ms, "utc")).toBe("2026-10-31 14:03:22 UTC");
  });

  it("round-trips local time through the viewer's zone", () => {
    const ms = at("2026-06-15T12:30:15Z");
    expect(parseInputValue(toInputValue(ms, "local"), "local")).toBe(ms);
    expect(formatInZone(ms, "local")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:15 \S+/);
  });

  it("rejects empty, malformed and impossible values", () => {
    for (const value of [
      "",
      "yesterday",
      "2026-13-01T00:00",
      "2026-02-30T10:00",
      "2026-10-31T24:00",
    ]) {
      expect(parseInputValue(value, "utc")).toBeNull();
    }
  });

  it("bounds a window to whole seconds, before its exclusive end and never after now", () => {
    expect(earliestIn(window)).toBe(at("2026-10-29T10:00:01Z"));
    expect(latestIn(window, now)).toBe(at("2026-10-31T09:29:59Z"));
    expect(latestIn({ ...window, to: now + 60_000 }, now)).toBe(now);
    expect(inWindow(window.from, window, now)).toBe(true);
    expect(inWindow(window.to, window, now)).toBe(false);
  });

  it("says why a moment can't be restored to, naming the bounds", () => {
    expect(targetProblem(null, window, now, "utc")).toBe("Enter a date and a time, to the second.");
    expect(targetProblem(now + 1_000, window, now, "utc")).toBe(
      "That time is in the future. The latest restorable moment is 2026-10-31 09:29:59 UTC.",
    );
    expect(targetProblem(at("2026-10-28T00:00:00Z"), window, now, "utc")).toBe(
      "Outside the restorable window. Pick a time from 2026-10-29 10:00:01 UTC to 2026-10-31 09:29:59 UTC.",
    );
    expect(targetProblem(at("2026-10-31T10:00:00Z"), window, now, "utc")).toMatch(/^Outside/);
    expect(targetProblem(at("2026-10-30T08:15:00Z"), window, now, "utc")).toBeNull();
    expect(targetProblem(now, undefined, now, "utc")).toMatch(/Nothing is restorable/);
  });
});
