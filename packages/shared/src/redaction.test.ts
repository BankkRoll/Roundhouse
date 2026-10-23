import { describe, expect, it } from "vitest";
import { REDACTED, redact, redactionNeedles } from "./redaction";

describe("redactionNeedles", () => {
  it("covers the secret and its common encodings, longest first", () => {
    const needles = redactionNeedles(["hunter22"]);
    expect(needles).toEqual(
      expect.arrayContaining([
        "hunter22",
        "aHVudGVyMjI=",
        "aHVudGVyMjI",
        "68756e7465723232",
        "68756E7465723232",
      ]),
    );
    for (let i = 1; i < needles.length; i++) {
      expect(needles[i - 1]!.length).toBeGreaterThanOrEqual(needles[i]!.length);
    }
    expect(new Set(needles).size).toBe(needles.length);
  });

  it("encodes URL, JSON and base64url forms of awkward secrets", () => {
    const needles = redactionNeedles(['p@ss/w+rd "é"\n']);
    expect(needles).toContain("p%40ss%2Fw%2Brd%20%22%C3%A9%22%0A");
    expect(needles).toContain('p@ss/w+rd \\"é\\"\\n');
    expect(needles.find((n) => n.startsWith("cEBzcy93K3Jk"))).toBeDefined();
    // 0x7e bytes encode to "+" in base64 and "-" in base64url.
    expect(redactionNeedles(["~~~~~~~~"])).toEqual(
      expect.arrayContaining(["fn5+fn5+fn4=", "fn5+fn5+fn4", "fn5-fn5-fn4"]),
    );
  });

  it("skips secrets too short to redact safely", () => {
    expect(redactionNeedles(["abc", "12345"])).toEqual([]);
    expect(redactionNeedles(["123456"])).toContain("123456");
  });

  it("matches the UTF-16-agnostic length rule", () => {
    // Six code points, more UTF-16 units: still redacted.
    expect(redactionNeedles(["🚀🚀🚀🚀🚀🚀"])).toContain("🚀🚀🚀🚀🚀🚀");
  });
});

describe("redact", () => {
  it("replaces every occurrence of every encoding", () => {
    const needles = redactionNeedles(["hunter22"]);
    expect(redact("pw=hunter22 b64=aHVudGVyMjI= hex=68756e7465723232 ok", needles)).toBe(
      `pw=${REDACTED} b64=${REDACTED} hex=${REDACTED} ok`,
    );
    expect(redact("nothing here", needles)).toBe("nothing here");
  });
});
