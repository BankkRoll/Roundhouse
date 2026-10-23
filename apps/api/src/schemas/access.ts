/**
 * Access-control schemas (ADR 0014 "RBAC, teams, project & environment
 * access"): teams, project grants, environment protection, workspace access
 * settings, and the caller's effective access. Owned by the
 * api-authz-rbac-github stream; re-exported from `../schemas`.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import {
  ACCESS_DENIALS,
  ACTIONS,
  MEMBER_DEFAULT_PROJECT_ROLES,
  PROJECT_ROLES,
  PROTECTION_RULE_ROLES,
  ROLES,
  VIEWER_DEFAULT_PROJECT_ROLES,
} from "@openrail/shared";

const Millis = z.number().int().openapi({ description: "Unix time in milliseconds" });

const Slug = z
  .string()
  .max(40)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "expected a lowercase slug");

/** A project role. */
export const ProjectRoleSchema = z.enum(PROJECT_ROLES).openapi("ProjectRole");

// -----------------------------------------------------------------------------
// Workspace access settings
// -----------------------------------------------------------------------------

/** Project roles workspace members and viewers have on every project. */
export const WorkspaceAccessSettingsSchema = z
  .object({
    member_default_project_role: z.enum(MEMBER_DEFAULT_PROJECT_ROLES),
    viewer_default_project_role: z.enum(VIEWER_DEFAULT_PROJECT_ROLES),
  })
  .openapi("WorkspaceAccessSettings");

/** Partial update of {@link WorkspaceAccessSettingsSchema}. */
export const WorkspaceAccessSettingsPatchSchema = WorkspaceAccessSettingsSchema.partial()
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "nothing to update" })
  .openapi("WorkspaceAccessSettingsPatch");

// -----------------------------------------------------------------------------
// Teams
// -----------------------------------------------------------------------------

/** A team of a workspace. */
export const TeamSchema = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    member_count: z.number().int().nonnegative(),
    created_at: Millis,
    updated_at: Millis,
  })
  .openapi("Team");

/** A member of a team. */
export const TeamMemberSchema = z
  .object({
    user_id: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    workspace_role: z.enum(ROLES),
    added_at: Millis,
  })
  .openapi("TeamMember");

/** A team with its members. */
export const TeamDetailSchema = TeamSchema.extend({ members: z.array(TeamMemberSchema) }).openapi(
  "TeamDetail",
);

/** Body of `POST /v1/workspaces/{workspaceId}/teams`. */
export const CreateTeamBody = z
  .object({
    name: z.string().trim().min(1).max(100),
    /** Derived from `name` when omitted. Unique in the workspace. */
    slug: Slug.optional(),
    description: z.string().trim().max(500).optional(),
    /** Workspace members to add right away. */
    user_ids: z.array(z.string()).max(500).default([]),
  })
  .openapi("CreateTeam");

/** Body of `PATCH /v1/teams/{teamId}`. */
export const UpdateTeamBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    slug: Slug.optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "nothing to update" })
  .openapi("UpdateTeam");

/** Body of `PUT /v1/teams/{teamId}/members`: the complete member list. */
export const PutTeamMembersBody = z
  .object({ user_ids: z.array(z.string()).max(500) })
  .openapi("PutTeamMembers");

// -----------------------------------------------------------------------------
// Project grants
// -----------------------------------------------------------------------------

/** Who a grant is for. */
export const GrantPrincipalSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("user"), id: z.string() }),
    z.object({ type: z.literal("team"), id: z.string() }),
  ])
  .openapi("GrantPrincipal");

/** A project grant, with a display name for its principal. */
export const ProjectAccessGrantSchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
    principal: GrantPrincipalSchema,
    /** User name or team name. */
    principal_name: z.string(),
    role: ProjectRoleSchema,
    created_by: z.string().nullable(),
    created_at: Millis,
    updated_at: Millis,
  })
  .openapi("ProjectAccessGrant");

/** Who can see a project and how, grants and implied roles together. */
export const ProjectAccessSchema = z
  .object({
    grants: z.array(ProjectAccessGrantSchema),
    /** What workspace roles imply here (owners and admins are always `project_admin`). */
    implied: z.object({
      member: z.enum(MEMBER_DEFAULT_PROJECT_ROLES),
      viewer: z.enum(VIEWER_DEFAULT_PROJECT_ROLES),
    }),
  })
  .openapi("ProjectAccess");

/** Body of `PUT /v1/projects/{projectId}/access`: create or change one grant. */
export const PutProjectGrantBody = z
  .object({ principal: GrantPrincipalSchema, role: ProjectRoleSchema })
  .openapi("PutProjectGrant");

// -----------------------------------------------------------------------------
// Environment protection
// -----------------------------------------------------------------------------

/** Who besides project admins may perform one operation in a protected environment. */
export const ProtectionRuleSchema = z
  .object({
    roles: z.array(z.enum(PROTECTION_RULE_ROLES)).max(PROTECTION_RULE_ROLES.length),
    user_ids: z.array(z.string()).max(200),
    team_ids: z.array(z.string()).max(200),
  })
  .openapi("ProtectionRule");

/** Protection of one environment. */
export const EnvironmentProtectionSchema = z
  .object({
    environment_id: z.string(),
    protected: z.boolean(),
    /** Effective rules: the stored ones, or `DEFAULT_PROTECTION_RULES`. */
    rules: z.object({
      deploy: ProtectionRuleSchema,
      config: ProtectionRuleSchema,
      variables: ProtectionRuleSchema,
    }),
  })
  .openapi("EnvironmentProtection");

/** Body of `PUT /v1/environments/{environmentId}/protection`. */
export const PutEnvironmentProtectionBody = z
  .object({
    protected: z.boolean(),
    /** Omitted operations keep their current rule. */
    rules: z
      .object({
        deploy: ProtectionRuleSchema.optional(),
        config: ProtectionRuleSchema.optional(),
        variables: ProtectionRuleSchema.optional(),
      })
      .optional(),
  })
  .openapi("PutEnvironmentProtection");

// -----------------------------------------------------------------------------
// Effective access
// -----------------------------------------------------------------------------

/**
 * The caller's effective access, so the dashboard hides what it can't do.
 * Computed with `resolveAccess`; the API re-checks every request anyway.
 */
export const EffectiveAccessSchema = z
  .object({
    workspace_role: z.enum(ROLES),
    instance_admin: z.boolean(),
    /** Workspace and instance actions the caller holds. */
    actions: z.array(z.enum(ACTIONS)),
    projects: z.array(
      z.object({
        project_id: z.string(),
        role: ProjectRoleSchema,
        /** Project actions held without naming an environment. */
        actions: z.array(z.enum(ACTIONS)),
        /** Per environment: protected actions the caller is denied, with why. */
        environments: z.array(
          z.object({
            environment_id: z.string(),
            protected: z.boolean(),
            denied: z.array(z.object({ action: z.enum(ACTIONS), reason: z.enum(ACCESS_DENIALS) })),
          }),
        ),
      }),
    ),
  })
  .openapi("EffectiveAccess");
