/**
 * Request-scoped helpers shared by every route: the typed Hono environment,
 * the caller's principal (a browser session or an API token), and the RBAC
 * gate.
 *
 * - {@link currentPrincipal} resolves `Authorization: Bearer tok_…` when
 *   present (never falling back to cookies), else the Better Auth session,
 *   forwarding any refreshed session cookie onto the response.
 * - {@link requireWorkspace} checks an action in a workspace with
 *   `resolveAccess`: a token must belong to that workspace, carry the action
 *   as a scope, and its creator's current access must grant it.
 * - {@link requireInstanceAction} checks install-wide actions against the
 *   instance-admin flag; tokens never pass.
 *
 * @module
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { createDb, type Db, users, workspaceMembers, workspaces } from "@roundhouse/db";
import {
  type AccessDenial,
  type AccessScope,
  type Action,
  type AuditActorType,
  type InstanceAction,
  isInstanceAction,
  type ProjectAction,
  type ProjectRole,
  type Role,
  resolveAccess,
} from "@roundhouse/shared";
import { APIError } from "better-auth/api";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { type AuthOptions, createAuth } from "./auth";
import { POLICY_KEY, type RoutePolicy } from "./contracts/policy";
import type { Env } from "./env";
import { loadAccessContext, loadWorkspaceAccess } from "./lib/access";
import { bearerSecret, resolveApiToken } from "./lib/api-tokens";
import { isValidMasterKey } from "./lib/crypto";
import { ApiError, errorBody } from "./lib/errors";
import { requireFreshSession } from "./lib/fresh-session";
import { publicOrigin } from "./lib/origin";

/** The signed-in user as exposed to handlers. */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

/** An API token acting for its creator. */
export interface TokenIdentity {
  id: string;
  name: string;
  /** The only workspace the token can reach. */
  workspaceId: string;
  scopes: readonly Action[];
  /** Set for an MCP OAuth access token (only `/mcp` accepts those). */
  oauth?: {
    grantId: string;
    /** The client metadata document URL. */
    clientId: string;
    /** Unix ms. */
    expiresAt: number;
  };
}

/**
 * Who is calling. `user` is the session's user, or a token's creator; with a
 * token, `token` is set and `session` is `null`.
 */
export interface Principal {
  user: SessionUser;
  session: { id: string; expiresAt: number } | null;
  token: TokenIdentity | null;
}

/** The `actor_type` / `actor_id` pair audit records carry for a principal. */
export interface AuditActor {
  actorType: Extract<AuditActorType, "user" | "token">;
  actorId: string;
}

/** The caller's membership in the workspace named by the route. */
export interface Membership {
  workspaceId: string;
  memberId: string;
  role: Role;
  /** The caller's role on the project in scope, when the check named one. */
  projectRole: ProjectRole | null;
}

/** Hono environment for every route in the API. */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    db: Db;
    /** `undefined` = not looked up yet, `null` = anonymous. */
    principal: Principal | null | undefined;
  };
}

/** Context type for handlers and helpers. */
export type AppContext = Context<AppEnv>;

/**
 * Refuses a stale session before the handler of a `reauth: true` route runs.
 *
 * SECURITY: This runs ahead of the handler's own access check on purpose.
 * The answer doesn't depend on the resource named, so it reveals nothing,
 * and no handler can forget it.
 */
const freshSessionGuard = createMiddleware<AppEnv>(async (c, next) => {
  await requireFreshSession(c);
  await next();
});

/**
 * Creates a router whose request-validation failures use the API's error
 * shape, and which enforces each contract route's `reauth` policy (ADR
 * 0014 "Fresh sessions") in front of its handler.
 *
 * @returns A new OpenAPI-aware router.
 */
export function createRouter() {
  const router = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const issue = result.error.issues[0];
        const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
        return c.json(errorBody("invalid_request", `${where}${issue?.message ?? "invalid"}`), 400);
      }
    },
  });
  const register = router.openapi;
  router.openapi = ((route, handler, hook) => {
    const policy = (route as { [POLICY_KEY]?: RoutePolicy })[POLICY_KEY];
    if (!policy?.reauth) return register(route, handler, hook);
    const own = route.middleware;
    const middleware = [freshSessionGuard, ...(own ? (Array.isArray(own) ? own : [own]) : [])];
    return register({ ...route, middleware }, handler, hook);
  }) as typeof router.openapi;
  return router;
}

/** Attaches a Drizzle client to every request. */
export const withDb = createMiddleware<AppEnv>(async (c, next) => {
  c.set("db", createDb(c.env.DB));
  await next();
});

