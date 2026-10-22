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

  it.each([
    ["project", "prj"],
    ["environment", "env"],
    ["service", "svc"],
    ["serviceConfig", "cfg"],
    ["variable", "var"],
    ["build", "bld"],
    ["deployment", "dep"],
    ["deploymentEvent", "dev"],
    ["placement", "plc"],
    ["domain", "dom"],
    ["githubInstallation", "ghi"],
    ["logChunk", "log"],
    ["workload", "wl"],
  ] as const)("prefixes %s IDs with %s", (kind, prefix) => {
    expect(ID_PREFIXES[kind]).toBe(prefix);
    expect(newId(kind).startsWith(`${prefix}_`)).toBe(true);
  });

  it("mints IDs the wire protocol accepts", () => {
    // Mirrors ID_RE in @openrail/protocol, which this package must not depend on.
    const wireId = /^[a-z]{1,8}_[0-9A-Za-z_]{1,64}$/;
    for (const kind of Object.keys(ID_PREFIXES) as (keyof typeof ID_PREFIXES)[]) {
      expect(newId(kind)).toMatch(wireId);
    }
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
