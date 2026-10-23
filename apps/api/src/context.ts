/**
 * Request-scoped helpers shared by every route: the typed Hono environment,
 * the caller's principal (a browser session or an API token), and the RBAC
 * gate.
 *
 * - {@link currentPrincipal} resolves `Authorization: Bearer tok_…` when
 *   present (never falling back to cookies), else the Better Auth session,
 *   forwarding any refreshed session cookie onto the response.
 * - {@link requireWorkspace} checks an action in a workspace: a token must
 *   belong to that workspace, carry the action as a scope, and its creator's
 *   current role must grant it.
 *
 * @module
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { createDb, type Db, workspaceMembers, workspaces } from "@openrail/db";
import { type Action, type AuditActorType, can, type Role } from "@openrail/shared";
import { APIError } from "better-auth/api";
import { and, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { type AuthOptions, createAuth } from "./auth";
import type { Env } from "./env";
import { bearerSecret, resolveApiToken } from "./lib/api-tokens";
import { isValidMasterKey } from "./lib/crypto";
import { ApiError, errorBody } from "./lib/errors";

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
 * The control plane's public origin, derived from the request.
 *
 * @param c - Request context.
 * @returns E.g. `https://cp.example.com`.
 */
export function originOf(c: AppContext): string {
  return new URL(c.req.url).origin;
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

/**
 * Loads the caller's membership in `workspaceId` and checks `action`.
 *
 * Non-members get 404, not 403, so workspace IDs can't be probed; a token
 * gets 404 for every workspace but its own. A token also needs `action` among
 * its scopes, on top of its creator's role granting it.
 *
 * @param c - Request context.
 * @param workspaceId - Workspace from the route.
 * @param action - Action being attempted.
 * @returns The caller's membership, identity and audit actor.
 */
export async function requireWorkspace(
  c: AppContext,
  workspaceId: string,
  action: Action,
): Promise<Membership & { user: SessionUser; principal: Principal; actor: AuditActor }> {
  const principal = await requirePrincipal(c);
  if (principal.token && principal.token.workspaceId !== workspaceId) {
    throw new ApiError(404, "not_found", "Workspace not found");
  }
  const { user } = principal;
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
  if (!can(row.role, action)) {
    throw new ApiError(403, "forbidden", `Your role (${row.role}) cannot perform ${action}`);
  }
  if (principal.token && !principal.token.scopes.includes(action)) {
    throw new ApiError(403, "forbidden", `This API token lacks the ${action} scope`);
  }
  return {
    workspaceId,
    memberId: row.memberId,
    role: row.role,
    user,
    principal,
    actor: actorOf(principal),
  };
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
 * Checks an install-wide action, which has no owning workspace: the caller
 * must hold it in at least one live workspace (in practice, be an owner).
 * API tokens are workspace-scoped and never pass.
 *
 * @param c - Request context.
 * @param action - Usually `instance:manage`.
 * @returns The signed-in user and the IDs of the workspaces granting `action`.
 * @throws {ApiError} 401 when signed out, 403 for a token or when no
 *   membership grants `action`.
 */
export async function requireInstanceAction(
  c: AppContext,
  action: Action,
): Promise<SessionUser & { workspaceIds: string[] }> {
  const user = await requireUser(c);
  const rows = await c
    .get("db")
    .select({ role: workspaceMembers.role, workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, user.id), isNull(workspaces.deletedAt)));
  const granting = rows.filter((r) => can(r.role, action)).map((r) => r.workspaceId);
  if (!granting.length) {
    throw new ApiError(403, "forbidden", `Only workspace owners can perform ${action}`);
  }
  return { ...user, workspaceIds: granting.sort() };
}
