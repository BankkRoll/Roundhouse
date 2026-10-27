import { describe, expect, it } from "vitest";
import type { CronRun } from "../../../lib/api/cron-client";
import {
  describeSchedule,
  explainRunError,
  formatSlot,
  previewSchedule,
  shortestInterval,
  timeZones,
} from "./cron-format";
import { runSummary } from "./runs-tab";

const T = Date.UTC(2026, 9, 22, 12, 0);

describe("describeSchedule", () => {
  it.each([
    ["0 3 * * *", "At 03:00, every day"],
    ["@daily", "At 00:00, every day"],
    ["@hourly", "Every hour, every day"],
    ["* * * * *", "Every minute, every day"],
    ["*/15 * * * *", "Every 15 minutes, every day"],
    ["*/15 9-17 * * MON-FRI", "Every 15 minutes from 09:00 to 17:59, on weekdays"],
    ["30 * * * *", "Every hour at :30, every day"],
    ["0 9,13,17 * * *", "At 09:00, 13:00 and 17:00, every day"],
    ["0 */2 * * *", "Every 2 hours, every day"],
    ["0 0 * * 0", "At 00:00, on Sunday"],
    ["0 0 * * 6,0", "At 00:00, on weekends"],
    ["0 0 1 * *", "At 00:00, on day 1 of the month"],
    ["0 0 1,15 * 1", "At 00:00, on days 1 and 15 of the month or on Monday"],
    ["0 4 * 1,7 *", "At 04:00, every day in January and July"],
    ["15,45 * * * *", "At minutes 15 and 45 past the hour, every day"],
  ])("%s reads as %s", (schedule, text) => {
    expect(describeSchedule(schedule)).toBe(text);
  });

  it("returns null for a schedule that doesn't parse", () => {
    expect(describeSchedule("0 3 * *")).toBeNull();
  });
});

describe("previewSchedule", () => {
  it("lists the next slots in the zone", () => {
    const { error, slots } = previewSchedule("0 3 * * *", "Europe/Berlin", 2, T);
    expect(error).toBeNull();
    expect(slots.map((slot) => formatSlot(slot, "Europe/Berlin"))).toEqual([
      "Fri 23 Oct 03:00",
      "Sat 24 Oct 03:00",
    ]);
  });

  it("points at the offending characters of the text as typed", () => {
    const { error, slots } = previewSchedule("  0 99 * * *", "UTC", 5, T);
    expect(slots).toEqual([]);
    expect(error).toMatchObject({ code: "invalid_schedule", start: 4, end: 6 });
  });

  it("asks for a schedule when blank and reports an unknown zone", () => {
    expect(previewSchedule("  ", "UTC").error?.message).toBe("Enter a schedule");
    expect(previewSchedule("@daily", "Mars/Olympus").error?.code).toBe("invalid_timezone");
  });
});

describe("helpers", () => {
  it("finds the shortest gap between slots", () => {
    expect(shortestInterval([0, 60_000, 90_000, 200_000])).toBe(30_000);
    expect(shortestInterval([5])).toBeNull();
  });

  it("offers UTC first and keeps an unknown saved zone", () => {
    const zones = timeZones("Legacy/Zone");
    expect(zones.slice(0, 2)).toEqual(["Legacy/Zone", "UTC"]);
    expect(zones).toContain("Europe/Berlin");
    expect(zones.filter((zone) => zone === "UTC")).toHaveLength(1);
  });

  it("explains an agent too old to run jobs and leaves other errors as written", () => {
    expect(explainRunError("unschedulable: agent_outdated")).toMatch(
      /No server runs an agent that can run jobs \(agent protocol 6 or newer\)\. Update the agent/,
    );
    expect(explainRunError("exit 3")).toBe("exit 3");
  });
});

describe("runSummary", () => {
  const missed = (fields: Partial<CronRun>) =>
    ({ status: "missed", missed_count: 12, error: null, ...fields }) as CronRun;

  it("reads a missed record as a count with its outage", () => {
    expect(
      runSummary(
        missed({
          error: "12 runs missed between 2026-10-22T09:02:00.000Z and 2026-10-22T09:13:00.000Z",
        }),
        "UTC",
      ),
    ).toBe("12 runs missed (control plane unavailable 09:02–09:13)");
    expect(
      runSummary(
        missed({ missed_count: 1, error: "1 run missed at 2026-10-22T09:02:00.000Z" }),
        "Europe/Berlin",
      ),
    ).toBe("1 run missed (control plane unavailable at 11:02)");
    expect(runSummary(missed({}))).toBe("12 runs missed");
    expect(runSummary({ status: "succeeded" } as CronRun)).toBeNull();
  });
});
