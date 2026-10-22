import { describe, expect, it } from "vitest";
import { computeVirtualWindow } from "./virtual";

describe("computeVirtualWindow", () => {
  const base = { count: 10_000, rowHeight: 20, viewportHeight: 400, overscan: 8 };

  it("renders the first screen plus overscan at the top", () => {
    expect(computeVirtualWindow({ ...base, scrollTop: 0 })).toEqual({
      start: 0,
      end: 28,
      offsetTop: 0,
      totalHeight: 200_000,
    });
  });

  it("follows the scroll position", () => {
    expect(computeVirtualWindow({ ...base, scrollTop: 2000 })).toEqual({
      start: 92,
      end: 128,
      offsetTop: 1840,
      totalHeight: 200_000,
    });
  });

  it("covers every visible row for any offset", () => {
    for (const scrollTop of [0, 7, 19, 20, 21, 1234, 99_999, 199_600]) {
      const window = computeVirtualWindow({ ...base, scrollTop });
      const firstVisible = Math.floor(scrollTop / 20);
      const lastVisible = Math.ceil((scrollTop + 400) / 20) - 1;
      expect(window.start).toBeLessThanOrEqual(firstVisible);
      expect(window.end).toBeGreaterThan(Math.min(lastVisible, 9_999));
      expect(window.end - window.start).toBeLessThanOrEqual(400 / 20 + 1 + 16);
    }
  });

  it("clamps past the end", () => {
    const window = computeVirtualWindow({ ...base, scrollTop: 10_000_000 });
    expect(window.end).toBe(10_000);
    expect(window.start).toBe(10_000 - 20 - 8);
  });

  it("handles empty lists and tiny viewports", () => {
    expect(computeVirtualWindow({ ...base, count: 0, scrollTop: 50 })).toEqual({
      start: 0,
      end: 0,
      offsetTop: 0,
      totalHeight: 0,
    });
    expect(computeVirtualWindow({ ...base, count: 3, scrollTop: 0 }).end).toBe(3);
  });
});
