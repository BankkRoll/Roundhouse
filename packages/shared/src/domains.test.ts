import { describe, expect, it } from "vitest";
import {
  customHostnameProblem,
  nextCheckDelayMs,
  normalizeHostname,
  ownershipRecordName,
  ownershipRecordValue,
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
