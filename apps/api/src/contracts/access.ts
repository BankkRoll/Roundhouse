/**
 * Access-control routes (ADR 0014 "RBAC, teams, project & environment
 * access"): workspace access settings, teams, project grants, environment
 * protection, and the caller's effective access. Owned by the
 * api-authz-rbac-github stream. Every write changes who can do what, so all
 * of them need a fresh session.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { body, errors, json, sessionAuth, WorkspaceParams } from "../schemas";
import {
  CreateTeamBody,
  EffectiveAccessSchema,
  EnvironmentProtectionSchema,
  ProjectAccessGrantSchema,
  ProjectAccessSchema,
  PutEnvironmentProtectionBody,
  PutProjectGrantBody,
  PutTeamMembersBody,
  TeamDetailSchema,
  TeamSchema,
  UpdateTeamBody,
  WorkspaceAccessSettingsPatchSchema,
  WorkspaceAccessSettingsSchema,
} from "../schemas/access";
import { EnvironmentParams, ProjectParams, TeamParams } from "./params";
import { defineRoute, session } from "./policy";

const fresh = { reauth: true } as const;

// -----------------------------------------------------------------------------
// Workspace access settings
// -----------------------------------------------------------------------------

/** The project roles workspace members and viewers have by default. */
export const getWorkspaceAccessSettings = defineRoute(session("members:read"), {
  method: "get",
  path: "/v1/workspaces/{workspaceId}/access-settings",
  tags: ["access"],
  summary: "Get default project access",
  security: sessionAuth,
  request: { params: WorkspaceParams },
  responses: { 200: json(WorkspaceAccessSettingsSchema), ...errors(401, 403, 404) },
});

/** Changes the default project roles. Closes realtime sockets that lose access. */
export const updateWorkspaceAccessSettings = defineRoute(
  session("members:manage", ["workspace.access_settings_updated"], fresh),
  {
    method: "patch",
    path: "/v1/workspaces/{workspaceId}/access-settings",
    tags: ["access"],
    summary: "Change default project access",
    security: sessionAuth,
    request: { params: WorkspaceParams, ...body(WorkspaceAccessSettingsPatchSchema) },
    responses: { 200: json(WorkspaceAccessSettingsSchema), ...errors(400, 401, 403, 404) },
  },
);

/** What the caller may do in the workspace and each of its projects. */
export const getEffectiveAccess = defineRoute(session("workspace:read"), {
  method: "get",
  path: "/v1/workspaces/{workspaceId}/access/me",
  tags: ["access"],
  summary: "Get my effective access",
  security: sessionAuth,
  request: { params: WorkspaceParams },
  responses: { 200: json(EffectiveAccessSchema), ...errors(401, 403, 404) },
});

// -----------------------------------------------------------------------------
// Teams
// -----------------------------------------------------------------------------

/** The workspace's teams. */
export const listTeams = defineRoute(session("members:read"), {
  method: "get",
  path: "/v1/workspaces/{workspaceId}/teams",
  tags: ["teams"],
  summary: "List teams",
  security: sessionAuth,
  request: { params: WorkspaceParams },
  responses: { 200: json(z.object({ teams: z.array(TeamSchema) })), ...errors(401, 403, 404) },
});

/** Creates a team. 409 when the slug is taken; 400 when a user isn't a workspace member. */
export const createTeam = defineRoute(
  session("members:manage", ["team.created", "team.member_added"], fresh),
  {
    method: "post",
    path: "/v1/workspaces/{workspaceId}/teams",
    tags: ["teams"],
    summary: "Create a team",
    security: sessionAuth,
    request: { params: WorkspaceParams, ...body(CreateTeamBody) },
    responses: { 201: json(TeamDetailSchema, "Created"), ...errors(400, 401, 403, 404, 409) },
  },
);

/** A team with its members. */
export const getTeam = defineRoute(session("members:read"), {
  method: "get",
  path: "/v1/teams/{teamId}",
  tags: ["teams"],
  summary: "Get a team",
  security: sessionAuth,
  request: { params: TeamParams },
  responses: { 200: json(TeamDetailSchema), ...errors(401, 403, 404) },
});

