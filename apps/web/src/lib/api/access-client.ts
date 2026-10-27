/**
 * Typed endpoint functions for the ADR 0014 access-control routes: workspace access
 * settings, the caller's effective access, teams and their members, project grants and
 * environment protection. Every write needs a fresh session except renaming a team;
 * {@link request} asks for the password and retries when the API refuses a stale one.
 *
 * @module
 */
import type {
  CreateTeamBody,
  EffectiveAccess,
  EnvironmentProtection,
  ProjectAccess,
  ProjectAccessGrant,
  ProjectDirectory,
  PutEnvironmentProtectionBody,
  PutProjectGrantBody,
  Team,
  TeamDetail,
  UpdateTeamBody,
  WorkspaceAccessSettings,
  WorkspaceAccessSettingsPatch,
} from "./access-types";
import { request } from "./client";

const seg = encodeURIComponent;

/**
 * Access-control endpoints.
 *
 * @example
 * const { teams } = await accessApi.listTeams("ws_123");
 */
export const accessApi = {
  /**
   * Reads the project roles members and viewers have on every project.
   *
   * @param workspaceId - Workspace id.
   * @param signal - Abort signal.
   * @returns The settings.
   */
  getSettings: (workspaceId: string, signal?: AbortSignal) =>
    request<WorkspaceAccessSettings>("GET", `/v1/workspaces/${seg(workspaceId)}/access-settings`, {
      signal,
    }),
  /**
   * Changes the default project roles. Needs a fresh session.
   *
   * @param workspaceId - Workspace id.
   * @param body - The roles to change.
   * @returns The settings after the change.
   */
  updateSettings: (workspaceId: string, body: WorkspaceAccessSettingsPatch) =>
    request<WorkspaceAccessSettings>(
      "PATCH",
      `/v1/workspaces/${seg(workspaceId)}/access-settings`,
      { body },
    ),
  /**
   * Reads what the caller may do in the workspace and each of its projects.
   *
   * @param workspaceId - Workspace id.
   * @param signal - Abort signal.
   * @returns The caller's effective access.
   */
  getEffectiveAccess: (workspaceId: string, signal?: AbortSignal) =>
    request<EffectiveAccess>("GET", `/v1/workspaces/${seg(workspaceId)}/access/me`, { signal }),

  /**
   * Lists the workspace's teams by name.
   *
   * @param workspaceId - Workspace id.
   * @param signal - Abort signal.
   * @returns The teams envelope.
   */
  listTeams: (workspaceId: string, signal?: AbortSignal) =>
    request<{ teams: Team[] }>("GET", `/v1/workspaces/${seg(workspaceId)}/teams`, { signal }),
  /**
   * Creates a team. 409 when the slug is taken. Needs a fresh session.
   *
   * @param workspaceId - Workspace id.
   * @param body - Name, optional slug and description, and members to add.
   * @returns The new team with its members.
   */
  createTeam: (workspaceId: string, body: CreateTeamBody) =>
    request<TeamDetail>("POST", `/v1/workspaces/${seg(workspaceId)}/teams`, { body }),
  /**
   * Reads a team with its members.
   *
   * @param teamId - Team id.
   * @param signal - Abort signal.
   * @returns The team.
   */
  getTeam: (teamId: string, signal?: AbortSignal) =>
    request<TeamDetail>("GET", `/v1/teams/${seg(teamId)}`, { signal }),
  /**
   * Renames or re-describes a team. 409 when the new slug is taken.
   *
   * @param teamId - Team id.
   * @param body - Fields to change.
   * @returns The team.
   */
  updateTeam: (teamId: string, body: UpdateTeamBody) =>
    request<Team>("PATCH", `/v1/teams/${seg(teamId)}`, { body }),
  /**
   * Deletes a team with its grants and protection rule entries. Needs a fresh session.
   *
   * @param teamId - Team id.
   * @returns Resolves on 204.
   */
  deleteTeam: (teamId: string) => request<void>("DELETE", `/v1/teams/${seg(teamId)}`),
  /**
   * Replaces a team's members. Needs a fresh session.
   *
   * @param teamId - Team id.
   * @param userIds - The complete member list; each must be a workspace member.
   * @returns The team with its new members.
   */
  setTeamMembers: (teamId: string, userIds: string[]) =>
    request<TeamDetail>("PUT", `/v1/teams/${seg(teamId)}/members`, {
      body: { user_ids: userIds },
    }),

  /**
   * Reads a project's grants and the roles workspace roles imply on it. Project admins
   * only.
   *
   * @param projectId - Project id.
   * @param signal - Abort signal.
   * @returns Grants and implied roles.
   */
  getProjectAccess: (projectId: string, signal?: AbortSignal) =>
    request<ProjectAccess>("GET", `/v1/projects/${seg(projectId)}/access`, { signal }),
  /**
   * Creates or changes the grant of one user or team. Needs a fresh session.
   *
   * @param projectId - Project id.
   * @param body - Principal and role.
   * @returns The grant.
   */
  putProjectGrant: (projectId: string, body: PutProjectGrantBody) =>
    request<ProjectAccessGrant>("PUT", `/v1/projects/${seg(projectId)}/access`, { body }),
  /**
   * Removes a grant. Needs a fresh session.
   *
   * @param projectId - Project id.
   * @param grantId - Grant id.
   * @returns Resolves on 204.
   */
  deleteProjectGrant: (projectId: string, grantId: string) =>
    request<void>("DELETE", `/v1/projects/${seg(projectId)}/access/${seg(grantId)}`),

  /**
   * Reads the names and avatars behind a project's access settings: its members and
   * whoever its grants and protection rules name. Needs only `projects:read`; emails
   * come back only for callers who may list the workspace's members.
   *
   * @param projectId - Project id.
   * @param signal - Abort signal.
   * @returns The directory.
   */
  getProjectDirectory: (projectId: string, signal?: AbortSignal) =>
    request<ProjectDirectory>("GET", `/v1/projects/${seg(projectId)}/directory`, { signal }),

  /**
   * Reads an environment's protection and effective rules.
   *
   * @param environmentId - Environment id.
   * @param signal - Abort signal.
   * @returns The protection.
   */
  getProtection: (environmentId: string, signal?: AbortSignal) =>
    request<EnvironmentProtection>("GET", `/v1/environments/${seg(environmentId)}/protection`, {
      signal,
    }),
  /**
   * Turns protection on or off and edits its rules. Needs a fresh session.
   *
   * @param environmentId - Environment id.
   * @param body - Whether protected, and the rules to replace.
   * @returns The protection after the change.
   */
  putProtection: (environmentId: string, body: PutEnvironmentProtectionBody) =>
    request<EnvironmentProtection>("PUT", `/v1/environments/${seg(environmentId)}/protection`, {
      body,
    }),
};
