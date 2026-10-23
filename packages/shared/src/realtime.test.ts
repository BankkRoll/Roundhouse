import { describe, expect, it } from "vitest";
import { REALTIME_CLOSE_CODES, shouldReconnect } from "./realtime";

describe("shouldReconnect", () => {
  it("stops on auth, access and protocol failures", () => {
    for (const code of Object.values(REALTIME_CLOSE_CODES))
      expect(shouldReconnect(code)).toBe(false);
  });

  it("retries drops and restarts", () => {
    for (const code of [1000, 1001, 1006, 1011, 1012]) expect(shouldReconnect(code)).toBe(true);
  });
});