/** Renames or re-describes a team. */
export const updateTeam = defineRoute(session("members:manage", ["team.updated"]), {
  method: "patch",
  path: "/v1/teams/{teamId}",
  tags: ["teams"],
  summary: "Update a team",
  security: sessionAuth,
  request: { params: TeamParams, ...body(UpdateTeamBody) },
  responses: { 200: json(TeamSchema), ...errors(400, 401, 403, 404, 409) },
});

/** Deletes a team and its grants and rule entries. */
export const deleteTeam = defineRoute(session("members:manage", ["team.deleted"], fresh), {
  method: "delete",
  path: "/v1/teams/{teamId}",
  tags: ["teams"],
  summary: "Delete a team",
  security: sessionAuth,
  request: { params: TeamParams },
  responses: { 204: { description: "Deleted" }, ...errors(401, 403, 404) },
});

/** Replaces a team's members; every user must be a workspace member. */
export const putTeamMembers = defineRoute(
  session("members:manage", ["team.member_added", "team.member_removed"], fresh),
  {
    method: "put",
    path: "/v1/teams/{teamId}/members",
    tags: ["teams"],
    summary: "Set a team's members",
    security: sessionAuth,
    request: { params: TeamParams, ...body(PutTeamMembersBody) },
    responses: { 200: json(TeamDetailSchema), ...errors(400, 401, 403, 404) },
  },
);

// -----------------------------------------------------------------------------
// Project grants
// -----------------------------------------------------------------------------

/** Who has access to a project. */
export const getProjectAccess = defineRoute(session("access:manage"), {
  method: "get",
  path: "/v1/projects/{projectId}/access",
  tags: ["access"],
  summary: "Get a project's access",
  security: sessionAuth,
  request: { params: ProjectParams },
  responses: { 200: json(ProjectAccessSchema), ...errors(401, 403, 404) },
});

/**
 * Creates or changes the grant of one user or team. 400 when the principal
 * isn't in the project's workspace.
 */
export const putProjectGrant = defineRoute(
  session("access:manage", ["access.granted", "access.changed"], fresh),
  {
    method: "put",
    path: "/v1/projects/{projectId}/access",
    tags: ["access"],
    summary: "Grant project access",
    security: sessionAuth,
    request: { params: ProjectParams, ...body(PutProjectGrantBody) },
    responses: { 200: json(ProjectAccessGrantSchema), ...errors(400, 401, 403, 404) },
  },
);

/** Removes a grant. Closes the principal's realtime sockets on the project if they lose access. */
export const deleteProjectGrant = defineRoute(session("access:manage", ["access.revoked"], fresh), {
  method: "delete",
  path: "/v1/projects/{projectId}/access/{grantId}",
  tags: ["access"],
  summary: "Revoke project access",
  security: sessionAuth,
  request: { params: ProjectParams.extend({ grantId: z.string() }) },
  responses: { 204: { description: "Revoked" }, ...errors(401, 403, 404) },
});

// -----------------------------------------------------------------------------
// Environment protection
// -----------------------------------------------------------------------------

/** An environment's protection and effective rules. */
export const getEnvironmentProtection = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/environments/{environmentId}/protection",
  tags: ["access"],
  summary: "Get environment protection",
  security: sessionAuth,
  request: { params: EnvironmentParams },
  responses: { 200: json(EnvironmentProtectionSchema), ...errors(401, 403, 404) },
});

/** Turns protection on or off and edits its rules. */
export const putEnvironmentProtection = defineRoute(
  session("access:manage", ["environment.protection_updated"], fresh),
  {
    method: "put",
    path: "/v1/environments/{environmentId}/protection",
    tags: ["access"],
    summary: "Set environment protection",
    security: sessionAuth,
    request: { params: EnvironmentParams, ...body(PutEnvironmentProtectionBody) },
    responses: { 200: json(EnvironmentProtectionSchema), ...errors(400, 401, 403, 404) },
  },
);

/** Every access route, by name. */
export const ACCESS_ROUTES = {
  getWorkspaceAccessSettings,
  updateWorkspaceAccessSettings,
  getEffectiveAccess,
  listTeams,
  createTeam,
  getTeam,
  updateTeam,
  deleteTeam,
  putTeamMembers,
  getProjectAccess,
  putProjectGrant,
  deleteProjectGrant,
  getEnvironmentProtection,
  putEnvironmentProtection,
} as const;
