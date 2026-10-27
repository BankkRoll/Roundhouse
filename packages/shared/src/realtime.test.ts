import { describe, expect, it } from "vitest";
import { PRESENCE_COLORS, presenceColor, REALTIME_CLOSE_CODES, shouldReconnect } from "./realtime";

describe("shouldReconnect", () => {
  it("stops on auth, access and protocol failures", () => {
    for (const code of Object.values(REALTIME_CLOSE_CODES))
      expect(shouldReconnect(code)).toBe(false);
  });

  it("retries drops and restarts", () => {
    for (const code of [1000, 1001, 1006, 1011, 1012]) expect(shouldReconnect(code)).toBe(true);
  });
});

describe("presenceColor", () => {
  it("is stable per user and stays within the palette", () => {
    expect(presenceColor("usr_ada")).toBe(presenceColor("usr_ada"));
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const c = presenceColor(`usr_${i}`);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(PRESENCE_COLORS);
      seen.add(c);
    }
    expect(seen.size).toBe(PRESENCE_COLORS);
  });
});
