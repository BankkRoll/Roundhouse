import { describe, expect, it } from "vitest";
import { ACTIONS, type Action, can, isRole, ROLES, type Role } from "./rbac";

describe("rbac", () => {
  it("lets owners delete workspaces but not admins", () => {
    expect(can("owner", "workspace:delete")).toBe(true);
    expect(can("admin", "workspace:delete")).toBe(false);
  });

  it("keeps viewers read-only", () => {
    expect(can("viewer", "nodes:read")).toBe(true);
    expect(can("viewer", "nodes:manage")).toBe(false);
    expect(can("viewer", "members:read")).toBe(false);
  });

  it("validates role strings", () => {
    expect(isRole("admin")).toBe(true);
    expect(isRole("root")).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });

  it("grants owners every action", () => {
    for (const action of ACTIONS) expect(can("owner", action), action).toBe(true);
  });

  it("orders roles: each grants everything the next one down does", () => {
    for (let i = 0; i < ROLES.length - 1; i++) {
      for (const action of ACTIONS) {
        if (can(ROLES[i + 1]!, action)) expect(can(ROLES[i]!, action), action).toBe(true);
      }
    }
  });

  it.each<[Action, Record<Role, boolean>]>([
    ["projects:read", { owner: true, admin: true, member: true, viewer: true }],
    ["services:read", { owner: true, admin: true, member: true, viewer: true }],
    ["variables:read", { owner: true, admin: true, member: true, viewer: true }],
    ["services:manage", { owner: true, admin: true, member: true, viewer: false }],
    ["deployments:create", { owner: true, admin: true, member: true, viewer: false }],
    ["variables:manage", { owner: true, admin: true, member: true, viewer: false }],
    ["projects:manage", { owner: true, admin: true, member: false, viewer: false }],
    ["variables:reveal", { owner: true, admin: true, member: false, viewer: false }],
    ["instance:manage", { owner: true, admin: false, member: false, viewer: false }],
  ])("grants %s as expected", (action, expected) => {
    for (const role of ROLES) expect(can(role, action), role).toBe(expected[role]);
  });
});
