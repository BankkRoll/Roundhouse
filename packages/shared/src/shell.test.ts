import { describe, expect, it } from "vitest";
import { PROJECT_ROLES, projectRoleCan } from "./rbac";
import {
  parseAsciicast,
  parseAsciicastSize,
  SHELL_CLOSE_CODES,
  SHELL_DENIAL_CLOSE_CODES,
  SHELL_DENIALS,
  ShellClientMessageSchema,
  type ShellGateInput,
  shellGate,
  shellPath,
} from "./shell";

const ok: ShellGateInput = {
  credential: "session",
  accessAllowed: true,
  twoFactorEnabled: true,
  freshSession: true,
  environmentProtected: true,
};

describe("shell:open", () => {
  it("belongs to project admins only", () => {
    for (const role of PROJECT_ROLES) {
      expect(projectRoleCan(role, "shell:open"), role).toBe(role === "project_admin");
    }
  });
});

describe("shellGate (ADR 0014 §15)", () => {
  it("allows a fresh, two-factor project admin anywhere", () => {
    expect(shellGate(ok)).toEqual({ allowed: true });
  });

  it("refuses in order: oauth, access, 2FA, freshness, protected token", () => {
    expect(shellGate({ ...ok, credential: "oauth" })).toEqual({
      allowed: false,
      reason: "oauth_token",
    });
    expect(shellGate({ ...ok, accessAllowed: false, twoFactorEnabled: false })).toEqual({
      allowed: false,
      reason: "forbidden",
    });
    expect(shellGate({ ...ok, twoFactorEnabled: false, freshSession: false })).toEqual({
      allowed: false,
      reason: "two_factor_required",
    });
    expect(shellGate({ ...ok, freshSession: false })).toEqual({
      allowed: false,
      reason: "reauth_required",
    });
    expect(shellGate({ ...ok, credential: "api_token", freshSession: false })).toEqual({
      allowed: false,
      reason: "protected_environment",
    });
    expect(
      shellGate({
        ...ok,
        credential: "api_token",
        freshSession: false,
        environmentProtected: false,
      }),
    ).toEqual({ allowed: true });
    expect(
      shellGate({
        ...ok,
        credential: "api_token",
        twoFactorEnabled: false,
        environmentProtected: false,
      }),
    ).toEqual({ allowed: false, reason: "two_factor_required" });
  });

  it("maps every denial to a distinct 44xx close code", () => {
    const codes = SHELL_DENIALS.map((d) => SHELL_DENIAL_CLOSE_CODES[d]);
    for (const c of codes) expect(c).toBeGreaterThanOrEqual(4400);
    expect(new Set(Object.values(SHELL_CLOSE_CODES)).size).toBe(
      Object.values(SHELL_CLOSE_CODES).length,
    );
  });
});

describe("shell socket messages", () => {
  it("parses resize and close only", () => {
    expect(ShellClientMessageSchema.parse({ type: "resize", cols: 80, rows: 24 })).toEqual({
      type: "resize",
      cols: 80,
      rows: 24,
    });
    expect(ShellClientMessageSchema.safeParse({ type: "resize", cols: 0, rows: 24 }).success).toBe(
      false,
    );
    expect(ShellClientMessageSchema.safeParse({ type: "input", data: "ls" }).success).toBe(false);
    expect(shellPath("wl_1")).toBe("/v1/workloads/wl_1/shell");
  });
});

describe("parseAsciicast", () => {
  it("reads the header and the o, i and r events, skipping the rest", () => {
    const cast = parseAsciicast(
      [
        '{"version":2,"width":80,"height":24,"timestamp":1,"env":{"TERM":"xterm"}}',
        '[0.1,"o","hi"]',
        '[0.2,"i","ls\\r"]',
        "not json",
        '[0.3,"m","marker"]',
        '[1.5,"r","100x30"]',
        "",
      ].join("\n"),
    );
    expect(cast.header).toMatchObject({ width: 80, height: 24 });
    expect(cast.events).toEqual([
      [0.1, "o", "hi"],
      [0.2, "i", "ls\r"],
      [1.5, "r", "100x30"],
    ]);
    expect(cast.duration).toBe(1.5);
  });

  it("refuses anything but a v2 header", () => {
    expect(() => parseAsciicast("")).toThrow();
    expect(() => parseAsciicast('{"version":1,"width":80,"height":24}')).toThrow();
    expect(() => parseAsciicast('{"version":2,"width":0,"height":24}')).toThrow();
  });

  it("parses resize sizes", () => {
    expect(parseAsciicastSize("120x40")).toEqual({ cols: 120, rows: 40 });
    expect(parseAsciicastSize("0x40")).toBeNull();
    expect(parseAsciicastSize("big")).toBeNull();
  });
});
