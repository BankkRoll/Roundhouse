import { type Action, can, type Role } from "@roundhouse/shared";
import { useMembership } from "../queries/me";
import type { Me } from "./api/types";

/** The caller's role in a workspace and a bound permission check. */
export interface Permissions {
  /** Role, or `undefined` while `/v1/me` is loading. */
  role: Role | undefined;
  /** Whether the caller may perform `action`. Always `false` without a role. */
  can: (action: Action) => boolean;
}

/**
 * Resolves the caller's permissions in a workspace. The API enforces the same rules; this
 * only decides which controls to show.
 *
 * @param workspaceId - Workspace id.
 * @returns Role and checker.
 */
export function usePermissions(workspaceId: string): Permissions {
  const role = useMembership(workspaceId)?.role;
  return { role, can: (action) => (role ? can(role, action) : false) };
}

/**
 * Whether the caller may create workspaces. The API only lets people who already own or
 * administer a workspace do so.
 *
 * @param me - `/v1/me`, or `undefined` while loading.
 * @returns `true` when the caller is an owner or admin somewhere.
 */
export function canCreateWorkspace(me: Pick<Me, "workspaces"> | undefined): boolean {
  return (
    me?.workspaces.some((workspace) => workspace.role === "owner" || workspace.role === "admin") ??
    false
  );
}

/**
 * Roles the caller may hand out. Only owners can grant ownership.
 *
 * @param role - The caller's role.
 * @param all - All roles, most privileged first.
 * @returns Roles that can be assigned.
 */
export function assignableRoles(role: Role | undefined, all: readonly Role[]): Role[] {
  if (!role || !can(role, "members:manage")) return [];
  return role === "owner" ? [...all] : all.filter((candidate) => candidate !== "owner");
}

/**
 * Whether the caller may change install-wide settings (apps domain, TLS, the GitHub App).
 * Only instance admins may (ADR 0014); owning a workspace isn't enough.
 *
 * @param me - `/v1/me`, or `undefined` while loading.
 * @returns `true` when the caller is an instance admin.
 */
export function canManageInstance(me: Pick<Me, "user"> | undefined): boolean {
  return me?.user.instance_admin ?? false;
}
