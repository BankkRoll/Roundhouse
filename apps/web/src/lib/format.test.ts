import { describe, expect, it } from "vitest";
import {
  EMPTY,
  formatAgentVersion,
  formatAgo,
  formatBytes,
  formatBytesPair,
  formatCountdown,
  formatDuration,
  formatPercent,
  formatPlatform,
  formatRelativeTime,
  formatTimestamp,
  percentOf,
} from "./format";

const KiB = 1024;
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const TiB = 1024 ** 4;

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [1, "1 B"],
    [1023, "1023 B"],
    [KiB, "1 KB"],
    [1536, "1.5 KB"],
    [MiB, "1 MB"],
    [11.4 * GiB, "11.4 GB"],
    [16 * GiB, "16 GB"],
    [1.25 * TiB, "1.3 TB"],
    [1024 * TiB, "1 PB"],
  ])("formats %d bytes as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it("caps at the largest unit", () => {
    expect(formatBytes(2048 * 1024 * TiB)).toBe("2048 PB");
  });

  it("respects the decimals argument and trims trailing zeros", () => {
    expect(formatBytes(1.234 * GiB, 2)).toBe("1.23 GB");
    expect(formatBytes(2 * GiB, 2)).toBe("2 GB");
    expect(formatBytes(1.5 * GiB, 0)).toBe("2 GB");
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "returns the placeholder for %s",
    (value) => {
      expect(formatBytes(value)).toBe(EMPTY);
    },
  );
});

describe("formatBytesPair", () => {
  it("uses the total's unit for both numbers", () => {
    expect(formatBytesPair(11.4 * GiB, 16 * GiB)).toBe("11.4/16 GB");
    expect(formatBytesPair(512 * MiB, 2 * GiB)).toBe("0.5/2 GB");
  });

  it("rounds to one decimal", () => {
    expect(formatBytesPair(3.04 * GiB, 8 * GiB)).toBe("3/8 GB");
    expect(formatBytesPair(3.06 * GiB, 8 * GiB)).toBe("3.1/8 GB");
  });

  it("handles used above total (overcommit) without clamping", () => {
    expect(formatBytesPair(9 * GiB, 8 * GiB)).toBe("9/8 GB");
  });

  it.each([
    [null, 8 * GiB],
    [1 * GiB, null],
    [1 * GiB, 0],
    [-1, 8 * GiB],
    [undefined, undefined],
  ])("returns the placeholder for (%s, %s)", (used, total) => {
    expect(formatBytesPair(used, total)).toBe(EMPTY);
  });
});

describe("percentOf", () => {
  it("computes a percentage", () => {
    expect(percentOf(1, 4)).toBe(25);
    expect(percentOf(0, 10)).toBe(0);
  });

  it("does not clamp values above 100", () => {
    expect(percentOf(15, 10)).toBe(150);
  });

  it.each([
    [null, 10],
    [5, null],
    [5, 0],
    [5, -1],
    [Number.NaN, 10],
  ])("returns null for (%s, %s)", (used, total) => {
    expect(percentOf(used, total)).toBeNull();
  });
});

describe("formatPercent", () => {
  it.each([
    [0, "0%"],
    [71.4, "71%"],
    [71.5, "72%"],
    [99.6, "100%"],
    [100, "100%"],
    [150, "150%"],
  ])("formats %d as %s", (value, expected) => {
    expect(formatPercent(value)).toBe(expected);
  });

  it("supports decimals", () => {
    expect(formatPercent(12.345, 1)).toBe("12.3%");
    expect(formatPercent(12, 1)).toBe("12%");
  });

  it("never prints negative zero", () => {
    expect(formatPercent(-0.2)).toBe("0%");
  });

  it.each([null, undefined, Number.NaN])("returns the placeholder for %s", (value) => {
    expect(formatPercent(value)).toBe(EMPTY);
  });
});

