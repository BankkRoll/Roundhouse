/**
 * Access control shared by the API (which enforces it) and the dashboard
 * (which hides what the caller can't do). See ADR 0014.
 *
 * Three layers, resolved by {@link resolveAccess}:
 * - **Instance**: the `users.instance_admin` flag grants {@link INSTANCE_ACTIONS}
 *   and nothing inside workspaces.
 * - **Workspace**: a member's {@link Role} grants {@link WORKSPACE_ACTIONS}.
 * - **Project**: a {@link ProjectRole}, the highest of the role implied by the
 *   workspace role and every grant to the user or one of their teams, grants
 *   {@link PROJECT_ACTIONS}. {@link ENVIRONMENT_ACTIONS} are further narrowed by
 *   the target environment's protection rules.
 *
 * @module
 */

// -----------------------------------------------------------------------------
// Roles
// -----------------------------------------------------------------------------

/** Workspace roles, ordered from most to least privileged. */
export const ROLES = ["owner", "admin", "member", "viewer"] as const;

/** A workspace role. */
export type Role = (typeof ROLES)[number];

/** Project roles, ordered from most to least privileged. */
export const PROJECT_ROLES = ["project_admin", "developer", "deployer", "viewer"] as const;

/** A role on one project, from a grant or implied by the workspace role. */
export type ProjectRole = (typeof PROJECT_ROLES)[number];

/** Choices for the project role every workspace `member` gets on every project. */
export const MEMBER_DEFAULT_PROJECT_ROLES = ["none", "viewer", "deployer", "developer"] as const;

/** Project role implied for workspace members; `none` means grants only. */
export type MemberDefaultProjectRole = (typeof MEMBER_DEFAULT_PROJECT_ROLES)[number];

/** Choices for the project role every workspace `viewer` gets on every project. */
export const VIEWER_DEFAULT_PROJECT_ROLES = ["none", "viewer"] as const;

/** Project role implied for workspace viewers; `none` means grants only. */
export type ViewerDefaultProjectRole = (typeof VIEWER_DEFAULT_PROJECT_ROLES)[number];

/** Workspace-level settings that feed access resolution. */
export interface WorkspaceAccessSettings {
  /** Defaults to `developer`, which is what members could do before project grants existed. */
  memberDefaultProjectRole: MemberDefaultProjectRole;
  /** Defaults to `viewer`. */
  viewerDefaultProjectRole: ViewerDefaultProjectRole;
}

/** Settings a workspace starts with, and that the migration backfills. */
export const DEFAULT_WORKSPACE_ACCESS_SETTINGS: WorkspaceAccessSettings = {
  memberDefaultProjectRole: "developer",
  viewerDefaultProjectRole: "viewer",
};

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

/**
 * Actions on the install as a whole, granted only by `users.instance_admin`.
 * - `instance:manage`: instance settings, the GitHub App, key rotation, and
 *   the instance-level audit log.
 * - `workspaces:create`: create a workspace (and become its owner).
 */
export const INSTANCE_ACTIONS = ["instance:manage", "workspaces:create"] as const;

/** An install-wide action; see {@link INSTANCE_ACTIONS}. */
export type InstanceAction = (typeof INSTANCE_ACTIONS)[number];

/**
 * Actions on a workspace, granted by the workspace role alone.
 * - `members:manage` covers invites, roles, removal and teams.
 * - `tokens:manage` covers the workspace's API tokens.
 * - `projects:create` creates a project; the creator's power over it then
 *   comes from their project role (owners and admins are `project_admin`).
 * - `github:manage` claims and releases GitHub App installations.
 */
export const WORKSPACE_ACTIONS = [
  "workspace:read",
  "workspace:update",
  "workspace:delete",
  "members:read",
  "members:manage",
  "tokens:manage",
  "nodes:read",
  "nodes:manage",
  "audit:read",
  "projects:create",
  "github:manage",
] as const;

/** A workspace-level action; see {@link WORKSPACE_ACTIONS}. */
export type WorkspaceAction = (typeof WORKSPACE_ACTIONS)[number];

