import {
  type AccessDenial,
  type Action,
  can,
  isEnvironmentAction,
  isProjectAction,
  type ProjectRole,
  type Role,
} from "@roundhouse/shared";
import { useEffectiveAccess } from "../queries/access";
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
 * Whether the caller may create workspaces. `workspaces:create` is an instance action
 * (ADR 0014): only instance admins hold it, whatever their workspace roles.
 *
 * @param me - `/v1/me`, or `undefined` while loading.
 * @returns `true` when the caller is an instance admin.
 */
export function canCreateWorkspace(me: Pick<Me, "user"> | undefined): boolean {
  return me?.user.instance_admin ?? false;
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

/** The caller's access to one project, from `GET /v1/workspaces/{id}/access/me`. */
export interface ProjectPermissions {
  /** Whether the effective access has loaded; until then checks use the workspace role. */
  loaded: boolean;
  /** The caller's project role; `null` without access, `undefined` while loading. */
  role: ProjectRole | null | undefined;
  /**
   * Whether the caller may perform `action`, in `environmentId` when given (protection
   * narrows deploys, config and variable changes there).
   */
  can: (action: Action, environmentId?: string) => boolean;
  /** Why `action` is refused, or `null` when it is allowed (or still loading). */
  denial: (action: Action, environmentId?: string) => AccessDenial | null;
  /** Whether an environment is protected; `undefined` until known. */
  isProtected: (environmentId: string) => boolean | undefined;
}

/**
 * Resolves the caller's permissions in one project, including grants, team grants and
 * environment protection (ADR 0014). The API computes them with the same
 * `resolveAccess` it enforces; this only decides which controls to show. While the
 * effective access loads, checks fall back to the workspace role's defaults so controls
 * don't flicker away.
 *
 * @param workspaceId - Workspace id.
 * @param projectId - Project id.
 * @returns Role and bound checks.
 * @example
 * const access = useProjectPermissions(workspaceId, projectId);
 * access.can("variables:manage", environment.id);
 */
export function useProjectPermissions(workspaceId: string, projectId: string): ProjectPermissions {
  const coarse = usePermissions(workspaceId);
  const effective = useEffectiveAccess(workspaceId);
  const data = effective.data;
  if (!data) {
    return {
      loaded: false,
      role: undefined,
      can: (action) => coarse.can(action),
      denial: () => null,
      isProtected: () => undefined,
    };
  }
  const project = data.projects.find((entry) => entry.project_id === projectId);
  const denial = (action: Action, environmentId?: string): AccessDenial | null => {
    if (!isProjectAction(action)) {
      return (data.actions as readonly Action[]).includes(action) ? null : "workspace_role";
    }
    if (!project) return "no_project_access";
    if (!(project.actions as readonly Action[]).includes(action)) return "project_role";
    if (environmentId !== undefined && isEnvironmentAction(action)) {
      const environment = project.environments.find(
        (entry) => entry.environment_id === environmentId,
      );
      return environment?.denied.find((entry) => entry.action === action)?.reason ?? null;
    }
    return null;
  };
  return {
    loaded: true,
    role: project?.role ?? null,
    can: (action, environmentId) => denial(action, environmentId) === null,
    denial,
    isProtected: (environmentId) =>
      project?.environments.find((entry) => entry.environment_id === environmentId)?.protected,
  };
}

const OPERATION_WORDS: Partial<Record<Action, string>> = {
  "deployments:create": "deploy",
  "services:manage": "change service settings",
  "variables:manage": "change variables",
};

/**
 * Explains a refusal in a sentence a person can act on.
 *
 * @param reason - Why the check failed.
 * @param action - The refused action.
 * @param environmentName - Name of the environment in scope, if any.
 * @returns The explanation.
 * @example
 * describeDenial("environment_protected", "variables:manage", "production");
 * // "production is protected: only project admins and people its rules list can change variables here."
 */
export function describeDenial(
  reason: AccessDenial,
  action: Action,
  environmentName?: string,
): string {
  const verb = OPERATION_WORDS[action] ?? "do this";
  switch (reason) {
    case "environment_protected":
      return `${environmentName ?? "This environment"} is protected: only project admins and people its rules list can ${verb} here.`;
    case "project_role":
      return `Your project role can't ${verb}. Ask a project admin for more access.`;
    case "no_project_access":
      return "You don't have access to this project.";
    default:
      return `Your role can't ${verb}.`;
  }
}
