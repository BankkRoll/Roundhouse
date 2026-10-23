/**
 * API token vocabulary shared by the API (which issues and checks tokens) and
 * the dashboard and CLI (which create them).
 *
 * A token belongs to one workspace and to the member who created it. Its
 * scopes are RBAC {@link Action}s; a request made with it may perform an
 * action only when the token has that scope **and** its creator's current
 * role grants it, so demoting or removing the creator narrows the token too.
 *
 * @module
 */
import { ACTIONS, type Action, can, type Role } from "./rbac";

/** Prefix of every API token secret; also how the API tells tokens from other bearers. */
export const API_TOKEN_PREFIX = "tok_";

/** Characters of the secret kept in clear for display (`tok_` plus 4), never enough to use it. */
export const API_TOKEN_DISPLAY_PREFIX_LENGTH = API_TOKEN_PREFIX.length + 4;

/** Longest lifetime a token can be created with, in days. */
export const MAX_API_TOKEN_TTL_DAYS = 366;

/**
 * Scopes a token may carry: every workspace action. `instance:manage` is
 * excluded because install-wide settings are only changed from a browser
 * session by an owner.
 */
export const API_TOKEN_SCOPES = ACTIONS.filter(
  (a): a is Exclude<Action, "instance:manage"> => a !== "instance:manage",
);

/** A scope an API token can carry; see {@link API_TOKEN_SCOPES}. */
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

/**
 * Type guard for untrusted scope strings.
 *
 * @param value - Candidate scope.
 * @returns `true` when `value` is a scope a token may carry.
 */
export function isApiTokenScope(value: unknown): value is ApiTokenScope {
  return typeof value === "string" && (API_TOKEN_SCOPES as readonly string[]).includes(value);
}

/** Named scope sets offered when creating a token. */
export const API_TOKEN_PRESETS = {
  /** Read projects, services, deployments, logs and masked variables. */
  read: ["workspace:read", "projects:read", "services:read", "variables:read", "nodes:read"],
  /** What CI needs to ship: read, deploy, change services and variables. */
  deploy: [
    "workspace:read",
    "projects:read",
    "services:read",
    "variables:read",
    "nodes:read",
    "services:manage",
    "deployments:create",
    "variables:manage",
  ],
} as const satisfies Record<string, readonly ApiTokenScope[]>;

/** Name of a scope preset; see {@link API_TOKEN_PRESETS}. */
export type ApiTokenPreset = keyof typeof API_TOKEN_PRESETS;

/**
 * Scopes among `scopes` that `role` does not grant. A member can only create
 * a token with scopes their own role holds.
 *
 * @param role - Creator's role in the token's workspace.
 * @param scopes - Requested scopes.
 * @returns The scopes the role lacks, in input order; empty when all are granted.
 * @example
 * scopesBeyondRole("member", ["services:read", "members:manage"]); // ["members:manage"]
 */
export function scopesBeyondRole(role: Role, scopes: readonly Action[]): Action[] {
  return scopes.filter((s) => !can(role, s));
}
