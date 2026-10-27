/**
 * Wire types for the ADR 0014 access-control routes (teams, project grants, environment
 * protection, workspace access settings and the caller's effective access), derived from
 * the API's route definitions so the dashboard cannot drift from them.
 *
 * Type-only: nothing from the API source reaches the bundle.
 *
 * @module
 */
import type {
  BodyOf,
  createTeam,
  getEffectiveAccess,
  getEnvironmentProtection,
  getProjectAccess,
  getProjectDirectory,
  getTeam,
  getWorkspaceAccessSettings,
  listTeams,
  putEnvironmentProtection,
  putProjectGrant,
  ResponseOf,
  updateTeam,
  updateWorkspaceAccessSettings,
} from "../../../../api/src/contracts";

/** The project roles workspace members and viewers have on every project. */
export type WorkspaceAccessSettings = ResponseOf<typeof getWorkspaceAccessSettings, 200>;
/** `PATCH /v1/workspaces/{id}/access-settings` body. */
export type WorkspaceAccessSettingsPatch = BodyOf<typeof updateWorkspaceAccessSettings>;

/** A team as listed, with its member count. */
export type Team = ResponseOf<typeof listTeams, 200>["teams"][number];
/** A team with its members. */
export type TeamDetail = ResponseOf<typeof getTeam, 200>;
/** One member of a team. */
export type TeamMember = TeamDetail["members"][number];
/** `POST /v1/workspaces/{id}/teams` body. */
export type CreateTeamBody = BodyOf<typeof createTeam>;
/** `PATCH /v1/teams/{id}` body. */
export type UpdateTeamBody = BodyOf<typeof updateTeam>;

/** Who can see a project: grants and what workspace roles imply. */
export type ProjectAccess = ResponseOf<typeof getProjectAccess, 200>;
/** One grant of a project role to a user or a team. */
export type ProjectAccessGrant = ProjectAccess["grants"][number];
/** Who a grant is for. */
export type GrantPrincipal = ProjectAccessGrant["principal"];
/** `PUT /v1/projects/{id}/access` body. */
export type PutProjectGrantBody = BodyOf<typeof putProjectGrant>;

/** Names behind the user and team IDs a project's access settings use. */
export type ProjectDirectory = ResponseOf<typeof getProjectDirectory, 200>;
/** A person in a {@link ProjectDirectory}. */
export type DirectoryUser = ProjectDirectory["users"][number];

/** Protection of one environment and its effective rules. */
export type EnvironmentProtection = ResponseOf<typeof getEnvironmentProtection, 200>;
/** Who besides project admins may perform one protected operation (wire shape). */
export type ProtectionRuleWire = EnvironmentProtection["rules"]["deploy"];
/** `PUT /v1/environments/{id}/protection` body. */
export type PutEnvironmentProtectionBody = BodyOf<typeof putEnvironmentProtection>;

/** What the caller may do in a workspace and each of its projects. */
export type EffectiveAccess = ResponseOf<typeof getEffectiveAccess, 200>;
/** The caller's access to one project. */
export type EffectiveProjectAccess = EffectiveAccess["projects"][number];
