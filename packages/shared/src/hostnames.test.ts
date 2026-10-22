import { describe, expect, it } from "vitest";
import { generatedHostname, MAX_DNS_LABEL_LENGTH } from "./hostnames";
import { seeded } from "./test-random";

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

describe("generatedHostname", () => {
  it("joins service, environment and a suffix under the apps domain", () => {
    expect(generatedHostname("API", "production", "127.0.0.1.nip.io", () => 0)).toBe(
      "api-production-aaaa.127.0.0.1.nip.io",
    );
  });

  it("draws the suffix from [a-z0-9], including the last character", () => {
    expect(generatedHostname("a", "b", "x.io", () => 0.9999999)).toBe("a-b-9999.x.io");
  });

  it("slugifies names and falls back when nothing is left", () => {
    expect(generatedHostname("Café Web!", "PR #42", "x.io", () => 0)).toBe(
      "cafe-web-pr-42-aaaa.x.io",
    );
    expect(generatedHostname("日本", "!!!", "x.io", () => 0)).toBe("service-env-aaaa.x.io");
  });

  it("normalises the apps domain", () => {
    expect(generatedHostname("a", "b", "Apps.Example.COM.", () => 0)).toBe(
      "a-b-aaaa.apps.example.com",
    );
  });

  it("rejects an empty or oversized apps domain", () => {
    expect(() => generatedHostname("a", "b", "", () => 0)).toThrow(RangeError);
    expect(() => generatedHostname("a", "b", `${"a".repeat(63)}.`.repeat(4), () => 0)).toThrow(
      RangeError,
    );
  });

  it("keeps the first label DNS-safe for arbitrary names", () => {
    const random = seeded(42);
    const chars = "abcXYZ019 -_.é日🚀!";
    const word = (n: number) =>
      Array.from({ length: n }, () => chars[Math.floor(random() * chars.length)]).join("");
    for (let i = 0; i < 500; i++) {
      const host = generatedHostname(
        word(Math.floor(random() * 120)),
        word(Math.floor(random() * 60)),
        "apps.example.com",
        random,
      );
      const [label, ...rest] = host.split(".");
      expect(label!.length).toBeLessThanOrEqual(MAX_DNS_LABEL_LENGTH);
      expect(label).toMatch(LABEL);
      expect(label).not.toContain("--");
      expect(rest.join(".")).toBe("apps.example.com");
    }
  });

  it("gives the service most of the label when both names are long", () => {
    const label = generatedHostname("s".repeat(100), "e".repeat(100), "x.io", () => 0).split(
      ".",
    )[0]!;
    expect(label).toHaveLength(MAX_DNS_LABEL_LENGTH);
    expect(label).toBe(`${"s".repeat(37)}-${"e".repeat(20)}-aaaa`);
  });
});
