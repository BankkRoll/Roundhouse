import { describe, expect, it } from "vitest";
import { ID_PREFIXES, isIdKind, newId } from "./ids";

describe("newId", () => {
  it("prefixes by kind", () => {
    expect(newId("node")).toMatch(/^node_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(newId("workspace")).toMatch(/^ws_/);
  });

  it("is unique and sorts by creation order", () => {
    const ids = Array.from({ length: 200 }, () => newId("auditLog"));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it("has no duplicate prefixes", () => {
    const prefixes = Object.values(ID_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

describe("isIdKind", () => {
  it("accepts Better Auth model names we map", () => {
    for (const model of ["user", "session", "account", "verification"]) {
      expect(isIdKind(model)).toBe(true);
    }
  });

  it("rejects unknown and prototype keys", () => {
    expect(isIdKind("rateLimit")).toBe(false);
    expect(isIdKind("toString")).toBe(false);
    expect(isIdKind("__proto__")).toBe(false);
  });
});
