import { describe, expect, it } from "vitest";
import { can, isRole } from "./rbac";

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
});
