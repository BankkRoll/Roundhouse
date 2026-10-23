/**
 * Account security routes (ADR 0014 "Auth"). Two-factor enrollment,
 * verification and backup codes are Better Auth's own
 * `/api/auth/two-factor/*` endpoints; sessions are listed and revoked with
 * `/api/auth/list-sessions` and `/api/auth/revoke-session`. Owned by the
 * api-auth stream.
 *
 * `action: null` with `auth: "session"` means any signed-in user.
 *
 * @module
 */
import { body, errors, json, sessionAuth } from "../schemas";
import { ReauthBody, ReauthResultSchema, SecurityStatusSchema } from "../schemas/auth";
import { defineRoute } from "./policy";

/** The caller's two-factor and freshness state. Exempt from the two-factor gate. */
export const getSecurityStatus = defineRoute(
  { auth: "session", action: null, audit: [] },
  {
    method: "get",
    path: "/v1/auth/security",
    tags: ["auth"],
    summary: "Get my security status",
    security: sessionAuth,
    responses: { 200: json(SecurityStatusSchema), ...errors(401) },
  },
);

/**
 * Re-enters the password (and a TOTP or backup code when 2FA is on) to make
 * the session fresh for `REAUTH_WINDOW_MS`. Counts toward the sign-in
 * lockout on failure. Exempt from the two-factor gate.
 */
export const reauthenticate = defineRoute(
  { auth: "session", action: null, audit: ["auth.reauthenticated", "auth.sign_in_failed"] },
  {
    method: "post",
    path: "/v1/auth/reauth",
    tags: ["auth"],
    summary: "Re-authenticate",
    security: sessionAuth,
    request: body(ReauthBody),
    responses: { 200: json(ReauthResultSchema), ...errors(400, 401, 429) },
  },
);

/** Every account security route, by name. */
export const AUTH_ROUTES = { getSecurityStatus, reauthenticate } as const;
