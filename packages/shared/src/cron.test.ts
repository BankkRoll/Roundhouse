import { describe, expect, it } from "vitest";
import vectors from "../test/cron-vectors.json";
import {
  CronSyntaxError,
  isValidCron,
  isValidTimeZone,
  nextCronRun,
  nextRuns,
  parseCron,
  scheduleError,
} from "./cron";

const iso = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");

describe("nextRuns vectors", () => {
  for (const v of vectors.next) {
    it(v.name, () => {
      const got = nextRuns(v.schedule, v.timezone, Date.parse(v.from), v.expect.length || 1);
      expect(got.map(iso)).toEqual(v.expect);
    });
  }
});

describe("invalid schedules", () => {
  for (const v of vectors.invalid) {
    it(JSON.stringify(v.schedule), () => {
      const err = scheduleError(v.schedule, "UTC");
      expect(err).toMatchObject({ code: v.code, start: v.start, end: v.end });
      expect(isValidCron(v.schedule)).toBe(false);
      expect(() => parseCron(v.schedule)).toThrow(CronSyntaxError);
    });
  }
});

describe("time zones", () => {
  it("accepts IANA names and UTC", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
  });

  it("rejects unknown zones as invalid_timezone", () => {
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(scheduleError("0 0 * * *", "Mars/Olympus")).toMatchObject({
      code: "invalid_timezone",
    });
    expect(scheduleError("0 0 * * *", "Europe/Berlin")).toBeNull();
  });
});

describe("nextRuns", () => {
  it("returns distinct, strictly increasing slots after `from`", () => {
    const from = Date.parse("2026-11-01T00:00:00Z");
    const slots = nextRuns("* * * * *", "America/New_York", from, 600);
    expect(slots).toHaveLength(600);
    expect(slots[0]).toBeGreaterThan(from);
    for (let i = 1; i < slots.length; i++) expect(slots[i]).toBeGreaterThan(slots[i - 1]!);
  });

  it("keeps the UTC helpers backups use", () => {
    expect(nextCronRun("0 3 * * *", Date.UTC(2026, 0, 1, 4))).toBe(Date.UTC(2026, 0, 2, 3));
    expect(nextCronRun("0 0 31 2 *", Date.UTC(2026, 0, 1))).toBeNull();
  });

  it("returns nothing for a count of 0", () => {
    expect(nextRuns("* * * * *", "UTC", 0, 0)).toEqual([]);
  });
});
