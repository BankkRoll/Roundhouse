/**
 * ADR 0014 access-control routes: `ACCESS_ROUTES` in `../contracts/access`.
 *
 * - Workspace access settings: the project roles members and viewers have
 *   on every project by default.
 * - Effective access: what the caller may do, for the dashboard to hide the
 *   rest (the API re-checks every request anyway).
 * - Teams and their members (`members:manage`).
 * - Project grants to users and teams (`access:manage` on the project).
 * - Environment protection (`access:manage` on the project).
 *
 * Every change that can take access away asks the affected projects'
 * realtime rooms to re-check their sockets once it has committed.
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
  users,
  workspaceMembers,
  workspaces,
} from "@roundhouse/db";
import {
  ACTIONS,
  type Action,
  DEFAULT_PROTECTION_RULES,
  ENVIRONMENT_ACTIONS,
  INSTANCE_ACTIONS,
  newId,
  PROJECT_ACTIONS,
  PROTECTED_OPERATIONS,
  type ProtectionRule,
  type ProtectionRules,
  resolveAccess,
  slugify,
  WORKSPACE_ACTIONS,
} from "@roundhouse/shared";
import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { type AppContext, type Caller, clientIp, createRouter, requireWorkspace } from "../context";
import {
  createTeam,
  deleteProjectGrant,
  deleteTeam,
  getEffectiveAccess,
  getEnvironmentProtection,
  getProjectAccess,
  getTeam,
  getWorkspaceAccessSettings,
  listTeams,
  policyOf,
  putEnvironmentProtection,
  putProjectGrant,
  putTeamMembers,
  updateTeam,
  updateWorkspaceAccessSettings,
} from "../contracts";
import { loadWorkspaceAccess } from "../lib/access";
import { auditInsert } from "../lib/audit";
import { ApiError, conflict, type ErrorDetail, isUniqueViolation, notFound } from "../lib/errors";
import { revalidateProjects, revalidateWorkspace } from "../lib/realtime";
import { projectScope } from "../lib/scope";

type TeamRow = typeof teams.$inferSelect;
type ApiRule = { roles: ProtectionRule["roles"]; user_ids: string[]; team_ids: string[] };

const actionOf = (route: Parameters<typeof policyOf>[0]) => policyOf(route).action!;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Loads a team of a live workspace and checks `action` there; 404 for non-members. */
async function teamScope(
  c: AppContext,
  teamId: string,
  action: Action,
): Promise<{ team: TeamRow; caller: Caller }> {
  const [row] = await c
    .get("db")
    .select({ team: teams })
    .from(teams)
    .innerJoin(workspaces, eq(workspaces.id, teams.workspaceId))
    .where(and(eq(teams.id, teamId), isNull(workspaces.deletedAt)))
    .limit(1);
  if (!row) throw notFound("Team");
  try {
    return { team: row.team, caller: await requireWorkspace(c, row.team.workspaceId, action) };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) throw notFound("Team");
    throw err;
  }
}

/**
 * Checks that every user ID is a member of the workspace.
 *
 * @throws {ApiError} 400 listing each user that isn't.
 */
async function requireMembers(
  db: Db,
  workspaceId: string,
  userIds: readonly string[],
  field: string,
) {
  const unique = [...new Set(userIds)];
  if (!unique.length) return unique;
  const rows = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, unique)),
    );
  const found = new Set(rows.map((r) => r.userId));
  const missing: ErrorDetail[] = unique
    .filter((id) => !found.has(id))
    .map((id) => ({
      field,
      code: "not_a_member",
      message: `${id} is not a member of this workspace`,
    }));
  if (missing.length) {
    throw new ApiError(
      400,
      "invalid_request",
      "Every user must be a member of the workspace",
      missing,
    );
  }
  return unique;
}

/**
 * Checks that every team ID is a team of the workspace.
 *
 * @throws {ApiError} 400 listing each team that isn't.
 */
