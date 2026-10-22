/** Workspace roles, ordered from most to least privileged. */
export const ROLES = ["owner", "admin", "member", "viewer"] as const;

/** A workspace role. */
export type Role = (typeof ROLES)[number];

/**
 * Every action gated by RBAC. Routes declare one of these; the middleware
 * resolves the caller's role and checks it against {@link ROLE_GRANTS}.
 */
export type Action =
  | "workspace:read"
  | "workspace:update"
  | "workspace:delete"
  | "members:read"
  | "members:manage"
  | "nodes:read"
  | "nodes:manage"
  | "audit:read";

const ROLE_GRANTS: Record<Role, ReadonlySet<Action>> = {
  owner: new Set<Action>([
    "workspace:read",
    "workspace:update",
    "workspace:delete",
    "members:read",
    "members:manage",
    "nodes:read",
    "nodes:manage",
    "audit:read",
  ]),
  admin: new Set<Action>([
    "workspace:read",
    "workspace:update",
    "members:read",
    "members:manage",
    "nodes:read",
    "nodes:manage",
    "audit:read",
  ]),
  member: new Set<Action>(["workspace:read", "members:read", "nodes:read"]),
  viewer: new Set<Action>(["workspace:read", "nodes:read"]),
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