describe("formatDuration", () => {
  const s = 1000;
  const m = 60 * s;
  const h = 60 * m;
  const d = 24 * h;

  it.each([
    [0, "0s"],
    [999, "0s"],
    [12 * s, "12s"],
    [4 * m + 5 * s, "4m 5s"],
    [4 * m, "4m"],
    [3 * h + 12 * m + 40 * s, "3h 12m"],
    [3 * h + 40 * s, "3h"],
    [41 * d + 6 * h + 5 * m, "41d 6h"],
    [2 * d, "2d"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it.each([null, undefined, -1, Number.NaN])("returns the placeholder for %s", (value) => {
    expect(formatDuration(value)).toBe(EMPTY);
  });
});

describe("formatCountdown", () => {
  it.each([
    [0, "0:00"],
    [-5000, "0:00"],
    [1, "0:01"],
    [999, "0:01"],
    [59_000, "0:59"],
    [60_000, "1:00"],
    [14 * 60_000 + 59_000, "14:59"],
    [15 * 60_000, "15:00"],
  ])("formats %d ms as %s", (ms, expected) => {
    expect(formatCountdown(ms)).toBe(expected);
  });
});

describe("formatAgo", () => {
  const now = Date.UTC(2026, 9, 22, 12, 0, 0);

  it.each([
    [now, "now"],
    [now - 4_999, "now"],
    [now + 30_000, "now"],
    [now - 5_000, "5s"],
    [now - 59_999, "59s"],
    [now - 60_000, "1m"],
    [now - 59 * 60_000, "59m"],
    [now - 3_600_000, "1h"],
    [now - 23 * 3_600_000, "23h"],
    [now - 86_400_000, "1d"],
    [now - 29 * 86_400_000, "29d"],
  ])("formats %d as %s", (timestamp, expected) => {
    expect(formatAgo(timestamp, now)).toBe(expected);
  });

  it("switches to a date after 30 days", () => {
    expect(formatAgo(Date.UTC(2026, 2, 4), now)).toBe("Mar 4");
  });

  it("includes the year for dates in another year", () => {
    expect(formatAgo(Date.UTC(2025, 11, 31), now)).toBe("Dec 31, 2025");
  });

  it("returns never for missing timestamps", () => {
    expect(formatAgo(null, now)).toBe("never");
    expect(formatAgo(undefined, now)).toBe("never");
  });

  it("defaults now to the current time", () => {
    expect(formatAgo(Date.now())).toBe("now");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.UTC(2026, 9, 22, 12, 0, 0);

  it("reads as a sentence fragment", () => {
    expect(formatRelativeTime(now, now)).toBe("just now");
    expect(formatRelativeTime(now - 12_000, now)).toBe("12s ago");
    expect(formatRelativeTime(now - 4 * 60_000, now)).toBe("4m ago");
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });

  it("does not append ago to dates or never", () => {
    expect(formatRelativeTime(Date.UTC(2026, 2, 4), now)).toBe("Mar 4");
    expect(formatRelativeTime(null, now)).toBe("never");
  });
});

describe("formatTimestamp", () => {
  it("formats as UTC without milliseconds", () => {
    expect(formatTimestamp(Date.UTC(2026, 9, 22, 12, 41, 5, 999))).toBe("2026-10-22 12:41:05 UTC");
  });

  it("returns the placeholder for null", () => {
    expect(formatTimestamp(null)).toBe(EMPTY);
  });
});

describe("formatPlatform", () => {
  it("joins os and arch", () => {
    expect(formatPlatform("linux", "amd64")).toBe("linux/amd64");
  });

  it("shows whichever half is known", () => {
    expect(formatPlatform("linux", null)).toBe("linux");
    expect(formatPlatform(null, "arm64")).toBe("arm64");
  });

  it("returns the placeholder when both are missing", () => {
    expect(formatPlatform(null, undefined)).toBe(EMPTY);
    expect(formatPlatform("", "")).toBe(EMPTY);
  });
});

describe("formatAgentVersion", () => {
  it.each([
    ["0.1.0", "v0.1.0"],
    ["1.2.3-rc.1", "v1.2.3-rc.1"],
    ["dev", "dev"],
    ["", null],
    [null, null],
  ])("%j → %j", (input, expected) => {
    expect(formatAgentVersion(input)).toBe(expected);
  });
});