async function requireTeams(
  db: Db,
  workspaceId: string,
  teamIds: readonly string[],
  field: string,
) {
  const unique = [...new Set(teamIds)];
  if (!unique.length) return unique;
  const rows = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.workspaceId, workspaceId), inArray(teams.id, unique)));
  const found = new Set(rows.map((r) => r.id));
  const missing: ErrorDetail[] = unique
    .filter((id) => !found.has(id))
    .map((id) => ({
      field,
      code: "unknown_team",
      message: `${id} is not a team of this workspace`,
    }));
  if (missing.length) {
    throw new ApiError(400, "invalid_request", "Every team must belong to the workspace", missing);
  }
  return unique;
}

async function teamMemberIds(db: Db, teamId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
  return rows.map((r) => r.userId);
}

function toApiTeam(team: TeamRow, memberCount: number) {
  return {
    id: team.id,
    workspace_id: team.workspaceId,
    name: team.name,
    slug: team.slug,
    description: team.description,
    member_count: memberCount,
    created_at: +team.createdAt,
    updated_at: +team.updatedAt,
  };
}

async function teamDetail(db: Db, team: TeamRow) {
  const members = await db
    .select({
      user_id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
      workspace_role: workspaceMembers.role,
      addedAt: teamMembers.createdAt,
    })
    .from(teamMembers)
    .innerJoin(users, eq(users.id, teamMembers.userId))
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, users.id),
        eq(workspaceMembers.workspaceId, team.workspaceId),
      ),
    )
    .where(eq(teamMembers.teamId, team.id))
    .orderBy(asc(users.name));
  return {
    ...toApiTeam(team, members.length),
    members: members.map(({ addedAt, ...m }) => ({ ...m, added_at: +addedAt })),
  };
}

const fromApiRule = (r: ApiRule): ProtectionRule => ({
  roles: [...new Set(r.roles)],
  userIds: [...new Set(r.user_ids)],
  teamIds: [...new Set(r.team_ids)],
});

const toApiRule = (r: ProtectionRule): ApiRule => ({
  roles: r.roles,
  user_ids: r.userIds,
  team_ids: r.teamIds,
});

function toApiProtection(env: typeof environments.$inferSelect) {
  const rules = env.protectionRules ?? DEFAULT_PROTECTION_RULES;
  return {
    environment_id: env.id,
    protected: env.protected,
    rules: {
      deploy: toApiRule(rules.deploy),
      config: toApiRule(rules.config),
      variables: toApiRule(rules.variables),
    },
    require_approval: env.requireApproval,
  };
}

/** Loads a live project's environment and checks `action` on the project. */
async function environmentScope(c: AppContext, environmentId: string, action: Action) {
  const [env] = await c
    .get("db")
    .select()
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  if (!env) throw notFound("Environment");
  try {
    const { project, caller } = await projectScope(c, env.projectId, action);
    return { env, project, caller };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) throw notFound("Environment");
    throw err;
  }
}

type GrantRow = typeof projectAccessGrants.$inferSelect;

async function grantsWithNames(db: Db, where: ReturnType<typeof eq>) {
  const rows = await db
    .select({
      grant: projectAccessGrants,
      userName: users.name,
      teamName: teams.name,
    })
    .from(projectAccessGrants)
    .leftJoin(users, eq(users.id, projectAccessGrants.userId))
    .leftJoin(teams, eq(teams.id, projectAccessGrants.teamId))
    .where(where)
    .orderBy(asc(projectAccessGrants.id));
  return rows.map(({ grant, userName, teamName }) =>
    toApiGrant(grant, (grant.principalType === "user" ? userName : teamName) ?? ""),
  );
}

function toApiGrant(g: GrantRow, principalName: string) {
  return {
    id: g.id,
    project_id: g.projectId,
    principal:
      g.principalType === "user"
        ? { type: "user" as const, id: g.userId! }
        : { type: "team" as const, id: g.teamId! },
    principal_name: principalName,
    role: g.role,
    created_by: g.createdBy,
    created_at: +g.createdAt,
    updated_at: +g.updatedAt,
  };
}

/** Users whose project access a grant decides: its user, or its team's members. */
async function grantSubjects(db: Db, g: Pick<GrantRow, "principalType" | "userId" | "teamId">) {
  return g.principalType === "user" ? [g.userId!] : teamMemberIds(db, g.teamId!);
}

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

