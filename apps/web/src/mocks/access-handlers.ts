/**
 * MSW handlers for the ADR 0014 access-control routes (`ACCESS_ROUTES`,
 * `apps/api/src/routes/access.ts`): workspace access settings, the caller's effective
 * access, teams, project grants and environment protection, against `db.access`.
 *
 * Access is resolved with the shared `resolveAccess`, as the API does (see
 * `./access-resolve`, which the deploy and variables mocks also use to enforce
 * environment protection). Requests are validated with the routes' own zod schemas, then answered in
 * the API's order: 401, 403 `reauth_required` for a stale session on fresh-session
 * routes, 404 (also for projects the caller has no role on), 403, then 400 and 409.
 *
 * @module
 */
import {
  ACTIONS,
  type AccessResolver,
  type Action,
  ENVIRONMENT_ACTIONS,
  INSTANCE_ACTIONS,
  PROJECT_ACTIONS,
  PROTECTED_OPERATIONS,
  type ProtectionRule,
  type ProtectionRules,
  slugify,
  WORKSPACE_ACTIONS,
} from "@roundhouse/shared";
import { HttpResponse, http } from "msw";
import { ACCESS_ROUTES, policyOf } from "../../../api/src/contracts";
import type { DbAccessSettings, DbGrant, DbTeam } from "./access-db";
import { accessFor, liveProjectsOf, protectionsOf, rulesOf, settingsOf } from "./access-resolve";
import {
  apiError,
  currentUser,
  notFound,
  recordAudit,
  requireFreshSession,
  requireWorkspace,
  unauthorized,
} from "./common";
import { type DbUser, db, nextId } from "./db";
import { validateRoute } from "./deploy-handlers";

type RouteName = keyof typeof ACCESS_ROUTES;
type ApiRule = { roles: ProtectionRule["roles"]; user_ids: string[]; team_ids: string[] };

/** Path of an access route in MSW syntax, matching any origin. */
function mswPath(name: RouteName): string {
  return `*${ACCESS_ROUTES[name].path.replace(/\{([^}]+)\}/g, ":$1")}`;
}

/** 401 without a session, then 403 `reauth_required` when the route needs a fresh one. */
function gate(name: RouteName): { user: DbUser } | { response: Response } {
  const user = currentUser();
  if (!user) return { response: unauthorized() };
  const stale = policyOf(ACCESS_ROUTES[name]).reauth ? requireFreshSession() : null;
  return stale ? { response: stale } : { user };
}

/** Checks a project action the way the API's `projectScope` does. */
function requireProject(
  user: DbUser,
  projectId: string,
  action: Action,
  what = "Project",
): { ok: true; workspaceId: string; access: AccessResolver } | { ok: false; response: Response } {
  const project = db.deploy.projects.find((row) => row.id === projectId && !row.deleted);
  if (!project) return { ok: false, response: notFound(what) };
  const access = accessFor(project.workspace_id, user);
  const decision = access.check(action, { projectId });
  if (decision.allowed) return { ok: true, workspaceId: project.workspace_id, access };
  if (decision.reason === "not_a_member" || decision.reason === "no_project_access") {
    return { ok: false, response: notFound(what) };
  }
  return {
    ok: false,
    response: apiError(
      403,
      "forbidden",
      decision.projectRole
        ? `Your project role (${decision.projectRole}) cannot perform ${action}`
        : `Your role cannot perform ${action}`,
    ),
  };
}

// -----------------------------------------------------------------------------
// Shapes
// -----------------------------------------------------------------------------

function memberCount(teamId: string) {
  return db.access.teamMembers.filter((row) => row.team_id === teamId).length;
}

function toTeam(team: DbTeam) {
  return { ...team, member_count: memberCount(team.id) };
}

