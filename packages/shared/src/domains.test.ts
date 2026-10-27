import { describe, expect, it } from "vitest";
import {
  acmeDelegationName,
  acmeDelegationTarget,
  customHostnameProblem,
  DEFAULT_HSTS,
  hstsHeaderValue,
  hstsProblems,
  hstsWarnings,
  isWildcardHostname,
  MAX_HSTS_MAX_AGE_S,
  nextCheckDelayMs,
  normalizeHostname,
  ownershipRecordName,
  ownershipRecordValue,
  wildcardBase,
} from "./domains";

describe("normalizeHostname", () => {
  it.each([
    [" Shop.Example.COM. ", "shop.example.com"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["*.Example.com", "*.example.com"],
    ["0x7f.1", "127.0.0.1"],
  ])("normalises %j to %j", (input, out) => {
    expect(normalizeHostname(input)).toBe(out);
  });

  it.each(["", "  ", "a b.com", "https://x.com", "x.com/path", "user@x.com", "x.com:443", "[::1]"])(
    "rejects %j",
    (input) => {
      expect(normalizeHostname(input)).toBeNull();
    },
  );
});

describe("customHostnameProblem", () => {
  const reserved = { appsDomain: "apps.example.com", exact: ["cp.example.com", null] };

  it.each([
    ["shop.example.com", null],
    ["example.com", null],
    ["shop.customer.test", null],
    ["localhost", "invalid"],
    ["under_score.example.com", "invalid"],
    ["-bad.example.com", "invalid"],
    [`${"a".repeat(64)}.example.com`, "invalid"],
    [`${"a.".repeat(127)}com`, "invalid"],
    ["*.example.com", "wildcard"],
    ["10.0.0.1", "ip_address"],
    ["db.internal", "non_public"],
    ["printer.local", "non_public"],
    ["foo.localhost", "non_public"],
    ["apps.example.com", "reserved"],
    ["x.apps.example.com", "reserved"],
    ["cp.example.com", "reserved"],
    ["myapps.example.com", null],
  ])("judges %s as %s", (hostname, problem) => {
    expect(customHostnameProblem(hostname, reserved)).toBe(problem);
  });

  it("allows anything outside the install's names when no apps domain is set", () => {
    expect(customHostnameProblem("apps.example.com", { appsDomain: null })).toBeNull();
  });
});

describe("records and schedule", () => {
  it("names the ownership record", () => {
    expect(ownershipRecordName("shop.example.com")).toBe("_roundhouse.shop.example.com");
    expect(ownershipRecordValue("ab12")).toBe("rh-verify=ab12");
  });

  it("checks at 1, 2, 5, 10 and 30 minutes, then hourly", () => {
    expect([1, 2, 3, 4, 5, 6, 50].map((n) => nextCheckDelayMs(n) / 60_000)).toEqual([
      1, 2, 5, 10, 30, 60, 60,
    ]);
  });
});

describe("wildcards", () => {
  const reserved = {
    appsDomain: "apps.example.com",
    exact: ["cp.example.com", "ingress.example.net"],
  };
  const allow = { allowWildcard: true };

  it.each([
    ["*.shop.test", null],
    ["*.customer.example.org", null],
    ["*.com", "invalid"],
    ["*.example.com", "reserved"],
    ["*.example.net", "reserved"],
    ["*.apps.example.com", "reserved"],
    ["*.x.apps.example.com", "reserved"],
    ["*.sub.example.net", null],
    ["*.10.0.0.1", "ip_address"],
    ["*.db.internal", "non_public"],
  ])("judges %s as %s when wildcards are allowed", (hostname, problem) => {
    expect(customHostnameProblem(hostname, reserved, allow)).toBe(problem);
  });

  it("refuses wildcards unless allowed", () => {
    expect(customHostnameProblem("*.shop.test", reserved)).toBe("wildcard");
  });

  it("names the ownership and delegation records at the base", () => {
    expect(isWildcardHostname("*.shop.test")).toBe(true);
    expect(wildcardBase("*.shop.test")).toBe("shop.test");
    expect(ownershipRecordName("*.shop.test")).toBe("_roundhouse.shop.test");
    expect(acmeDelegationName("*.shop.test")).toBe("_acme-challenge.shop.test");
    expect(acmeDelegationTarget("dom_01ABC", "apps.example.com")).toBe(
      "dom-01abc.acme.apps.example.com",
    );
  });
});

describe("HSTS", () => {
  const ok = { enabled: true, max_age: 31_536_000, include_subdomains: true, preload: true };

  it("accepts the default and a valid preload policy on an apex", () => {
    expect(hstsProblems(DEFAULT_HSTS, "shop.example.com", false)).toEqual([]);
    expect(hstsProblems(ok, "example.com", true)).toEqual([]);
  });

  it("refuses preload without its prerequisites", () => {
    expect(hstsProblems({ ...ok, include_subdomains: false }, "example.com", true)).toEqual([
      "Preload needs includeSubDomains.",
    ]);
    expect(hstsProblems({ ...ok, max_age: 86_400 }, "example.com", true)).toHaveLength(1);
    expect(hstsProblems(ok, "shop.example.com", false)).toHaveLength(1);
    expect(hstsProblems(ok, "*.example.com", true)).toHaveLength(1);
    expect(hstsProblems({ ...ok, enabled: false }, "example.com", true)).toHaveLength(1);
  });

  it("bounds max-age", () => {
    expect(hstsProblems({ ...DEFAULT_HSTS, max_age: -1 }, "a.example.com", false)).toHaveLength(1);
    expect(
      hstsProblems({ ...DEFAULT_HSTS, max_age: MAX_HSTS_MAX_AGE_S + 1 }, "a.example.com", false),
    ).toHaveLength(1);
    expect(hstsProblems({ ...DEFAULT_HSTS, max_age: 1.5 }, "a.example.com", false)).toHaveLength(1);
  });

  it("warns about risky choices", () => {
    expect(hstsWarnings(DEFAULT_HSTS)).toEqual([]);
    expect(hstsWarnings({ ...DEFAULT_HSTS, enabled: false, preload: true })).toEqual([]);
    expect(hstsWarnings(ok)).toHaveLength(2);
    expect(hstsWarnings({ ...DEFAULT_HSTS, max_age: 0 })[0]).toMatch(/forget/);
    expect(hstsWarnings({ ...DEFAULT_HSTS, max_age: 60 })[0]).toMatch(/under a day/);
  });

  it("renders the header", () => {
    expect(hstsHeaderValue(DEFAULT_HSTS)).toBe("max-age=31536000");
    expect(hstsHeaderValue(ok)).toBe("max-age=31536000; includeSubDomains; preload");
  });
});