/**
 * Actions on one project, granted by the caller's {@link ProjectRole} there.
 * - `variables:read`: keys, tiers, fingerprints and metadata; never values.
 * - `variables:read_plain`: plain values. Secret values are never readable.
 * - `access:manage`: project grants and environment protection.
 * - `data:read`: browse a database service and run read-only queries.
 * - `data:write`: run writing queries as the database's admin principal.
 * - `backups:manage`: backup policies, manual backups and backup deletion.
 * - `backups:restore`: restore a backup or download its encrypted object.
 * - `changes:approve`: approve or reject a change set someone else staged
 *   (ADR 0006).
 * - `environments:manage`: tear down a pull request preview environment (ADR 0007).
 * - `previews:manage`: PR preview settings and approving a fork PR's preview
 *   (ADR 0007). Project admins only: approving runs outside code.
 * - `changes:auto_apply`: an API token may apply staged changes without a
 *   person approving them first. Sessions never need it; as a token scope it
 *   must be chosen explicitly, since no preset carries it (ADR 0012).
 *
 * Viewers get no data action: a database's rows can be as sensitive as its
 * secrets (ADR 0004).
 */
export const PROJECT_ACTIONS = [
  "projects:read",
  "projects:manage",
  "access:manage",
  "services:read",
  "services:manage",
  "deployments:create",
  "variables:read",
  "variables:read_plain",
  "variables:manage",
  "data:read",
  "data:write",
  "backups:manage",
  "backups:restore",
  "changes:approve",
  "changes:auto_apply",
  "environments:manage",
  "previews:manage",
] as const;

/** A project-level action; see {@link PROJECT_ACTIONS}. */
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

/**
 * Project actions that a protected environment narrows further, checked
 * with an `environmentId`. Each maps to one {@link ProtectedOperation}.
 */
export const ENVIRONMENT_ACTIONS = [
  "deployments:create",
  "services:manage",
  "variables:manage",
] as const satisfies readonly ProjectAction[];

/** A project action subject to environment protection. */
export type EnvironmentAction = (typeof ENVIRONMENT_ACTIONS)[number];

/** Every action gated by access control. Routes declare one of these. */
export type Action = InstanceAction | WorkspaceAction | ProjectAction;

/** Every {@link Action}, for exhaustive checks and admin UIs. */
export const ACTIONS = [
  ...WORKSPACE_ACTIONS,
  ...PROJECT_ACTIONS,
  ...INSTANCE_ACTIONS,
] as const satisfies readonly Action[];

const isIn = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

/**
 * Type guard for instance actions.
 *
 * @param action - Any action.
 * @returns `true` for {@link INSTANCE_ACTIONS}.
 */
export function isInstanceAction(action: Action): action is InstanceAction {
  return isIn(INSTANCE_ACTIONS, action);
}

/**
 * Type guard for workspace actions.
 *
 * @param action - Any action.
 * @returns `true` for {@link WORKSPACE_ACTIONS}.
 */
export function isWorkspaceAction(action: Action): action is WorkspaceAction {
  return isIn(WORKSPACE_ACTIONS, action);
}

/**
 * Type guard for project actions.
 *
 * @param action - Any action.
 * @returns `true` for {@link PROJECT_ACTIONS}.
 */
export function isProjectAction(action: Action): action is ProjectAction {
  return isIn(PROJECT_ACTIONS, action);
}

/**
 * Type guard for actions that environment protection narrows.
 *
 * @param action - Any action.
 * @returns `true` for {@link ENVIRONMENT_ACTIONS}.
 */
export function isEnvironmentAction(action: Action): action is EnvironmentAction {
  return isIn(ENVIRONMENT_ACTIONS, action);
}

// -----------------------------------------------------------------------------
// Grant tables
// -----------------------------------------------------------------------------

const WORKSPACE_GRANTS: Record<Role, ReadonlySet<WorkspaceAction>> = {
  owner: new Set(WORKSPACE_ACTIONS),
  admin: new Set(WORKSPACE_ACTIONS.filter((a) => a !== "workspace:delete")),
  member: new Set<WorkspaceAction>(["workspace:read", "members:read", "nodes:read"]),
  viewer: new Set<WorkspaceAction>(["workspace:read", "nodes:read"]),
};

const VIEW: ProjectAction[] = ["projects:read", "services:read", "variables:read"];
const DEPLOY: ProjectAction[] = [...VIEW, "deployments:create", "variables:read_plain"];
const DEVELOP: ProjectAction[] = [
  ...DEPLOY,
  "services:manage",
  "variables:manage",
  "data:read",
  "backups:manage",
  "changes:auto_apply",
  "environments:manage",
];

