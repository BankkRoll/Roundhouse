/** Workspace roles, ordered from most to least privileged. */
export const ROLES = ["owner", "admin", "member", "viewer"] as const;

/** A workspace role. */
export type Role = (typeof ROLES)[number];

/**
 * Every action gated by RBAC. Routes declare one of these; the middleware
 * resolves the caller's role and checks it against {@link ROLE_GRANTS}.
 *
 * `instance:manage` covers install-wide settings. Instances have no roles of
 * their own, so it is granted to whoever is `owner` of any workspace.
 *
 * `tokens:manage` covers the workspace API tokens: creating, listing and
 * revoking them.
 */
export type Action =
  | "workspace:read"
  | "workspace:update"
  | "workspace:delete"
  | "members:read"
  | "members:manage"
  | "tokens:manage"
  | "nodes:read"
  | "nodes:manage"
  | "audit:read"
  | "projects:read"
  | "projects:manage"
  | "services:read"
  | "services:manage"
  | "deployments:create"
  | "variables:read"
  | "variables:reveal"
  | "variables:manage"
  | "instance:manage";

/** Every {@link Action}, for exhaustive checks and admin UIs. */
export const ACTIONS = [
  "workspace:read",
  "workspace:update",
  "workspace:delete",
  "members:read",
  "members:manage",
  "tokens:manage",
  "nodes:read",
  "nodes:manage",
  "audit:read",
  "projects:read",
  "projects:manage",
  "services:read",
  "services:manage",
  "deployments:create",
  "variables:read",
  "variables:reveal",
  "variables:manage",
  "instance:manage",
] as const satisfies readonly Action[];

/** Read access to project resources; secrets stay masked. */
const READ_PROJECTS: Action[] = ["projects:read", "services:read", "variables:read"];

/** Day-to-day work on services: change them, deploy, set variables. */
const BUILD_PROJECTS: Action[] = [
  ...READ_PROJECTS,
  "services:manage",
  "deployments:create",
  "variables:manage",
];

/** Create and delete projects, and read secret values. */
const ADMIN_PROJECTS: Action[] = [...BUILD_PROJECTS, "projects:manage", "variables:reveal"];

const ROLE_GRANTS: Record<Role, ReadonlySet<Action>> = {
  owner: new Set<Action>([
    "workspace:read",
    "workspace:update",
    "workspace:delete",
    "members:read",
    "members:manage",
    "tokens:manage",
    "nodes:read",
    "nodes:manage",
    "audit:read",
    ...ADMIN_PROJECTS,
    "instance:manage",
  ]),
  admin: new Set<Action>([
    "workspace:read",
    "workspace:update",
    "members:read",
    "members:manage",
    "tokens:manage",
    "nodes:read",
    "nodes:manage",
    "audit:read",
    ...ADMIN_PROJECTS,
  ]),
  member: new Set<Action>(["workspace:read", "members:read", "nodes:read", ...BUILD_PROJECTS]),
  viewer: new Set<Action>(["workspace:read", "nodes:read", ...READ_PROJECTS]),
};

/**
 * Checks whether a role may perform an action.
 *
 * @param role - The caller's role in the target workspace.
 * @param action - The action being attempted.
 * @returns `true` when the role grants the action.
 * @example
 * can("member", "nodes:manage"); // false
 */
export function can(role: Role, action: Action): boolean {
  return ROLE_GRANTS[role].has(action);
}

/**
 * Type guard for untrusted role strings (e.g. from the database or a request body).
 *
 * @param value - Value to check.
 * @returns `true` when `value` is a known role.
 */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