/** Access-control route handlers. */
export const accessRoutes = createRouter()
  .openapi(getWorkspaceAccessSettings, async (c) => {
    const { workspaceId } = c.req.valid("param");
    await requireWorkspace(c, workspaceId, actionOf(getWorkspaceAccessSettings));
    const [ws] = await c
      .get("db")
      .select({
        member: workspaces.memberDefaultProjectRole,
        viewer: workspaces.viewerDefaultProjectRole,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!ws) throw notFound("Workspace");
    return c.json(
      { member_default_project_role: ws.member, viewer_default_project_role: ws.viewer },
      200,
    );
  })
  .openapi(updateWorkspaceAccessSettings, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const patch = c.req.valid("json");
    const m = await requireWorkspace(c, workspaceId, actionOf(updateWorkspaceAccessSettings));
    const db = c.get("db");
    const [before] = await db
      .select({
        member: workspaces.memberDefaultProjectRole,
        viewer: workspaces.viewerDefaultProjectRole,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!before) throw notFound("Workspace");
    const after = {
      member: patch.member_default_project_role ?? before.member,
      viewer: patch.viewer_default_project_role ?? before.viewer,
    };
    await db.batch([
      db
        .update(workspaces)
        .set({ memberDefaultProjectRole: after.member, viewerDefaultProjectRole: after.viewer })
        .where(eq(workspaces.id, workspaceId)),
      auditInsert(db, {
        workspaceId,
        ...m.actor,
        action: "workspace.access_settings_updated",
        targetType: "workspace",
        targetId: workspaceId,
        metadata: {
          from: {
            member_default_project_role: before.member,
            viewer_default_project_role: before.viewer,
          },
          to: {
            member_default_project_role: after.member,
            viewer_default_project_role: after.viewer,
          },
        },
        ip: clientIp(c),
      }),
    ]);
    await revalidateWorkspace(db, c.env, workspaceId);
    return c.json(
      { member_default_project_role: after.member, viewer_default_project_role: after.viewer },
      200,
    );
  })
  .openapi(getEffectiveAccess, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const m = await requireWorkspace(c, workspaceId, actionOf(getEffectiveAccess));
    const db = c.get("db");
    const [flags] = m.principal.token
      ? []
      : await db
          .select({ instanceAdmin: users.instanceAdmin })
          .from(users)
          .where(eq(users.id, m.user.id))
          .limit(1);
    const instanceAdmin = flags?.instanceAdmin ?? false;
    const loaded = await loadWorkspaceAccess(db, workspaceId, m.user.id);
    const access = resolveAccess(
      {
        userId: m.user.id,
        workspaceRole: m.role,
        instanceAdmin,
        teamIds: loaded.teamIds,
        tokenScopes: m.principal.token?.scopes ?? null,
      },
      loaded.context,
    );
    const held = [...WORKSPACE_ACTIONS, ...INSTANCE_ACTIONS].filter((a: Action) => access.can(a));
    const projectsOut = [];
    for (const projectId of loaded.projectIds) {
      const role = access.projectRole(projectId);
      if (role === null || !access.can("projects:read", { projectId })) continue;
      projectsOut.push({
        project_id: projectId,
        role,
        actions: PROJECT_ACTIONS.filter((a) => access.can(a, { projectId })),
        environments: loaded.context.protections
          .filter((p) => p.projectId === projectId)
          .map((p) => ({
            environment_id: p.environmentId,
            protected: p.protected,
            denied: ENVIRONMENT_ACTIONS.flatMap((action) => {
              const d = access.check(action, { environmentId: p.environmentId });
              return d.allowed || d.reason === null ? [] : [{ action, reason: d.reason }];
            }),
          })),
      });
    }
    return c.json(
      {
        workspace_role: m.role,
        instance_admin: instanceAdmin && !m.principal.token,
        actions: ACTIONS.filter((a) => (held as readonly Action[]).includes(a)),
        projects: projectsOut,
      },
      200,
    );
  })
  .openapi(listTeams, async (c) => {
    const { workspaceId } = c.req.valid("param");
    await requireWorkspace(c, workspaceId, actionOf(listTeams));
    const rows = await c
      .get("db")
      .select({ team: teams, members: count(teamMembers.id) })
      .from(teams)
      .leftJoin(teamMembers, eq(teamMembers.teamId, teams.id))
      .where(eq(teams.workspaceId, workspaceId))
      .groupBy(teams.id)
      .orderBy(asc(teams.name));
    return c.json({ teams: rows.map((r) => toApiTeam(r.team, r.members)) }, 200);
  })
  .openapi(createTeam, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const m = await requireWorkspace(c, workspaceId, actionOf(createTeam));
    const db = c.get("db");
    const userIds = await requireMembers(db, workspaceId, body.user_ids, "user_ids");
    const team: typeof teams.$inferInsert = {
      id: newId("team"),
      workspaceId,
      name: body.name,
      slug: body.slug ?? slugify(body.name, 40, "team"),
      description: body.description || null,
    };
    try {
      await db.batch([
        db.insert(teams).values(team),
        ...userIds.map((userId) =>
          db.insert(teamMembers).values({ id: newId("teamMember"), teamId: team.id!, userId }),
        ),
        auditInsert(db, {
          workspaceId,
          ...m.actor,
          action: "team.created",
          targetType: "team",
          targetId: team.id!,
          metadata: { name: team.name, slug: team.slug, user_ids: userIds },
          ip: clientIp(c),
        }),
      ]);
    } catch (err) {
      if (isUniqueViolation(err, "teams.slug")) {
        throw conflict(`A team with the slug "${team.slug}" already exists`);
      }
      throw err;
    }
    const [row] = await db.select().from(teams).where(eq(teams.id, team.id!)).limit(1);
    return c.json(await teamDetail(db, row!), 201);
  })
  .openapi(getTeam, async (c) => {
    const { teamId } = c.req.valid("param");
    const { team } = await teamScope(c, teamId, actionOf(getTeam));
    return c.json(await teamDetail(c.get("db"), team), 200);
  })
  .openapi(updateTeam, async (c) => {
    const { teamId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { team, caller } = await teamScope(c, teamId, actionOf(updateTeam));
    const db = c.get("db");
    const set = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.slug !== undefined ? { slug: body.slug } : {}),
      ...(body.description !== undefined ? { description: body.description || null } : {}),
    };
    try {
      await db.batch([
        db.update(teams).set(set).where(eq(teams.id, teamId)),
        auditInsert(db, {
          workspaceId: team.workspaceId,
          ...caller.actor,
          action: "team.updated",
          targetType: "team",
          targetId: teamId,
          metadata: { ...set },
          ip: clientIp(c),
        }),
      ]);
    } catch (err) {
      if (isUniqueViolation(err, "teams.slug")) {
        throw conflict(`A team with the slug "${body.slug}" already exists`);
      }
      throw err;
    }
    const [row] = await db
      .select({ team: teams, members: count(teamMembers.id) })
      .from(teams)
      .leftJoin(teamMembers, eq(teamMembers.teamId, teams.id))
      .where(eq(teams.id, teamId))
      .groupBy(teams.id);
    return c.json(toApiTeam(row!.team, row!.members), 200);
  })
  .openapi(deleteTeam, async (c) => {
    const { teamId } = c.req.valid("param");
    const { team, caller } = await teamScope(c, teamId, actionOf(deleteTeam));
    const db = c.get("db");
    const members = await teamMemberIds(db, teamId);
    // Rules naming the team lose it in the same batch; its grants and
    // memberships go with the row (foreign keys cascade).
    const ruled = await db
      .select({ id: environments.id, rules: environments.protectionRules })
      .from(environments)
      .innerJoin(projects, eq(projects.id, environments.projectId))
      .where(
        and(
          eq(projects.workspaceId, team.workspaceId),
          sql`${environments.protectionRules} LIKE ${`%${teamId}%`}`,
        ),
      );
    const rewrites = ruled.flatMap(({ id, rules }) => {
      if (!rules) return [];
      const next = Object.fromEntries(
        PROTECTED_OPERATIONS.map((op) => [
          op,
          { ...rules[op], teamIds: rules[op].teamIds.filter((t) => t !== teamId) },
        ]),
      ) as ProtectionRules;
      return [
        db.update(environments).set({ protectionRules: next }).where(eq(environments.id, id)),
      ];
    });
    await db.batch([
      db.delete(teams).where(eq(teams.id, teamId)),
      ...rewrites,
      auditInsert(db, {
        workspaceId: team.workspaceId,
        ...caller.actor,
        action: "team.deleted",
        targetType: "team",
        targetId: teamId,
        metadata: { name: team.name, slug: team.slug, user_ids: members },
        ip: clientIp(c),
      }),
    ]);
    if (members.length) {
      await revalidateWorkspace(db, c.env, team.workspaceId, { userIds: members });
    }
    return c.body(null, 204);
  })
  .openapi(putTeamMembers, async (c) => {
    const { teamId } = c.req.valid("param");
    const { user_ids } = c.req.valid("json");
    const { team, caller } = await teamScope(c, teamId, actionOf(putTeamMembers));
    const db = c.get("db");
    const wanted = await requireMembers(db, team.workspaceId, user_ids, "user_ids");
    const current = new Set(await teamMemberIds(db, teamId));
    const added = wanted.filter((u) => !current.has(u));
    const removed = [...current].filter((u) => !wanted.includes(u));
    if (added.length || removed.length) {
      await db.batch([
        db
          .delete(teamMembers)
          .where(and(eq(teamMembers.teamId, teamId), inArray(teamMembers.userId, removed))),
        ...added.map((userId) =>
          db
            .insert(teamMembers)
            .values({ id: newId("teamMember"), teamId, userId })
            .onConflictDoNothing(),
        ),
        ...(added.length
          ? [
              auditInsert(db, {
                workspaceId: team.workspaceId,
                ...caller.actor,
                action: "team.member_added",
                targetType: "team",
                targetId: teamId,
                metadata: { user_ids: added },
                ip: clientIp(c),
              }),
            ]
          : []),
        ...(removed.length
          ? [
              auditInsert(db, {
                workspaceId: team.workspaceId,
                ...caller.actor,
                action: "team.member_removed",
                targetType: "team",
                targetId: teamId,
                metadata: { user_ids: removed },
                ip: clientIp(c),
              }),
            ]
          : []),
      ]);
    }
    if (removed.length) {
      await revalidateWorkspace(db, c.env, team.workspaceId, { userIds: removed });
    }
    return c.json(await teamDetail(db, team), 200);
  })
  .openapi(getProjectAccess, async (c) => {
    const { projectId } = c.req.valid("param");
    const { project } = await projectScope(c, projectId, actionOf(getProjectAccess));
    const db = c.get("db");
    const [ws] = await db
      .select({
        member: workspaces.memberDefaultProjectRole,
        viewer: workspaces.viewerDefaultProjectRole,
      })
      .from(workspaces)
      .where(eq(workspaces.id, project.workspaceId))
      .limit(1);
    return c.json(
      {
        grants: await grantsWithNames(db, eq(projectAccessGrants.projectId, projectId)),
        implied: { member: ws!.member, viewer: ws!.viewer },
      },
      200,
    );
  })
  .openapi(putProjectGrant, async (c) => {
    const { projectId } = c.req.valid("param");
    const { principal, role } = c.req.valid("json");
    const { project, caller } = await projectScope(c, projectId, actionOf(putProjectGrant));
    const db = c.get("db");
    if (principal.type === "user") {
      await requireMembers(db, project.workspaceId, [principal.id], "principal.id");
    } else {
      await requireTeams(db, project.workspaceId, [principal.id], "principal.id");
    }
    const column =
      principal.type === "user" ? projectAccessGrants.userId : projectAccessGrants.teamId;
    const [existing] = await db
      .select()
      .from(projectAccessGrants)
      .where(
        and(
          eq(projectAccessGrants.projectId, projectId),
          eq(projectAccessGrants.principalType, principal.type),
          eq(column, principal.id),
        ),
      )
      .limit(1);
    const metadata = { principal_type: principal.type, principal_id: principal.id, role };
    let id: string;
    try {
      if (existing) {
        id = existing.id;
        await db.batch([
          db
            .update(projectAccessGrants)
            .set({ role })
            .where(eq(projectAccessGrants.id, existing.id)),
          auditInsert(db, {
            workspaceId: project.workspaceId,
            ...caller.actor,
            action: "access.changed",
            targetType: "project",
            targetId: projectId,
            metadata: { ...metadata, from: existing.role },
            ip: clientIp(c),
          }),
        ]);
      } else {
        id = newId("projectAccessGrant");
        await db.batch([
          db.insert(projectAccessGrants).values({
            id,
            projectId,
            principalType: principal.type,
            userId: principal.type === "user" ? principal.id : null,
            teamId: principal.type === "team" ? principal.id : null,
            role,
            createdBy: caller.user.id,
          }),
          auditInsert(db, {
            workspaceId: project.workspaceId,
            ...caller.actor,
            action: "access.granted",
            targetType: "project",
            targetId: projectId,
            metadata,
            ip: clientIp(c),
          }),
        ]);
      }
    } catch (err) {
      if (isUniqueViolation(err, "project_access_grants")) {
        throw conflict("This principal was granted access concurrently; retry");
      }
      throw err;
    }
    if (existing && existing.role !== role) {
      await revalidateProjects(c.env, [projectId], {
        userIds: await grantSubjects(db, existing),
      });
    }
    const [grant] = await grantsWithNames(db, eq(projectAccessGrants.id, id));
    return c.json(grant!, 200);
  })
  .openapi(deleteProjectGrant, async (c) => {
    const { projectId, grantId } = c.req.valid("param");
    const { project, caller } = await projectScope(c, projectId, actionOf(deleteProjectGrant));
    const db = c.get("db");
    const [grant] = await db
      .select()
      .from(projectAccessGrants)
      .where(and(eq(projectAccessGrants.id, grantId), eq(projectAccessGrants.projectId, projectId)))
      .limit(1);
    if (!grant) throw notFound("Grant");
    const subjects = await grantSubjects(db, grant);
    await db.batch([
      db.delete(projectAccessGrants).where(eq(projectAccessGrants.id, grantId)),
      auditInsert(db, {
        workspaceId: project.workspaceId,
        ...caller.actor,
        action: "access.revoked",
        targetType: "project",
        targetId: projectId,
        metadata: {
          grant_id: grantId,
          principal_type: grant.principalType,
          principal_id: grant.userId ?? grant.teamId,
          role: grant.role,
        },
        ip: clientIp(c),
      }),
    ]);
    if (subjects.length) await revalidateProjects(c.env, [projectId], { userIds: subjects });
    return c.body(null, 204);
  })
  .openapi(getEnvironmentProtection, async (c) => {
    const { environmentId } = c.req.valid("param");
    const { env } = await environmentScope(c, environmentId, actionOf(getEnvironmentProtection));
    return c.json(toApiProtection(env), 200);
  })
  .openapi(putEnvironmentProtection, async (c) => {
    const { environmentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { env, project, caller } = await environmentScope(
      c,
      environmentId,
      actionOf(putEnvironmentProtection),
    );
    const db = c.get("db");
    const given = PROTECTED_OPERATIONS.filter((op) => body.rules?.[op] !== undefined);
    const userIds = given.flatMap((op) => body.rules![op]!.user_ids);
    const teamIds = given.flatMap((op) => body.rules![op]!.team_ids);
    await requireMembers(db, project.workspaceId, userIds, "rules.user_ids");
    await requireTeams(db, project.workspaceId, teamIds, "rules.team_ids");
    let rules = env.protectionRules;
    if (given.length) {
      const base = rules ?? DEFAULT_PROTECTION_RULES;
      rules = Object.fromEntries(
        PROTECTED_OPERATIONS.map((op) => [
          op,
          body.rules?.[op] ? fromApiRule(body.rules[op]) : base[op],
        ]),
      ) as ProtectionRules;
    }
    const [updated] = await db.batch([
      db
        .update(environments)
        .set({
          protected: body.protected,
          protectionRules: rules,
          ...(body.require_approval !== undefined
            ? { requireApproval: body.require_approval }
            : {}),
        })
        .where(eq(environments.id, environmentId))
        .returning(),
      auditInsert(db, {
        workspaceId: project.workspaceId,
        ...caller.actor,
        action: "environment.protection_updated",
        targetType: "environment",
        targetId: environmentId,
        metadata: {
          project_id: project.id,
          from: { protected: env.protected, require_approval: env.requireApproval },
          to: {
            protected: body.protected,
            require_approval: body.require_approval ?? env.requireApproval,
          },
          rules_changed: given,
        },
        ip: clientIp(c),
      }),
    ]);
    return c.json(toApiProtection(updated[0]!), 200);
  });