const PROJECT_GRANTS: Record<ProjectRole, ReadonlySet<ProjectAction>> = {
  project_admin: new Set(PROJECT_ACTIONS),
  developer: new Set(DEVELOP),
  deployer: new Set(DEPLOY),
  viewer: new Set(VIEW),
};

/**
 * Checks whether a workspace role grants a workspace action.
 *
 * @param role - The caller's role in the workspace.
 * @param action - A workspace action.
 * @returns `true` when the role grants it.
 */
export function workspaceRoleCan(role: Role, action: WorkspaceAction): boolean {
  return WORKSPACE_GRANTS[role].has(action);
}

/**
 * Checks whether a project role grants a project action, ignoring
 * environment protection.
 *
 * @param role - The caller's role on the project.
 * @param action - A project action.
 * @returns `true` when the role grants it.
 * @example
 * projectRoleCan("deployer", "services:manage"); // false
 */
export function projectRoleCan(role: ProjectRole, action: ProjectAction): boolean {
  return PROJECT_GRANTS[role].has(action);
}

/**
 * Coarse check of an action against a workspace role alone, assuming the
 * default workspace settings, no grants and no environment protection.
 * Instance actions are always `false` (they come from the instance-admin
 * flag). Kept for API token scope checks and for UI that has no project in
 * view; anything about a specific project must use {@link resolveAccess}.
 *
 * @param role - The caller's workspace role.
 * @param action - The action being attempted.
 * @returns `true` when the role grants the action under default settings.
 * @example
 * can("member", "nodes:manage"); // false
 * can("member", "services:manage"); // true: members default to developer
 */
export function can(role: Role, action: Action): boolean {
  if (isWorkspaceAction(action)) return workspaceRoleCan(role, action);
  if (isProjectAction(action)) {
    const implied = impliedProjectRole(role, DEFAULT_WORKSPACE_ACCESS_SETTINGS);
    return implied !== null && projectRoleCan(implied, action);
  }
  return false;
}

/**
 * Type guard for untrusted role strings (e.g. from the database or a request body).
 *
 * @param value - Value to check.
 * @returns `true` when `value` is a known role.
 */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && isIn(ROLES, value);
}

/**
 * Type guard for untrusted project role strings.
 *
 * @param value - Value to check.
 * @returns `true` when `value` is a known project role.
 */
export function isProjectRole(value: unknown): value is ProjectRole {
  return typeof value === "string" && isIn(PROJECT_ROLES, value);
}

/**
 * The higher of two project roles.
 *
 * @param a - A role, or `null` for no access.
 * @param b - A role, or `null` for no access.
 * @returns The more privileged role, or `null` when both are `null`.
 */
export function maxProjectRole(a: ProjectRole | null, b: ProjectRole | null): ProjectRole | null {
  if (a === null) return b;
  if (b === null) return a;
  return PROJECT_ROLES.indexOf(a) <= PROJECT_ROLES.indexOf(b) ? a : b;
}

/**
 * Project role a workspace role implies on every project of the workspace.
 *
 * @param role - Workspace role.
 * @param settings - The workspace's access settings.
 * @returns The implied role, or `null` when it implies none.
 */
export function impliedProjectRole(
  role: Role,
  settings: WorkspaceAccessSettings,
): ProjectRole | null {
  switch (role) {
    case "owner":
    case "admin":
      return "project_admin";
    case "member":
      return settings.memberDefaultProjectRole === "none"
        ? null
        : settings.memberDefaultProjectRole;
    case "viewer":
      return settings.viewerDefaultProjectRole === "none" ? null : "viewer";
  }
}

// -----------------------------------------------------------------------------
// Environment protection
// -----------------------------------------------------------------------------

/** What a protected environment restricts, one per {@link EnvironmentAction}. */
export const PROTECTED_OPERATIONS = ["deploy", "config", "variables"] as const;

/** An operation a protection rule restricts. */
export type ProtectedOperation = (typeof PROTECTED_OPERATIONS)[number];

/** The action each protected operation gates. */
export const PROTECTED_OPERATION_ACTION = {
  deploy: "deployments:create",
  config: "services:manage",
  variables: "variables:manage",
} as const satisfies Record<ProtectedOperation, EnvironmentAction>;

/**
 * Project roles a rule can list. `project_admin` always passes, so admins
 * can't lock themselves out of an environment they are able to unprotect.
 */
export const PROTECTION_RULE_ROLES = ["developer", "deployer"] as const;

