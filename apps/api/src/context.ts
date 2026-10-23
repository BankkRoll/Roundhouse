/**
 * Request-scoped helpers shared by every route: the typed Hono environment,
 * lazy session loading, and the RBAC gate.
 *
 * @module
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { createDb, type Db, users, workspaceMembers, workspaces } from "@openrail/db";
import {
  type Action,
  can,
  type InstanceAction,
  isInstanceAction,
  type Role,
} from "@openrail/shared";
import { APIError } from "better-auth/api";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { type AuthOptions, createAuth } from "./auth";
import type { Env } from "./env";
import { isValidMasterKey } from "./lib/crypto";
import { ApiError, errorBody } from "./lib/errors";
import { publicOrigin } from "./lib/origin";

/** The signed-in user as exposed to handlers. */
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

/** The caller's membership in the workspace named by the route. */
export interface Membership {
  workspaceId: string;
  memberId: string;
  role: Role;
}

/** Hono environment for every route in the API. */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    db: Db;
    /** `undefined` = not looked up yet, `null` = anonymous. */
    user: SessionUser | null | undefined;
  };
}

/** Context type for handlers and helpers. */
export type AppContext = Context<AppEnv>;

/**
 * Creates a router whose request-validation failures use the API's error shape.
 *
 * @returns A new OpenAPI-aware router.
 */
export function createRouter() {
  return new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const issue = result.error.issues[0];
        const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
        return c.json(errorBody("invalid_request", `${where}${issue?.message ?? "invalid"}`), 400);
      }
    },
  });
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
  return createAuth(c.get("db"), requireMasterKey(c), originOf(c), options);
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
 * Resolves the session user, memoised per request.
 *
 * @param c - Request context.
 * @returns The user, or `null` when anonymous.
 */
export async function currentUser(c: AppContext): Promise<SessionUser | null> {
  const cachedUser = c.get("user");
  if (cachedUser !== undefined) return cachedUser;
  let user: SessionUser | null = null;
  if (isValidMasterKey(c.env.MASTER_KEY)) {
    const auth = await authFor(c);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (session) {
      const { id, name, email, image } = session.user;
      user = { id, name, email, image: image ?? null };
    }
  }
  c.set("user", user);
  return user;
}

/**
 * Returns the session user or throws 401.
 *
 * @param c - Request context.
 * @returns The signed-in user.
 * @throws {ApiError} 401 `unauthorized` when there is no valid session.
 */
export async function requireUser(c: AppContext): Promise<SessionUser> {
  const user = await currentUser(c);
  if (!user) throw new ApiError(401, "unauthorized", "Sign in to continue");
  return user;
}

/**
 * Loads the caller's membership in `workspaceId` and checks `action`.
 *
 * Non-members get 404, not 403, so workspace IDs can't be probed.
 *
 * @param c - Request context.
 * @param workspaceId - Workspace from the route.
 * @param action - Action being attempted.
 * @returns The caller's membership.
 */
export async function requireWorkspace(
  c: AppContext,
  workspaceId: string,
  action: Action,
): Promise<Membership & { user: SessionUser }> {
  const user = await requireUser(c);
  const [row] = await c
    .get("db")
    .select({ memberId: workspaceMembers.id, role: workspaceMembers.role })
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
  if (!row) throw new ApiError(404, "not_found", "Workspace not found");
  // TODO(api-authz-rbac-github): resolve with `resolveAccess` (grants, teams,
  // environment protection, token scopes) instead of the coarse role check.
  if (isInstanceAction(action)) {
    await requireInstanceAction(c, action);
  } else if (!can(row.role, action)) {
    throw new ApiError(403, "forbidden", `Your role (${row.role}) cannot perform ${action}`);
  }
  return { workspaceId, memberId: row.memberId, role: row.role, user };
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
 * flag (ADR 0014, F3: owning a workspace no longer grants it).
 *
 * TODO(api-authz-rbac-github): also enforce the policy's `reauth` and route
 * through `resolveAccess`; reject API tokens.
 *
 * @param c - Request context.
 * @param action - An instance action, e.g. `instance:manage`.
 * @returns The signed-in user.
 * @throws {ApiError} 401 when signed out, 403 when not an instance admin.
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
