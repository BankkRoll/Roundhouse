/**
 * The two-factor gate (ADR 0014 "Auth"): a signed-in user who must have 2FA
 * (`isTwoFactorRequired`) but hasn't enrolled gets 403 `two_factor_required`
 * on every `/v1/*` mutation, except the paths in
 * {@link TWO_FACTOR_EXEMPT_PATHS}. Enrollment itself happens under
 * `/api/auth/two-factor/*`, which the gate never sees.
 *
 * The requirement applies to the person, so an API token acting for such a
 * user is refused too. There is no grace period: promoting someone to admin
 * succeeds, and they enroll before their next change.
 *
 * Owned by the api-auth stream.
 *
 * @module
 */
import { type Db, users, workspaceMembers, workspaces } from "@roundhouse/db";
import { isTwoFactorRequired } from "@roundhouse/shared";
import { and, eq, isNull } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { type AppEnv, currentPrincipal } from "../context";
import { errorBody } from "./errors";

/**
 * Mutations allowed before enrolling: setup and invite acceptance create
 * the account, the account security routes (re-auth, sessions) are part of
 * securing it, and agents and GitHub don't use sessions.
 */
export const TWO_FACTOR_EXEMPT_PATHS: readonly RegExp[] = [
  /^\/v1\/setup$/,
  /^\/v1\/invites\/(accept|lookup)$/,
  /^\/v1\/auth\//,
  /^\/v1\/nodes\/join$/,
  /^\/v1\/webhooks\/github$/,
];

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether a user must enroll, and whether they have. */
export interface TwoFactorRequirement {
  required: boolean;
  enabled: boolean;
  instanceAdmin: boolean;
}

/**
 * Loads what decides the gate for one user: the instance-admin flag, their
 * roles in live workspaces, and whether 2FA is on.
 *
 * @param db - Database client.
 * @param userId - The user.
 * @returns The requirement; a missing user is neither required nor enrolled.
 */
export async function twoFactorRequirement(db: Db, userId: string): Promise<TwoFactorRequirement> {
  const [[user], memberships] = await Promise.all([
    db
      .select({ instanceAdmin: users.instanceAdmin, enabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
    db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(and(eq(workspaceMembers.userId, userId), isNull(workspaces.deletedAt))),
  ]);
  if (!user) return { required: false, enabled: false, instanceAdmin: false };
  return {
    required: isTwoFactorRequired(
      user.instanceAdmin,
      memberships.map((m) => m.role),
    ),
    enabled: user.enabled,
    instanceAdmin: user.instanceAdmin,
  };
}

/** Rejects mutations by users who must enroll a second factor first. */
export const twoFactorGate = createMiddleware<AppEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method) || TWO_FACTOR_EXEMPT_PATHS.some((r) => r.test(c.req.path))) {
    return next();
  }
  // NOTE: An invalid bearer token throws its usual 401 here instead of in
  // the route; the principal is memoised, so the route would throw the same.
  const principal = await currentPrincipal(c);
  if (!principal) return next();
  const { required, enabled } = await twoFactorRequirement(c.get("db"), principal.user.id);
  if (required && !enabled) {
    return c.json(
      errorBody(
        "two_factor_required",
        "Set up two-factor authentication under Preferences → Security before making changes",
      ),
      403,
    );
  }
  return next();
});