/** A role a protection rule can list. */
export type ProtectionRuleRole = (typeof PROTECTION_RULE_ROLES)[number];

/**
 * Who may perform one operation in a protected environment, besides
 * `project_admin`. A caller passes when their project role is listed, they
 * are listed, or one of their teams is listed, and their project role also
 * grants the operation's action: rules only narrow, never widen.
 */
export interface ProtectionRule {
  roles: ProtectionRuleRole[];
  userIds: string[];
  teamIds: string[];
}

/** Protection rules of one environment, one per operation. */
export type ProtectionRules = Record<ProtectedOperation, ProtectionRule>;

/**
 * Rules a protected environment starts with: anyone who can deploy still
 * may, developers may change config, and only project admins may change
 * variables.
 */
export const DEFAULT_PROTECTION_RULES: ProtectionRules = {
  deploy: { roles: ["developer", "deployer"], userIds: [], teamIds: [] },
  config: { roles: ["developer"], userIds: [], teamIds: [] },
  variables: { roles: [], userIds: [], teamIds: [] },
};

/** Protection state of one environment, as access resolution reads it. */
export interface EnvironmentProtection {
  environmentId: string;
  projectId: string;
  protected: boolean;
  /** Ignored when not `protected`. */
  rules: ProtectionRules;
}

// -----------------------------------------------------------------------------
// Resolution
// -----------------------------------------------------------------------------

/** Who receives a project grant. */
export type GrantPrincipal = { type: "user"; id: string } | { type: "team"; id: string };

/** A project role given to a user or a team. */
export interface ProjectAccessGrant {
  projectId: string;
  principal: GrantPrincipal;
  role: ProjectRole;
}

/** The caller, as far as access resolution is concerned. */
export interface AccessSubject {
  userId: string;
  /** `null` when the caller is not a member of the workspace in question. */
  workspaceRole: Role | null;
  instanceAdmin: boolean;
  /** Teams of the workspace the user belongs to. */
  teamIds: readonly string[];
  /**
   * Scopes of the API token making the request; `null`/absent for a browser
   * session. A token can do only what its scopes list and its creator can do.
   */
  tokenScopes?: readonly Action[] | null;
}

/** The workspace state access resolution reads. */
export interface AccessContext {
  settings: WorkspaceAccessSettings;
  /** Grants of the workspace; ones for other projects or principals are ignored. */
  grants: readonly ProjectAccessGrant[];
  /**
   * Protection of every environment a check may name. A check naming an
   * environment missing from this list is denied, so a caller that forgets
   * to load protection fails closed.
   */
  protections: readonly EnvironmentProtection[];
}

/** What a check is about. Project actions need `projectId` or `environmentId`. */
export interface AccessScope {
  projectId?: string;
  environmentId?: string;
}

/** Why a check was denied. */
export const ACCESS_DENIALS = [
  "instance_admin_required",
  "token_scope",
  "not_a_member",
  "workspace_role",
  "scope_required",
  "unknown_environment",
  "environment_mismatch",
  "no_project_access",
  "project_role",
  "environment_protected",
] as const;

/** Why a check was denied; see {@link ACCESS_DENIALS}. */
export type AccessDenial = (typeof ACCESS_DENIALS)[number];

/** Outcome of one check. */
export interface AccessDecision {
  allowed: boolean;
  /** `null` when allowed. */
  reason: AccessDenial | null;
  /** The caller's role on the project in scope, when there is one. */
  projectRole: ProjectRole | null;
}

/** Answers access questions for one caller in one workspace. */
export interface AccessResolver {
  /**
   * Checks an action, explaining a denial.
   *
   * @param action - The action being attempted.
   * @param scope - Project and/or environment it targets.
   * @returns The decision.
   */
  check(action: Action, scope?: AccessScope): AccessDecision;
  /**
   * Checks an action.
   *
   * @param action - The action being attempted.
   * @param scope - Project and/or environment it targets.
   * @returns `true` when allowed.
   */
  can(action: Action, scope?: AccessScope): boolean;
  /**
   * The caller's effective role on a project.
   *
   * @param projectId - The project.
   * @returns The highest role from the workspace role and every grant, or `null`.
   */
  projectRole(projectId: string): ProjectRole | null;
}

const allow = (projectRole: ProjectRole | null = null): AccessDecision => ({
  allowed: true,
  reason: null,
  projectRole,
});

const deny = (reason: AccessDenial, projectRole: ProjectRole | null = null): AccessDecision => ({
  allowed: false,
  reason,
  projectRole,
});

