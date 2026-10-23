/**
 * Loads what `resolveAccess` (from `@roundhouse/shared`) needs for one caller
 * in one workspace, and only as much of it as the check at hand reads: the
 * workspace's access settings always, the caller's teams and the project's
 * grants for project actions, and an environment's protection when the check
 * names one (ADR 0014 "Access control"). {@link loadWorkspaceAccess} loads
 * a whole workspace for checks that span projects.
 *
 * @module
 */
import {
  type Db,
  environments,
  projectAccessGrants,
  projects,
  teamMembers,
  teams,
  workspaceMembers,
  workspaces,
} from "@roundhouse/db";
import {
  type AccessContext,
  type AccessScope,
  DEFAULT_PROTECTION_RULES,
  DEFAULT_WORKSPACE_ACCESS_SETTINGS,
  type EnvironmentProtection,
  type ProjectAccessGrant,
  type Role,
  type WorkspaceAccessSettings,
} from "@roundhouse/shared";
import { and, asc, eq, isNull } from "drizzle-orm";

type GrantRow = Pick<
  typeof projectAccessGrants.$inferSelect,
  "projectId" | "principalType" | "userId" | "teamId" | "role"
>;

function toGrant(g: GrantRow): ProjectAccessGrant {
  return {
    projectId: g.projectId,
    principal:
      g.principalType === "user"
        ? { type: "user", id: g.userId! }
        : { type: "team", id: g.teamId! },
    role: g.role,
  };
}

/** What {@link loadAccessContext} loaded, ready for `resolveAccess`. */
export interface LoadedAccess {
  context: AccessContext;
  /** The caller's teams in the workspace. */
  teamIds: string[];
}

/**
 * Loads the access state a check of `scope` reads.
 *
 * An environment outside the workspace's projects is left out of
 * `protections`, so `resolveAccess` denies a check naming it (fail closed).
 *
 * @param db - Database client.
 * @param input - The workspace, its settings, the caller, and the scope of the check.
 * @returns Context and team IDs for `resolveAccess`.
 */
export async function loadAccessContext(
  db: Db,
  input: {
    workspaceId: string;
    settings: WorkspaceAccessSettings;
    userId: string;
    scope: AccessScope;
  },
): Promise<LoadedAccess> {
  const { scope } = input;
  const empty: LoadedAccess = {
    context: { settings: input.settings, grants: [], protections: [] },
    teamIds: [],
  };
  if (scope.projectId === undefined && scope.environmentId === undefined) return empty;

  const protections: EnvironmentProtection[] = [];
  let projectId = scope.projectId;
  if (scope.environmentId !== undefined) {
    const [env] = await db
      .select({
        id: environments.id,
        projectId: environments.projectId,
        protected: environments.protected,
        rules: environments.protectionRules,
      })
      .from(environments)
      .where(eq(environments.id, scope.environmentId))
      .limit(1);
    if (env) {
      protections.push({
        environmentId: env.id,
        projectId: env.projectId,
        protected: env.protected,
        rules: env.rules ?? DEFAULT_PROTECTION_RULES,
      });
      projectId ??= env.projectId;
    }
  }
  if (projectId === undefined) return { ...empty, context: { ...empty.context, protections } };

  const [teamRows, grantRows] = await Promise.all([
    db
      .select({ id: teamMembers.teamId })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(and(eq(teamMembers.userId, input.userId), eq(teams.workspaceId, input.workspaceId))),
    db
      .select({
        projectId: projectAccessGrants.projectId,
        principalType: projectAccessGrants.principalType,
        userId: projectAccessGrants.userId,
        teamId: projectAccessGrants.teamId,
        role: projectAccessGrants.role,
      })
      .from(projectAccessGrants)
      .where(eq(projectAccessGrants.projectId, projectId)),
  ]);
  return {
    context: { settings: input.settings, grants: grantRows.map(toGrant), protections },
    teamIds: teamRows.map((t) => t.id),
  };
}

/** Everything `resolveAccess` needs to answer for every project of a workspace at once. */
export interface WorkspaceAccess extends LoadedAccess {
  /** The caller's workspace role, or `null` when not a member. */
  role: Role | null;
  /** The workspace's live projects, oldest first. */
  projectIds: string[];
}

/**
 * Loads a caller's membership and the whole access state of a workspace:
 * settings, the caller's teams, every grant and every environment's
 * protection. For screens and checks that span projects (effective access,
 * realtime re-checks); a single request check uses {@link loadAccessContext}.
 *
 * @param db - Database client.
 * @param workspaceId - A live workspace.
 * @param userId - The caller.
 * @param projectId - Limit grants, protections and projects to this one project.
 * @returns The loaded state; `role` is `null` for a non-member (or a deleted workspace).
 */
export async function loadWorkspaceAccess(
  db: Db,
  workspaceId: string,
  userId: string,
  projectId?: string,
): Promise<WorkspaceAccess> {
  const [member] = await db
    .select({
      role: workspaceMembers.role,
      memberDefaultProjectRole: workspaces.memberDefaultProjectRole,
      viewerDefaultProjectRole: workspaces.viewerDefaultProjectRole,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(1);
  const settings: WorkspaceAccessSettings = member
    ? {
        memberDefaultProjectRole: member.memberDefaultProjectRole,
        viewerDefaultProjectRole: member.viewerDefaultProjectRole,
      }
    : DEFAULT_WORKSPACE_ACCESS_SETTINGS;
  if (!member) {
    return {
      role: null,
      projectIds: [],
      teamIds: [],
      context: { settings, grants: [], protections: [] },
    };
  }
  const inScope = and(
    eq(projects.workspaceId, workspaceId),
    isNull(projects.deletedAt),
    projectId === undefined ? undefined : eq(projects.id, projectId),
  );
  const [projectRows, teamRows, grantRows, envRows] = await Promise.all([
    db.select({ id: projects.id }).from(projects).where(inScope).orderBy(asc(projects.id)),
    db
      .select({ id: teamMembers.teamId })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId))
      .where(and(eq(teamMembers.userId, userId), eq(teams.workspaceId, workspaceId))),
    db
      .select({
        projectId: projectAccessGrants.projectId,
        principalType: projectAccessGrants.principalType,
        userId: projectAccessGrants.userId,
        teamId: projectAccessGrants.teamId,
        role: projectAccessGrants.role,
      })
      .from(projectAccessGrants)
      .innerJoin(projects, eq(projects.id, projectAccessGrants.projectId))
      .where(inScope),
    db
      .select({
        id: environments.id,
        projectId: environments.projectId,
        protected: environments.protected,
        rules: environments.protectionRules,
      })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(inScope)
      .orderBy(asc(environments.id)),
  ]);
  return {
    role: member.role,
    projectIds: projectRows.map((p) => p.id),
    teamIds: teamRows.map((t) => t.id),
    context: {
      settings,
      grants: grantRows.map(toGrant),
      protections: envRows.map((e) => ({
        environmentId: e.id,
        projectId: e.projectId,
        protected: e.protected,
        rules: e.rules ?? DEFAULT_PROTECTION_RULES,
      })),
    },
  };
}
