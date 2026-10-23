/**
 * TOTP primitives against the RFC 4226 and RFC 6238 test vectors, and the
 * time-step matching the replay protection relies on.
 */
import { describe, expect, it } from "vitest";
import { hotp, matchTotpStep, TOTP_PERIOD_S, totpStep } from "../src/lib/totp";

const RFC_SECRET = "12345678901234567890";

describe("hotp", () => {
  it("matches RFC 4226 appendix D", async () => {
    const expected = [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ];
    for (const [counter, code] of expected.entries()) {
      expect(await hotp(RFC_SECRET, counter)).toBe(code);
    }
  });

  it("matches RFC 6238 appendix B (SHA-1, 8 digits)", async () => {
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [seconds, code] of vectors) {
      expect(await hotp(RFC_SECRET, totpStep(seconds * 1000), 8)).toBe(code);
    }
  });
});

describe("matchTotpStep", () => {
  const now = 1_800_000_000_000;
  const step = totpStep(now);

  it("finds the step a code belongs to, one step either side", async () => {
    for (const delta of [-1, 0, 1]) {
      const code = await hotp(RFC_SECRET, step + delta);
      expect(await matchTotpStep(RFC_SECRET, code, now)).toBe(step + delta);
    }
  });

  it("refuses codes outside the window and wrong codes", async () => {
    expect(await matchTotpStep(RFC_SECRET, await hotp(RFC_SECRET, step - 2), now)).toBeNull();
    expect(await matchTotpStep(RFC_SECRET, await hotp(RFC_SECRET, step + 2), now)).toBeNull();
    expect(await matchTotpStep(RFC_SECRET, "000000x", now)).toBeNull();
    expect(await matchTotpStep(RFC_SECRET, "", now)).toBeNull();
  });

  it("ignores surrounding whitespace", async () => {
    const code = await hotp(RFC_SECRET, step);
    expect(await matchTotpStep(RFC_SECRET, ` ${code}\n`, now)).toBe(step);
  });

  it("uses 30-second steps", () => {
    expect(TOTP_PERIOD_S).toBe(30);
    expect(totpStep(29_999)).toBe(0);
    expect(totpStep(30_000)).toBe(1);
  });
});
