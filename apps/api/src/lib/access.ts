/**
 * Loads what `resolveAccess` (from `@roundhouse/shared`) needs for one caller
 * in one workspace, and only as much of it as the check at hand reads: the
 * workspace's access settings always, the caller's teams and the project's
 * grants for project actions, and an environment's protection when the check
 * names one (ADR 0014 "Access control").
 *
 * @module
 */
import { type Db, environments, projectAccessGrants, teamMembers, teams } from "@roundhouse/db";
import {
  type AccessContext,
  type AccessScope,
  DEFAULT_PROTECTION_RULES,
  type EnvironmentProtection,
  type ProjectAccessGrant,
  type WorkspaceAccessSettings,
} from "@roundhouse/shared";
import { and, eq } from "drizzle-orm";

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
  const grants: ProjectAccessGrant[] = grantRows.map((g) => ({
    projectId: g.projectId,
    principal:
      g.principalType === "user"
        ? { type: "user", id: g.userId! }
        : { type: "team", id: g.teamId! },
    role: g.role,
  }));
  return {
    context: { settings: input.settings, grants, protections },
    teamIds: teamRows.map((t) => t.id),
  };
}