/**
 * Builds the access resolver for one caller in one workspace.
 *
 * Order of checks: instance actions need the instance-admin flag; then an
 * API token must carry the action as a scope; then workspace actions need
 * membership and a workspace role that grants them; project actions need a
 * project role (the highest of the implied role, direct grants and team
 * grants) that grants them; environment actions in a protected environment
 * must also pass its rule. Each step's denial reason is reported.
 *
 * @param subject - The caller.
 * @param context - Settings, grants and protection of the workspace.
 * @returns A resolver; build one per request.
 * @example
 * const access = resolveAccess(
 *   { userId: "usr_1", workspaceRole: "member", instanceAdmin: false, teamIds: [] },
 *   { settings: DEFAULT_WORKSPACE_ACCESS_SETTINGS, grants: [], protections: [] },
 * );
 * access.can("services:manage", { projectId: "prj_1" }); // true
 */
export function resolveAccess(subject: AccessSubject, context: AccessContext): AccessResolver {
  const teams = new Set(subject.teamIds);
  const roleCache = new Map<string, ProjectRole | null>();

  const projectRole = (projectId: string): ProjectRole | null => {
    if (subject.workspaceRole === null) return null;
    const cached = roleCache.get(projectId);
    if (cached !== undefined) return cached;
    let role = impliedProjectRole(subject.workspaceRole, context.settings);
    for (const g of context.grants) {
      if (g.projectId !== projectId) continue;
      const mine =
        g.principal.type === "user" ? g.principal.id === subject.userId : teams.has(g.principal.id);
      if (mine) role = maxProjectRole(role, g.role);
    }
    roleCache.set(projectId, role);
    return role;
  };

  const passesRule = (rule: ProtectionRule, role: ProjectRole): boolean =>
    role === "project_admin" ||
    (rule.roles as readonly string[]).includes(role) ||
    rule.userIds.includes(subject.userId) ||
    rule.teamIds.some((t) => teams.has(t));

  const check = (action: Action, scope: AccessScope = {}): AccessDecision => {
    if (isInstanceAction(action)) {
      if (subject.tokenScopes) return deny("token_scope");
      return subject.instanceAdmin ? allow() : deny("instance_admin_required");
    }
    if (subject.tokenScopes && !subject.tokenScopes.includes(action)) return deny("token_scope");
    if (subject.workspaceRole === null) return deny("not_a_member");
    if (isWorkspaceAction(action)) {
      return workspaceRoleCan(subject.workspaceRole, action) ? allow() : deny("workspace_role");
    }

    let protection: EnvironmentProtection | undefined;
    if (scope.environmentId !== undefined) {
      protection = context.protections.find((p) => p.environmentId === scope.environmentId);
      if (!protection) return deny("unknown_environment");
      if (scope.projectId !== undefined && scope.projectId !== protection.projectId) {
        return deny("environment_mismatch");
      }
    }
    const projectId = scope.projectId ?? protection?.projectId;
    if (projectId === undefined) return deny("scope_required");

    const role = projectRole(projectId);
    if (role === null) return deny("no_project_access");
    if (!projectRoleCan(role, action)) return deny("project_role", role);

    if (protection?.protected && isEnvironmentAction(action)) {
      const op = PROTECTED_OPERATIONS.find((o) => PROTECTED_OPERATION_ACTION[o] === action)!;
      if (!passesRule(protection.rules[op], role)) return deny("environment_protected", role);
    }
    return allow(role);
  };

  return {
    check,
    can: (action, scope) => check(action, scope).allowed,
    projectRole,
  };
}

// -----------------------------------------------------------------------------
// Second factor
// -----------------------------------------------------------------------------

/** Workspace roles that must enroll a second factor before mutating anything. */
export const TWO_FACTOR_REQUIRED_ROLES = ["owner", "admin"] as const satisfies readonly Role[];

/**
 * Whether a user must have two-factor authentication enrolled.
 *
 * @param instanceAdmin - The user's instance-admin flag.
 * @param roles - The user's roles across every live workspace.
 * @returns `true` for instance admins and any owner or admin.
 */
export function isTwoFactorRequired(instanceAdmin: boolean, roles: readonly Role[]): boolean {
  return (
    instanceAdmin || roles.some((r) => (TWO_FACTOR_REQUIRED_ROLES as readonly Role[]).includes(r))
  );
}
