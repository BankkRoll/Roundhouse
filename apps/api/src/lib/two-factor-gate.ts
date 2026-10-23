/**
 * The two-factor gate (ADR 0014 "Auth"): a signed-in user who must have 2FA
 * (`isTwoFactorRequired`) but hasn't enrolled gets 403 `two_factor_required`
 * on every `/v1/*` mutation, except the paths in
 * {@link TWO_FACTOR_EXEMPT_PATHS}. Enrollment itself happens under
 * `/api/auth/two-factor/*`, which the gate never sees.
 *
 * Owned by the api-auth stream.
 *
 * @module
 */
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../context";

/**
 * Mutations allowed before enrolling: setup and invite acceptance create
 * the account, re-auth is part of enrolling, and agents and GitHub don't
 * use sessions.
 */
export const TWO_FACTOR_EXEMPT_PATHS: readonly RegExp[] = [
  /^\/v1\/setup$/,
  /^\/v1\/invites\/[^/]+\/accept$/,
  /^\/v1\/auth\/reauth$/,
  /^\/v1\/nodes\/join$/,
  /^\/v1\/webhooks\/github$/,
];

/** Rejects mutations by users who must enroll a second factor first. */
export const twoFactorGate = createMiddleware<AppEnv>(async (_c, next) => {
  // TODO(api-auth): load the session user, check isTwoFactorRequired against
  // users.instance_admin and their workspace roles, and refuse non-GET
  // requests outside TWO_FACTOR_EXEMPT_PATHS while two_factor_enabled is false.
  await next();
});
