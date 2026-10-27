/**
 * Access resolution over the mock database (ADR 0014), shared by the access-control
 * mocks and the deploy and variables mocks: the same `resolveAccess` the API uses, fed
 * from `db.access` and the environments' `protected` flags.
 *
 * @module
 */
import {
  type Action,
  DEFAULT_PROTECTION_RULES,
  type EnvironmentProtection,
  type ProjectAccessGrant,
  type ProtectionRules,
  resolveAccess,
} from "@roundhouse/shared";
import type { DbAccessSettings } from "./access-db";
import { apiError } from "./common";
import { type DbUser, db } from "./db";

/**
 * The default project roles of a workspace.
 *
 * @param workspaceId - Workspace id.
 * @returns Its stored settings, or the defaults.
 */
export function settingsOf(workspaceId: string): DbAccessSettings {
  return (
    db.access.settings[workspaceId] ?? {
      member_default_project_role: "developer",
      viewer_default_project_role: "viewer",
    }
  );
}

/**
 * The live projects of a workspace.
 *
 * @param workspaceId - Workspace id.
 * @returns Projects that aren't deleted.
 */
export function liveProjectsOf(workspaceId: string) {
  return db.deploy.projects.filter((row) => row.workspace_id === workspaceId && !row.deleted);
}

/**
 * An environment's protection rules.
 *
 * @param environmentId - Environment id.
 * @returns The stored rules, or `DEFAULT_PROTECTION_RULES`.
 */
export function rulesOf(environmentId: string): ProtectionRules {
  return db.access.rules[environmentId] ?? DEFAULT_PROTECTION_RULES;
}

/**
 * Protection of every environment of a workspace's live projects.
 *
 * @param workspaceId - Workspace id.
 * @returns One entry per environment.
 */
export function protectionsOf(workspaceId: string): EnvironmentProtection[] {
  const projectIds = new Set(liveProjectsOf(workspaceId).map((row) => row.id));
  return db.deploy.environments
    .filter((row) => projectIds.has(row.project_id))
    .map((row) => ({
      environmentId: row.id,
      projectId: row.project_id,
      protected: row.protected,
      rules: rulesOf(row.id),
    }));
}

function grantsOf(workspaceId: string): ProjectAccessGrant[] {
  const projectIds = new Set(liveProjectsOf(workspaceId).map((row) => row.id));
  return db.access.grants
    .filter((row) => projectIds.has(row.project_id))
    .map((row) => ({
      projectId: row.project_id,
      principal:
        row.principal_type === "user"
          ? { type: "user", id: row.user_id ?? "" }
          : { type: "team", id: row.team_id ?? "" },
      role: row.role,
    }));
}

function teamIdsOf(workspaceId: string, userId: string): string[] {
  const teams = new Set(
    db.access.teams.filter((row) => row.workspace_id === workspaceId).map((row) => row.id),
  );
  return db.access.teamMembers
    .filter((row) => row.user_id === userId && teams.has(row.team_id))
    .map((row) => row.team_id);
}

/**
 * Builds the access resolver for a user in a workspace, from the mock's tables.
 *
 * @param workspaceId - Workspace id.
 * @param user - The caller.
 * @returns The resolver.
 */
export function accessFor(workspaceId: string, user: Pick<DbUser, "id" | "instance_admin">) {
  const membership = db.memberships.find(
    (row) => row.workspace_id === workspaceId && row.user_id === user.id,
  );
  const settings = settingsOf(workspaceId);
  return resolveAccess(
    {
      userId: user.id,
      workspaceRole: membership?.role ?? null,
      instanceAdmin: user.instance_admin ?? false,
      teamIds: teamIdsOf(workspaceId, user.id),
    },
    {
      settings: {
        memberDefaultProjectRole: settings.member_default_project_role,
        viewerDefaultProjectRole: settings.viewer_default_project_role,
      },
      grants: grantsOf(workspaceId),
      protections: protectionsOf(workspaceId),
    },
  );
}

/**
 * The API's refusal when environment protection denies an action, for the deploy and
 * variables mocks to call once their own checks passed.
 *
 * @param workspaceId - Workspace of the environment.
 * @param userId - The caller.
 * @param environmentId - Target environment.
 * @param action - A protected action (`deployments:create`, `services:manage`,
 *   `variables:manage`).
 * @returns 403 `forbidden` when the environment's rule refuses the caller, else `null`.
 */
export function protectionRefusal(
  workspaceId: string,
  userId: string,
  environmentId: string,
  action: Action,
): Response | null {
  const user = db.users.find((row) => row.id === userId);
  if (!user) return null;
  const decision = accessFor(workspaceId, user).check(action, { environmentId });
  if (decision.reason !== "environment_protected") return null;
  return apiError(
    403,
    "forbidden",
    `This environment is protected; your project role cannot perform ${action} here`,
  );
}

/**
 * Drops a removed member's team memberships and direct grants, as the API does in the
 * same batch that removes the membership.
 *
 * @param workspaceId - Workspace the member left.
 * @param userId - The removed user.
 */
export function forgetMember(workspaceId: string, userId: string): void {
  const teams = new Set(
    db.access.teams.filter((row) => row.workspace_id === workspaceId).map((row) => row.id),
  );
  const projects = new Set(liveProjectsOf(workspaceId).map((row) => row.id));
  db.access.teamMembers = db.access.teamMembers.filter(
    (row) => !(row.user_id === userId && teams.has(row.team_id)),
  );
  db.access.grants = db.access.grants.filter(
    (row) => !(row.user_id === userId && projects.has(row.project_id)),
  );
}
