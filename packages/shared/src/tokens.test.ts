import { describe, expect, it } from "vitest";
import { ACTIONS, can, INSTANCE_ACTIONS } from "./rbac";
import { API_TOKEN_PRESETS, API_TOKEN_SCOPES, isApiTokenScope, scopesBeyondRole } from "./tokens";

describe("API token scopes", () => {
  it("covers every action except the instance ones", () => {
    expect(API_TOKEN_SCOPES).toEqual(
      ACTIONS.filter((a) => !(INSTANCE_ACTIONS as readonly string[]).includes(a)),
    );
    expect(isApiTokenScope("instance:manage")).toBe(false);
    expect(isApiTokenScope("workspaces:create")).toBe(false);
    expect(isApiTokenScope("tokens:manage")).toBe(true);
    expect(isApiTokenScope(42)).toBe(false);
    expect(isApiTokenScope("changes:approve")).toBe(true);
    expect(isApiTokenScope("changes:auto_apply")).toBe(true);
  });

  it("never grants auto-apply through a preset: it must be chosen explicitly", () => {
    for (const scopes of Object.values(API_TOKEN_PRESETS)) {
      expect(scopes).not.toContain("changes:auto_apply");
      expect(scopes).not.toContain("changes:approve");
    }
    expect(scopesBeyondRole("member", ["changes:auto_apply", "changes:approve"])).toEqual([
      "changes:approve",
    ]);
  });

  it("keeps presets within a member's grants and free of management scopes", () => {
    for (const scopes of Object.values(API_TOKEN_PRESETS)) {
      expect(scopesBeyondRole("member", scopes)).toEqual([]);
      expect(scopes).not.toContain("tokens:manage");
      expect(scopes).not.toContain("members:manage");
    }
    for (const s of API_TOKEN_PRESETS.read) expect(can("viewer", s), s).toBe(true);
  });

  it("reports the scopes a role lacks", () => {
    expect(scopesBeyondRole("viewer", ["projects:read", "deployments:create"])).toEqual([
      "deployments:create",
    ]);
    expect(scopesBeyondRole("owner", API_TOKEN_SCOPES)).toEqual([]);
  });
});