/**
 * The control plane's public origin; see `publicOrigin` (ADR 0014: never the request's `Host`).
 *
 * @param c - Request context.
 * @returns E.g. `https://cp.example.com`.
 */
export function originOf(c: AppContext): string {
  return publicOrigin(c);
}

/**
 * Returns `MASTER_KEY` or throws a 503 explaining how to set it.
 *
 * @param c - Request context.
 * @returns The validated master key.
 */
export function requireMasterKey(c: AppContext): string {
  const key = c.env.MASTER_KEY;
  if (!isValidMasterKey(key)) {
    throw new ApiError(
      503,
      "master_key_missing",
      "MASTER_KEY is not configured. Set it with `wrangler secret put MASTER_KEY`.",
    );
  }
  return key.trim();
}

/**
 * Builds a Better Auth instance for this request.
 *
 * @param c - Request context.
 * @param options - Per-call auth options.
 * @returns A Better Auth instance for this request's database and origin.
 * @throws {ApiError} 503 `master_key_missing` when `MASTER_KEY` isn't configured.
 */
export function authFor(c: AppContext, options?: AuthOptions) {
  requireMasterKey(c);
  return createAuth(c.get("db"), c.env, originOf(c), options);
}

/** Profile and credentials for an account created on the caller's behalf. */
export interface SignUpInput {
  name: string;
  email: string;
  password: string;
}

/**
 * Creates an account through Better Auth, bypassing the closed public sign-up.
 * Only the setup wizard and invite acceptance may call this.
 *
 * @param c - Request context.
 * @param input - The new account's profile and password.
 * @returns The new user's ID and the headers carrying their session cookie.
 * @throws {ApiError} 400 `invalid_request` when Better Auth rejects the account.
 */
export async function signUp(
  c: AppContext,
  input: SignUpInput,
): Promise<{ userId: string; headers: Headers }> {
  const auth = await authFor(c, { allowSignUp: true });
  try {
    const { headers, response } = await auth.api.signUpEmail({ body: input, returnHeaders: true });
    return { userId: response.user.id, headers };
  } catch (err) {
    if (err instanceof APIError) {
      throw new ApiError(400, "invalid_request", err.message || "Could not create account");
    }
    throw err;
  }
}

/**
 * Audit actor of a principal: the token when one is used, else the user.
 *
 * @param principal - The caller.
 * @returns Fields to spread into an audit entry.
 */
export function actorOf(principal: Principal): AuditActor {
  return principal.token
    ? { actorType: "token", actorId: principal.token.id }
    : { actorType: "user", actorId: principal.user.id };
}

async function tokenPrincipal(c: AppContext, secret: string): Promise<Principal> {
  const row = await resolveApiToken(c.get("db"), secret);
  if (row) {
    return {
      user: row.user,
      session: null,
      token: { id: row.id, name: row.name, workspaceId: row.workspaceId, scopes: row.scopes },
    };
  }
  // SECURITY: Secrets carry 256 bits, so this isn't about guessing; it keeps a
  // client stuck on a revoked token, or a scanner, from hammering D1.
  const limiter = c.env.AUTH_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: `token:${clientIp(c) ?? "unknown"}` });
    if (!success) {
      c.header("retry-after", "60");
      throw new ApiError(429, "rate_limited", "Too many failed token attempts; try again later");
    }
  }
  throw new ApiError(401, "invalid_token", "The API token is invalid, expired or revoked");
}