function toTeamDetail(team: DbTeam) {
  const members = db.access.teamMembers
    .filter((row) => row.team_id === team.id)
    .flatMap((row) => {
      const user = db.users.find((candidate) => candidate.id === row.user_id);
      const membership = db.memberships.find(
        (candidate) =>
          candidate.workspace_id === team.workspace_id && candidate.user_id === row.user_id,
      );
      if (!user || !membership) return [];
      return [
        {
          user_id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          workspace_role: membership.role,
          added_at: row.added_at,
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { ...toTeam(team), member_count: members.length, members };
}

function toGrant(row: DbGrant) {
  const name =
    row.principal_type === "user"
      ? db.users.find((user) => user.id === row.user_id)?.name
      : db.access.teams.find((team) => team.id === row.team_id)?.name;
  return {
    id: row.id,
    project_id: row.project_id,
    principal:
      row.principal_type === "user"
        ? { type: "user" as const, id: row.user_id ?? "" }
        : { type: "team" as const, id: row.team_id ?? "" },
    principal_name: name ?? "",
    role: row.role,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const toApiRule = (rule: ProtectionRule): ApiRule => ({
  roles: rule.roles,
  user_ids: rule.userIds,
  team_ids: rule.teamIds,
});

function toProtection(environmentId: string) {
  const environment = db.deploy.environments.find((row) => row.id === environmentId);
  const rules = rulesOf(environmentId);
  return {
    environment_id: environmentId,
    protected: environment?.protected ?? false,
    rules: {
      deploy: toApiRule(rules.deploy),
      config: toApiRule(rules.config),
      variables: toApiRule(rules.variables),
    },
    require_approval: db.changes.requireApproval[environmentId] === true,
  };
}

/** 400 listing each user id that isn't a member of the workspace. */
function missingMembers(workspaceId: string, userIds: readonly string[], field: string) {
  const missing = [...new Set(userIds)].filter(
    (id) => !db.memberships.some((row) => row.workspace_id === workspaceId && row.user_id === id),
  );
  if (!missing.length) return null;
  return apiError(
    400,
    "invalid_request",
    "Every user must be a member of the workspace",
    missing.map((id) => ({
      field,
      code: "not_a_member",
      message: `${id} is not a member of this workspace`,
    })),
  );
}

/** 400 listing each team id that isn't a team of the workspace. */
function missingTeams(workspaceId: string, teamIds: readonly string[], field: string) {
  const missing = [...new Set(teamIds)].filter(
    (id) => !db.access.teams.some((row) => row.workspace_id === workspaceId && row.id === id),
  );
  if (!missing.length) return null;
  return apiError(
    400,
    "invalid_request",
    "Every team must belong to the workspace",
    missing.map((id) => ({
      field,
      code: "unknown_team",
      message: `${id} is not a team of this workspace`,
    })),
  );
}

/** Loads a team and checks `action` in its workspace; non-members get 404. */
function requireTeam(teamId: string, action: Action) {
  const team = db.access.teams.find((row) => row.id === teamId);
  if (!team) return { ok: false as const, response: notFound("Team") };
  const guard = requireWorkspace(team.workspace_id, action);
  if (!guard.ok) {
    return {
      ok: false as const,
      response: guard.response.status === 404 ? notFound("Team") : guard.response,
    };
  }
  return { ok: true as const, team, guard };
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

/** Access-control route handlers. */
export const accessHandlers = [
  http.get(mswPath("getWorkspaceAccessSettings"), async ({ request, params }) => {
    const input = await validateRoute(ACCESS_ROUTES.getWorkspaceAccessSettings, request, params);
    if (!input.ok) return input.response;
    const workspaceId = input.params.workspaceId ?? "";
    const guard = requireWorkspace(workspaceId, "members:read");
    if (!guard.ok) return guard.response;
    return HttpResponse.json(settingsOf(workspaceId));
  }),

  http.patch(mswPath("updateWorkspaceAccessSettings"), async ({ request, params }) => {
    const input = await validateRoute(ACCESS_ROUTES.updateWorkspaceAccessSettings, request, params);
    if (!input.ok) return input.response;
    const passed = gate("updateWorkspaceAccessSettings");
    if ("response" in passed) return passed.response;
    const workspaceId = input.params.workspaceId ?? "";
    const guard = requireWorkspace(workspaceId, "members:manage");
    if (!guard.ok) return guard.response;
    const before = settingsOf(workspaceId);
    const after = { ...before, ...(input.body as Partial<DbAccessSettings>) };
    db.access.settings[workspaceId] = after;
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: passed.user.id,
      action: "workspace.access_settings_updated",
      targetType: "workspace",
      targetId: workspaceId,
      metadata: { from: before, to: after },
    });
    return HttpResponse.json(after);
  }),

  http.get(mswPath("getEffectiveAccess"), async ({ request, params }) => {
    const input = await validateRoute(ACCESS_ROUTES.getEffectiveAccess, request, params);
    if (!input.ok) return input.response;
    const workspaceId = input.params.workspaceId ?? "";
    const guard = requireWorkspace(workspaceId, "workspace:read");
    if (!guard.ok) return guard.response;
    const access = accessFor(workspaceId, guard.user);
    const held = new Set<Action>(
      [...WORKSPACE_ACTIONS, ...INSTANCE_ACTIONS].filter((action) => access.can(action)),
    );
    const protections = protectionsOf(workspaceId);
    const projects = liveProjectsOf(workspaceId).flatMap((project) => {
      const role = access.projectRole(project.id);
      if (role === null || !access.can("projects:read", { projectId: project.id })) return [];
      return [
        {
          project_id: project.id,
          role,
          actions: PROJECT_ACTIONS.filter((action) =>
            access.can(action, { projectId: project.id }),
          ),
          environments: protections
            .filter((row) => row.projectId === project.id)
            .map((row) => ({
              environment_id: row.environmentId,
              protected: row.protected,
              denied: ENVIRONMENT_ACTIONS.flatMap((action) => {
                const decision = access.check(action, { environmentId: row.environmentId });
                return decision.allowed || decision.reason === null
                  ? []
                  : [{ action, reason: decision.reason }];
              }),
            })),
        },
      ];
    });
    return HttpResponse.json({
      workspace_role: guard.membership.role,
      instance_admin: guard.user.instance_admin ?? false,
      actions: ACTIONS.filter((action) => held.has(action)),
      projects,
    });
  }),

  http.get(mswPath("listTeams"), async ({ request, params }) => {
    const input = await validateRoute(ACCESS_ROUTES.listTeams, request, params);
    if (!input.ok) return input.response;
    const workspaceId = input.params.workspaceId ?? "";
    const guard = requireWorkspace(workspaceId, "members:read");
    if (!guard.ok) return guard.response;
    const teams = db.access.teams
      .filter((row) => row.workspace_id === workspaceId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(toTeam);
    return HttpResponse.json({ teams });
  }),

  http.post(mswPath("createTeam"), async ({ request, params }) => {
    const input = await validateRoute(ACCESS_ROUTES.createTeam, request, params);
    if (!input.ok) return input.response;
    const passed = gate("createTeam");
    if ("response" in passed) return passed.response;
    const workspaceId = input.params.workspaceId ?? "";
    const guard = requireWorkspace(workspaceId, "members:manage");
    if (!guard.ok) return guard.response;
    const body = input.body as {
      name: string;
      slug?: string;
      description?: string;
      user_ids: string[];
    };
    const notMembers = missingMembers(workspaceId, body.user_ids, "user_ids");
    if (notMembers) return notMembers;
    const slug = body.slug ?? slugify(body.name, 40, "team");
    if (db.access.teams.some((row) => row.workspace_id === workspaceId && row.slug === slug)) {
      return apiError(409, "conflict", `A team with the slug "${slug}" already exists`);
    }
    const now = Date.now();
    const team: DbTeam = {
      id: nextId("team"),
      workspace_id: workspaceId,
      name: body.name,
      slug,
      description: body.description || null,
      created_at: now,
      updated_at: now,
    };
    const userIds = [...new Set(body.user_ids)];
    db.access.teams.push(team);
    for (const userId of userIds) {
      db.access.teamMembers.push({ team_id: team.id, user_id: userId, added_at: now });
    }
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: passed.user.id,
      action: "team.created",
      targetType: "team",
      targetId: team.id,
      metadata: { name: team.name, slug: team.slug, user_ids: userIds },
    });
    return HttpResponse.json(toTeamDetail(team), { status: 201 });
  }),

  http.get(mswPath("getTeam"), async ({ request, params }) => {
    const input = await validateRoute(ACCESS_ROUTES.getTeam, request, params);
    if (!input.ok) return input.response;
    if (!currentUser()) return unauthorized();
    const found = requireTeam(input.params.teamId ?? "", "members:read");
    if (!found.ok) return found.response;
    return HttpResponse.json(toTeamDetail(found.team));
  }),

  http.patch(mswPath("updateTeam"), async ({ request, params }) => {
    const input = await validateRoute(ACCESS_ROUTES.updateTeam, request, params);
    if (!input.ok) return input.response;
    if (!currentUser()) return unauthorized();
    const found = requireTeam(input.params.teamId ?? "", "members:manage");
    if (!found.ok) return found.response;
    const { team } = found;
    const body = input.body as { name?: string; slug?: string; description?: string | null };
    if (
      body.slug !== undefined &&
      db.access.teams.some(
        (row) => row.workspace_id === team.workspace_id && row.slug === body.slug && row !== team,
      )
    ) {
      return apiError(409, "conflict", `A team with the slug "${body.slug}" already exists`);
    }
    const set = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.slug !== undefined ? { slug: body.slug } : {}),
      ...(body.description !== undefined ? { description: body.description || null } : {}),
    };
    Object.assign(team, set, { updated_at: Date.now() });
    recordAudit({
      workspaceId: team.workspace_id,
      actorType: "user",
      actorId: found.guard.user.id,
      action: "team.updated",
      targetType: "team",
      targetId: team.id,
      metadata: set,
    });
    return HttpResponse.json(toTeam(team));
  }),

  http.delete(mswPath("deleteTeam"), async ({ request, params }) => {
    const input = await validateRoute(ACCESS_ROUTES.deleteTeam, request, params);
    if (!input.ok) return input.response;
    const passed = gate("deleteTeam");
    if ("response" in passed) return passed.response;
    const found = requireTeam(input.params.teamId ?? "", "members:manage");
    if (!found.ok) return found.response;
    const { team } = found;
    const members = db.access.teamMembers
      .filter((row) => row.team_id === team.id)
      .map((row) => row.user_id);
    db.access.teams = db.access.teams.filter((row) => row !== team);
    db.access.teamMembers = db.access.teamMembers.filter((row) => row.team_id !== team.id);
    db.access.grants = db.access.grants.filter((row) => row.team_id !== team.id);
    for (const [environmentId, rules] of Object.entries(db.access.rules)) {
      db.access.rules[environmentId] = Object.fromEntries(
        PROTECTED_OPERATIONS.map((op) => [
          op,
          { ...rules[op], teamIds: rules[op].teamIds.filter((id) => id !== team.id) },
        ]),
      ) as ProtectionRules;
    }
    recordAudit({
      workspaceId: team.workspace_id,
      actorType: "user",
      actorId: passed.user.id,
      action: "team.deleted",
      targetType: "team",
      targetId: team.id,
      metadata: { name: team.name, slug: team.slug, user_ids: members },
    });
    return new HttpResponse(null, { status: 204 });
  }),

  http.put(mswPath("putTeamMembers"), async ({ request, params }) => {
    const input = await validateRoute(ACCESS_ROUTES.putTeamMembers, request, params);
    if (!input.ok) return input.response;
    const passed = gate("putTeamMembers");
    if ("response" in passed) return passed.response;
    const found = requireTeam(input.params.teamId ?? "", "members:manage");
    if (!found.ok) return found.response;
    const { team } = found;
    const wanted = [...new Set((input.body as { user_ids: string[] }).user_ids)];
    const notMembers = missingMembers(team.workspace_id, wanted, "user_ids");
    if (notMembers) return notMembers;
    const current = db.access.teamMembers
      .filter((row) => row.team_id === team.id)
      .map((row) => row.user_id);
    const added = wanted.filter((id) => !current.includes(id));
    const removed = current.filter((id) => !wanted.includes(id));
    const now = Date.now();
    db.access.teamMembers = db.access.teamMembers.filter(
      (row) => !(row.team_id === team.id && removed.includes(row.user_id)),
    );
    for (const userId of added) {
      db.access.teamMembers.push({ team_id: team.id, user_id: userId, added_at: now });
    }
    for (const [action, userIds] of [
      ["team.member_added", added],
      ["team.member_removed", removed],
    ] as const) {
      if (!userIds.length) continue;
      recordAudit({
        workspaceId: team.workspace_id,
        actorType: "user",
        actorId: passed.user.id,
        action,
        targetType: "team",
        targetId: team.id,
        metadata: { user_ids: userIds },
      });
    }
    return HttpResponse.json(toTeamDetail(team));
  }),

  http.get(mswPath("getProjectAccess"), async ({ request, params }) => {
    const input = await validateRoute(ACCESS_ROUTES.getProjectAccess, request, params);
    if (!input.ok) return input.response;
    const user = currentUser();
    if (!user) return unauthorized();
    const projectId = input.params.projectId ?? "";
    const found = requireProject(user, projectId, "access:manage");
    if (!found.ok) return found.response;
    const settings = settingsOf(found.workspaceId);
    return HttpResponse.json({
      grants: db.access.grants
        .filter((row) => row.project_id === projectId)
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map(toGrant),
      implied: {
        member: settings.member_default_project_role,
        viewer: settings.viewer_default_project_role,
      },
    });
  }),

  http.put(mswPath("putProjectGrant"), async ({ request, params }) => {
    const input = await validateRoute(ACCESS_ROUTES.putProjectGrant, request, params);
    if (!input.ok) return input.response;
    const passed = gate("putProjectGrant");
    if ("response" in passed) return passed.response;
    const projectId = input.params.projectId ?? "";
    const found = requireProject(passed.user, projectId, "access:manage");
    if (!found.ok) return found.response;
    const { principal, role } = input.body as {
      principal: { type: "user" | "team"; id: string };
      role: DbGrant["role"];
    };
    const missing =
      principal.type === "user"
        ? missingMembers(found.workspaceId, [principal.id], "principal.id")
        : missingTeams(found.workspaceId, [principal.id], "principal.id");
    if (missing) return missing;
    const existing = db.access.grants.find(
      (row) =>
        row.project_id === projectId &&
        row.principal_type === principal.type &&
        (principal.type === "user" ? row.user_id : row.team_id) === principal.id,
    );
    const metadata = { principal_type: principal.type, principal_id: principal.id, role };
    const now = Date.now();
    let grant: DbGrant;
    if (existing) {
      const from = existing.role;
      existing.role = role;
      existing.updated_at = now;
      grant = existing;
      recordAudit({
        workspaceId: found.workspaceId,
        actorType: "user",
        actorId: passed.user.id,
        action: "access.changed",
        targetType: "project",
        targetId: projectId,
        metadata: { ...metadata, from },
      });
    } else {
      grant = {
        id: nextId("pag"),
        project_id: projectId,
        principal_type: principal.type,
        user_id: principal.type === "user" ? principal.id : null,
        team_id: principal.type === "team" ? principal.id : null,
        role,
        created_by: passed.user.id,
        created_at: now,
        updated_at: now,
      };
      db.access.grants.push(grant);
      recordAudit({
        workspaceId: found.workspaceId,
        actorType: "user",
        actorId: passed.user.id,
        action: "access.granted",
        targetType: "project",
        targetId: projectId,
        metadata,
      });
    }
    return HttpResponse.json(toGrant(grant));
  }),

  http.delete(mswPath("deleteProjectGrant"), async ({ request, params }) => {
    const input = await validateRoute(ACCESS_ROUTES.deleteProjectGrant, request, params);
    if (!input.ok) return input.response;
    const passed = gate("deleteProjectGrant");
    if ("response" in passed) return passed.response;
    const projectId = input.params.projectId ?? "";
    const found = requireProject(passed.user, projectId, "access:manage");
    if (!found.ok) return found.response;
    const grant = db.access.grants.find(
      (row) => row.id === input.params.grantId && row.project_id === projectId,
    );
    if (!grant) return notFound("Grant");
    db.access.grants = db.access.grants.filter((row) => row !== grant);
    recordAudit({
      workspaceId: found.workspaceId,
      actorType: "user",
      actorId: passed.user.id,
      action: "access.revoked",
      targetType: "project",
      targetId: projectId,
      metadata: {
        grant_id: grant.id,
        principal_type: grant.principal_type,
        principal_id: grant.user_id ?? grant.team_id,
        role: grant.role,
      },
    });
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(mswPath("getEnvironmentProtection"), async ({ request, params }) => {
    const input = await validateRoute(ACCESS_ROUTES.getEnvironmentProtection, request, params);
    if (!input.ok) return input.response;
    const user = currentUser();
    if (!user) return unauthorized();
    const environment = db.deploy.environments.find((row) => row.id === input.params.environmentId);
    if (!environment) return notFound("Environment");
    const found = requireProject(user, environment.project_id, "projects:read", "Environment");
    if (!found.ok) return found.response;
    return HttpResponse.json(toProtection(environment.id));
  }),

  http.put(mswPath("putEnvironmentProtection"), async ({ request, params }) => {
    const input = await validateRoute(ACCESS_ROUTES.putEnvironmentProtection, request, params);
    if (!input.ok) return input.response;
    const passed = gate("putEnvironmentProtection");
    if ("response" in passed) return passed.response;
    const environment = db.deploy.environments.find((row) => row.id === input.params.environmentId);
    if (!environment) return notFound("Environment");
    const found = requireProject(
      passed.user,
      environment.project_id,
      "access:manage",
      "Environment",
    );
    if (!found.ok) return found.response;
    const body = input.body as {
      protected: boolean;
      require_approval?: boolean;
      rules?: Partial<Record<(typeof PROTECTED_OPERATIONS)[number], ApiRule>>;
    };
    const given = PROTECTED_OPERATIONS.filter((op) => body.rules?.[op] !== undefined);
    const userIds = given.flatMap((op) => body.rules?.[op]?.user_ids ?? []);
    const teamIds = given.flatMap((op) => body.rules?.[op]?.team_ids ?? []);
    const missing =
      missingMembers(found.workspaceId, userIds, "rules.user_ids") ??
      missingTeams(found.workspaceId, teamIds, "rules.team_ids");
    if (missing) return missing;
    if (given.length) {
      const base = rulesOf(environment.id);
      db.access.rules[environment.id] = Object.fromEntries(
        PROTECTED_OPERATIONS.map((op) => {
          const rule = body.rules?.[op];
          return [
            op,
            rule
              ? {
                  roles: [...new Set(rule.roles)],
                  userIds: [...new Set(rule.user_ids)],
                  teamIds: [...new Set(rule.team_ids)],
                }
              : base[op],
          ];
        }),
      ) as ProtectionRules;
    }
    const from = environment.protected;
    const approvalBefore = db.changes.requireApproval[environment.id] === true;
    environment.protected = body.protected;
    if (body.require_approval !== undefined) {
      db.changes.requireApproval[environment.id] = body.require_approval;
    }
    recordAudit({
      workspaceId: found.workspaceId,
      actorType: "user",
      actorId: passed.user.id,
      action: "environment.protection_updated",
      targetType: "environment",
      targetId: environment.id,
      metadata: {
        project_id: environment.project_id,
        from: { protected: from, require_approval: approvalBefore },
        to: {
          protected: body.protected,
          require_approval: body.require_approval ?? approvalBefore,
        },
        rules_changed: given,
      },
    });
    return HttpResponse.json(toProtection(environment.id));
  }),
];
