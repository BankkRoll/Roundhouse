/**
 * Route policies: how a contract route authenticates its caller, which
 * action it checks, what it audits, and whether it needs a fresh session.
 * Shared by every contract file; owned by the api-authz-rbac-github stream.
 *
 * @module
 */
import { createRoute, type RouteConfig } from "@hono/zod-openapi";
import type { Action, AuditAction } from "@openrail/shared";

/** OpenAPI extension key carrying a route's {@link RoutePolicy}. */
export const POLICY_KEY = "x-openrail-policy";

/** How a route authenticates its caller. */
export type RouteAuth =
  /** Better Auth session cookie (or, where tokens are accepted, an API token); access control applies. */
  | "session"
  /** `X-Hub-Signature-256` over the raw body with the App's webhook secret. */
  | "github_signature";

/** Who may call a route and what it records. */
export interface RoutePolicy {
  auth: RouteAuth;
  /**
   * Checked with `resolveAccess(...).check(action, scope)`: instance actions
   * against the instance-admin flag, workspace actions against the caller's
   * role in the owning workspace, project actions against their project
   * role, and environment actions also against the target environment's
   * protection when the route names one. `null` for routes that
   * authenticate by signature.
   */
  action: Action | null;
  /** Audit actions the handler records when it succeeds (some only in certain cases). */
  audit: readonly AuditAction[];
  /**
   * Needs a session that signed in or re-authenticated within
   * `REAUTH_WINDOW_MS`; otherwise 403 `reauth_required`. Never satisfiable
   * with an API token.
   */
  reauth?: boolean;
}

/**
 * `createRoute` plus a policy, stored under {@link POLICY_KEY} so it also
 * appears in the OpenAPI document.
 *
 * @param policy - The route's policy.
 * @param config - The `createRoute` config.
 * @returns The route, typed as `createRoute` returns it.
 */
export function defineRoute<P extends string, R extends Omit<RouteConfig, "path"> & { path: P }>(
  policy: RoutePolicy,
  config: R,
) {
  return createRoute({ ...config, [POLICY_KEY]: policy } as R & { [POLICY_KEY]: RoutePolicy });
}

/**
 * Reads the policy of a contract route.
 *
 * @param route - A route exported from `../contracts`.
 * @returns Its auth mode, action, audit actions and freshness requirement.
 * @example
 * await requireWorkspace(c, project.workspaceId, policyOf(getProject).action!);
 */
export function policyOf(route: { [POLICY_KEY]: RoutePolicy }): RoutePolicy {
  return route[POLICY_KEY];
}

/**
 * Policy of a session-authenticated route.
 *
 * @param action - Action checked.
 * @param audit - Audit actions recorded.
 * @param options - `reauth: true` for dangerous actions.
 * @returns The policy.
 */
export function session(
  action: Action,
  audit: readonly AuditAction[] = [],
  options: { reauth?: boolean } = {},
): RoutePolicy {
  return { auth: "session", action, audit, ...(options.reauth ? { reauth: true } : {}) };
}