async function sessionPrincipal(c: AppContext): Promise<Principal | null> {
  if (!isValidMasterKey(c.env.MASTER_KEY)) return null;
  const auth = await authFor(c);
  const { headers, response } = await auth.api.getSession({
    headers: c.req.raw.headers,
    returnHeaders: true,
  });
  // Better Auth extends a session it reads after `updateAge` and re-issues the
  // cookie; without forwarding it the browser or CLI keeps the old expiry.
  for (const cookie of headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
  if (!response) return null;
  const { id, name, email, image } = response.user;
  return {
    user: { id, name, email, image: image ?? null },
    session: { id: response.session.id, expiresAt: +new Date(response.session.expiresAt) },
    token: null,
  };
}

/**
 * Resolves the caller, memoised per request. A bearer header is authoritative:
 * when present, cookies are ignored, so a request can't be half one and half
 * the other.
 *
 * @param c - Request context.
 * @returns The principal, or `null` when anonymous.
 * @throws {ApiError} 401 `invalid_token` for a bearer secret that isn't a live
 *   API token; 429 after repeated failures from one address.
 */
export async function currentPrincipal(c: AppContext): Promise<Principal | null> {
  const cached = c.get("principal");
  if (cached !== undefined) return cached;
  const secret = bearerSecret(c.req.header("authorization"));
  const principal = secret ? await tokenPrincipal(c, secret) : await sessionPrincipal(c);
  c.set("principal", principal);
  return principal;
}

/**
 * Returns the principal or throws 401.
 *
 * @param c - Request context.
 * @returns The caller.
 * @throws {ApiError} 401 `unauthorized` when anonymous.
 */
export async function requirePrincipal(c: AppContext): Promise<Principal> {
  const principal = await currentPrincipal(c);
  if (!principal) throw new ApiError(401, "unauthorized", "Sign in to continue");
  return principal;
}

const tokenRefused = () =>
  new ApiError(403, "forbidden", "API tokens can't be used for this request; sign in instead");

/**
 * The session user, for routes only a browser session may call.
 *
 * @param c - Request context.
 * @returns The user, or `null` when anonymous.
 * @throws {ApiError} 403 when the request authenticates with an API token.
 */
export async function currentUser(c: AppContext): Promise<SessionUser | null> {
  const principal = await currentPrincipal(c);
  if (principal?.token) throw tokenRefused();
  return principal?.user ?? null;
}

/**
 * Returns the session user or throws, for routes only a browser session may call.
 *
 * @param c - Request context.
 * @returns The signed-in user.
 * @throws {ApiError} 401 `unauthorized` when there is no valid session; 403
 *   for an API token.
 */
export async function requireUser(c: AppContext): Promise<SessionUser> {
  const principal = await requirePrincipal(c);
  if (principal.token) throw tokenRefused();
  return principal.user;
}

/** Message of the 404 a non-member gets, which nested scopes reword per resource. */
export const WORKSPACE_NOT_FOUND = "Workspace not found";

// Stands in for "any project" when a project action is checked workspace-wide.
const WORKSPACE_WIDE = "*";

/** The caller of a workspace-scoped route, as {@link requireWorkspace} resolved them. */
export interface Caller extends Membership {
  user: SessionUser;
  principal: Principal;
  actor: AuditActor;
  /**
   * Checks another action with the same scope, e.g. whether a reader may
   * also see plain values. Instance actions are never allowed here.
   */
  allows(action: Exclude<Action, InstanceAction>): boolean;
}

function denied(role: Role, action: Action, reason: AccessDenial | null): ApiError {
  switch (reason) {
    case "token_scope":
      return new ApiError(403, "forbidden", `This API token lacks the ${action} scope`);
    case "environment_protected":
      return new ApiError(
        403,
        "forbidden",
        `This environment is protected; your project role cannot perform ${action} here`,
      );
    case "no_project_access":
      // ADR 0014: a project the caller has no role on doesn't exist for them;
      // scope helpers reword this per resource.
      return new ApiError(404, "not_found", WORKSPACE_NOT_FOUND);
    case "unknown_environment":
    case "environment_mismatch":
      return new ApiError(404, "not_found", "Environment not found");
    default:
      return new ApiError(403, "forbidden", `Your role (${role}) cannot perform ${action}`);
  }
}

/**
 * Loads the caller's membership in `workspaceId` and checks `action`.
 *
 * Non-members get 404, not 403, so workspace IDs can't be probed; a token
 * gets 404 for every workspace but its own.
 *
 * The decision is `resolveAccess` with the caller as subject: a token acts
 * as its creator with `tokenScopes` set, so it needs `action` among its
 * scopes on top of its creator's access, and never passes an instance
 * action. With a `scope`, project actions use the caller's project role
 * there (grants and teams included) and environment actions also the
 * environment's protection. A project action checked without a scope (a
 * workspace-wide list) uses the role the workspace role implies.
 *
 * @param c - Request context.
 * @param workspaceId - Workspace from the route.
 * @param action - Action being attempted.
 * @param scope - Project and/or environment the action targets.
 * @returns The caller's membership, identity and audit actor.
 * @throws {ApiError} 404 for non-members; 403 when access is denied.
 */
export async function requireWorkspace(
  c: AppContext,
  workspaceId: string,
  action: Action,
  scope: AccessScope = {},
): Promise<Caller> {
  const principal = await requirePrincipal(c);
  if (principal.token && principal.token.workspaceId !== workspaceId) {
    throw new ApiError(404, "not_found", WORKSPACE_NOT_FOUND);
  }
  const { user } = principal;
  const db = c.get("db");
  const [row] = await db
    .select({
      memberId: workspaceMembers.id,
      role: workspaceMembers.role,
      memberDefaultProjectRole: workspaces.memberDefaultProjectRole,
      viewerDefaultProjectRole: workspaces.viewerDefaultProjectRole,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, user.id),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw new ApiError(404, "not_found", WORKSPACE_NOT_FOUND);
  const base = {
    workspaceId,
    memberId: row.memberId,
    role: row.role,
    user,
    principal,
    actor: actorOf(principal),
  };
  if (isInstanceAction(action)) {
    if (principal.token) throw denied(row.role, action, "token_scope");
    await requireInstanceAction(c, action);
    return { ...base, projectRole: null, allows: () => false };
  }
  const settings = {
    memberDefaultProjectRole: row.memberDefaultProjectRole,
    viewerDefaultProjectRole: row.viewerDefaultProjectRole,
  };
  const loaded = await loadAccessContext(db, { workspaceId, settings, userId: user.id, scope });
  const access = resolveAccess(
    {
      userId: user.id,
      workspaceRole: row.role,
      instanceAdmin: false,
      teamIds: loaded.teamIds,
      tokenScopes: principal.token?.scopes ?? null,
    },
    loaded.context,
  );
  // A project action checked without a project (a workspace-wide list) gets
  // what every project of the workspace grants by default; with no grants
  // loaded, any project ID yields exactly the role the workspace role implies.
  const decide = (a: Action) => {
    const d = access.check(a, scope);
    return d.reason === "scope_required"
      ? { ...access.check(a, { projectId: WORKSPACE_WIDE }), projectRole: null }
      : d;
  };
  const decision = decide(action);
  if (!decision.allowed) throw denied(row.role, action, decision.reason);
  return {
    ...base,
    projectRole: decision.projectRole,
    allows: (other: Exclude<Action, InstanceAction>) => decide(other).allowed,
  };
}

/**
 * For workspace-wide lists of projects: checks that the caller is a member
 * (and that a token carries `action`), then returns the live projects where
 * they hold `action`. ADR 0014: a project the caller has no role on is left
 * out of lists, as it is a 404 everywhere else.
 *
 * @param c - Request context.
 * @param workspaceId - Workspace from the route.
 * @param action - The list route's project action, e.g. `projects:read`.
 * @returns IDs of the projects to show.
 * @throws {ApiError} 404 for non-members (and tokens of other workspaces);
 *   403 for a token without the scope.
 */
export async function visibleProjects(
  c: AppContext,
  workspaceId: string,
  action: ProjectAction,
): Promise<Set<string>> {
  const principal = await requirePrincipal(c);
  if (principal.token && principal.token.workspaceId !== workspaceId) {
    throw new ApiError(404, "not_found", WORKSPACE_NOT_FOUND);
  }
  const loaded = await loadWorkspaceAccess(c.get("db"), workspaceId, principal.user.id);
  if (loaded.role === null) throw new ApiError(404, "not_found", WORKSPACE_NOT_FOUND);
  if (principal.token && !principal.token.scopes.includes(action)) {
    throw denied(loaded.role, action, "token_scope");
  }
  const access = resolveAccess(
    {
      userId: principal.user.id,
      workspaceRole: loaded.role,
      instanceAdmin: false,
      teamIds: loaded.teamIds,
      tokenScopes: principal.token?.scopes ?? null,
    },
    loaded.context,
  );
  return new Set(loaded.projectIds.filter((projectId) => access.can(action, { projectId })));
}

/**
 * Best-effort client IP for audit records and rate-limit keys.
 *
 * @param c - Request context.
 * @returns The address Cloudflare observed, or `null` outside Cloudflare's edge.
 */
export function clientIp(c: AppContext): string | null {
  return c.req.header("cf-connecting-ip") ?? null;
}

/**
 * Checks an install-wide action against the caller's `users.instance_admin`
 * flag (ADR 0014, F3: owning a workspace no longer grants it). API tokens
 * never pass: they are workspace-scoped and never carry instance actions.
 *
 * A route's `reauth` policy is enforced by its router (see
 * {@link createRouter}), not here.
 *
 * @param c - Request context.
 * @param action - An instance action, e.g. `instance:manage`.
 * @returns The signed-in user.
 * @throws {ApiError} 401 when signed out, 403 for a token or when not an
 *   instance admin.
 */
export async function requireInstanceAction(
  c: AppContext,
  action: InstanceAction,
): Promise<SessionUser> {
  const user = await requireUser(c);
  const [row] = await c
    .get("db")
    .select({ instanceAdmin: users.instanceAdmin })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (!row?.instanceAdmin) {
    throw new ApiError(403, "forbidden", `Only instance admins can perform ${action}`);
  }
  return user;
}
