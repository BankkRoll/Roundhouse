import { describe, expect, it } from "vitest";
import {
  EMPTY_BUFFER,
  filterLines,
  LOG_STREAMS,
  linesToText,
  withLiveLines,
  withNewestPage,
  withOlderPage,
} from "./log-buffer";

const line = (
  ts: number,
  text = `line ${ts}`,
  stream: "stdout" | "stderr" | "system" = "stdout",
) => ({
  ts,
  stream,
  text,
});

describe("log buffer", () => {
  it("loads the newest page, then prepends older pages in order", () => {
    let buffer = withNewestPage(EMPTY_BUFFER, [line(3), line(4)], "c2");
    expect(buffer.olderCursor).toBe("c2");
    buffer = withOlderPage(buffer, [line(1), line(2)], null);
    expect(buffer.lines.map((entry) => entry.ts)).toEqual([1, 2, 3, 4]);
    expect(buffer.olderCursor).toBeNull();
    expect(new Set(buffer.lines.map((entry) => entry.id)).size).toBe(4);
  });

  it("keeps live lines that arrived before the first page, without duplicates", () => {
    const early = withLiveLines(EMPTY_BUFFER, [line(4), line(5)]);
    const buffer = withNewestPage(early, [line(3), line(4)], null);
    expect(buffer.lines.map((entry) => entry.ts)).toEqual([3, 4, 5]);
  });

  it("skips live lines already at the end of the buffer", () => {
    const page = withNewestPage(EMPTY_BUFFER, [line(1), line(2)], null);
    const buffer = withLiveLines(page, [line(2), line(3)]);
    expect(buffer.lines.map((entry) => entry.ts)).toEqual([1, 2, 3]);
    expect(withLiveLines(buffer, [line(3)])).toBe(buffer);
  });

  it("drops the oldest lines past the cap and forgets the older cursor", () => {
    let buffer = withNewestPage(EMPTY_BUFFER, [line(1), line(2)], "c");
    buffer = withLiveLines(buffer, [line(3), line(4), line(5)], 3);
    expect(buffer.lines.map((entry) => entry.ts)).toEqual([3, 4, 5]);
    expect(buffer.trimmed).toBe(true);
    expect(buffer.olderCursor).toBeNull();
  });

  it("strips escapes for search and copy", () => {
    const buffer = withNewestPage(
      EMPTY_BUFFER,
      [line(1, "\x1b[31mERROR\x1b[0m boom", "stderr")],
      null,
    );
    expect(buffer.lines[0]?.plain).toBe("ERROR boom");
    expect(linesToText(buffer.lines, false)).toBe("ERROR boom");
    expect(linesToText(buffer.lines, true)).toBe("1970-01-01T00:00:00.001Z ERROR boom");
  });

  it("filters by stream and case-insensitive text", () => {
    const buffer = withNewestPage(
      EMPTY_BUFFER,
      [
        line(1, "GET /cart", "stdout"),
        line(2, "Cart failed", "stderr"),
        line(3, "healthy", "system"),
      ],
      null,
    );
    const all = new Set(LOG_STREAMS);
    expect(filterLines(buffer.lines, { streams: all, query: "" })).toBe(buffer.lines);
    expect(filterLines(buffer.lines, { streams: all, query: "CART" }).map((l) => l.ts)).toEqual([
      1, 2,
    ]);
    expect(
      filterLines(buffer.lines, { streams: new Set(["stderr", "system"] as const), query: "" }).map(
        (l) => l.ts,
      ),
    ).toEqual([2, 3]);
  });
});
