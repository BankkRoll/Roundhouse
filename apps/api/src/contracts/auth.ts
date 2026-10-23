/**
 * Account security routes (ADR 0014 "Auth"). Two-factor enrollment,
 * verification and backup codes are Better Auth's own
 * `/api/auth/two-factor/*` endpoints; these routes add what it lacks:
 * security status, re-authentication, sessions without tokens, and the
 * instance admin's recovery tools. Owned by the api-auth stream.
 *
 * `action: null` with `auth: "session"` means any signed-in user (browser
 * sessions only; the handlers refuse API tokens).
 *
 * @module
 */
import { body, errors, json, sessionAuth, sessionOnlyAuth } from "../schemas";
import {
  ClearLockoutBody,
  ClearLockoutResultSchema,
  ReauthBody,
  ReauthResultSchema,
  SecurityStatusSchema,
  SessionListSchema,
  SessionParams,
  SessionsRevokedSchema,
  UserParams,
} from "../schemas/auth";
import { defineRoute, sessionOnly } from "./policy";

/** The caller's two-factor and freshness state. Exempt from the two-factor gate. */
export const getSecurityStatus = defineRoute(
  { auth: "session", action: null, audit: [] },
  {
    method: "get",
    path: "/v1/auth/security",
    tags: ["auth"],
    summary: "Get my security status",
    security: sessionAuth,
    responses: { 200: json(SecurityStatusSchema), ...errors(401, 403) },
  },
);

/**
 * Re-enters the password (and a TOTP or backup code when 2FA is on) to make
 * the session fresh for `REAUTH_WINDOW_MS`. Counts toward the sign-in
 * lockout on failure. Exempt from the two-factor gate.
 */
export const reauthenticate = defineRoute(
  {
    auth: "session",
    action: null,
    audit: [
      "auth.reauthenticated",
      "auth.sign_in_failed",
      "auth.two_factor_failed",
      "auth.account_locked",
      "auth.backup_code_used",
    ],
  },
  {
    method: "post",
    path: "/v1/auth/reauth",
    tags: ["auth"],
    summary: "Re-authenticate",
    security: sessionAuth,
    request: body(ReauthBody),
    responses: { 200: json(ReauthResultSchema), ...errors(400, 401, 403, 429) },
  },
);

/** The caller's sessions, without their tokens. */
export const listSessions = defineRoute(
  { auth: "session", action: null, audit: [] },
  {
    method: "get",
    path: "/v1/auth/sessions",
    tags: ["auth"],
    summary: "List my sessions",
    security: sessionAuth,
    responses: { 200: json(SessionListSchema), ...errors(401, 403) },
  },
);

/** Ends one of the caller's sessions (the current one signs them out). */
export const revokeSession = defineRoute(
  { auth: "session", action: null, audit: ["auth.session_revoked"] },
  {
    method: "delete",
    path: "/v1/auth/sessions/{sessionId}",
    tags: ["auth"],
    summary: "Revoke one of my sessions",
    security: sessionAuth,
    request: { params: SessionParams },
    responses: { 204: { description: "Revoked" }, ...errors(401, 403, 404) },
  },
);

/** Ends every session of the caller except the current one. */
export const revokeOtherSessions = defineRoute(
  { auth: "session", action: null, audit: ["auth.session_revoked"] },
  {
    method: "delete",
    path: "/v1/auth/sessions",
    tags: ["auth"],
    summary: "Revoke my other sessions",
    security: sessionAuth,
    responses: { 200: json(SessionsRevokedSchema), ...errors(401, 403) },
  },
);

/**
 * Lifts the sign-in lockout of an email address before it expires. Answers
 * the same for unknown addresses, which lock like real ones.
 */
export const clearSignInLockout = defineRoute(
  sessionOnly("instance:manage", ["auth.account_unlocked"]),
  {
    method: "post",
    path: "/v1/instance/sign-in-lockouts/clear",
    tags: ["instance"],
    summary: "Clear a sign-in lockout",
    security: sessionOnlyAuth,
    request: body(ClearLockoutBody),
    responses: { 200: json(ClearLockoutResultSchema), ...errors(400, 401, 403) },
  },
);

/**
 * Turns off another user's two-factor authentication (a lost device and no
 * backup codes left). They must enroll again before their next change if
 * their role requires it, and every session of theirs is ended.
 */
export const resetUserTwoFactor = defineRoute(
  sessionOnly("instance:manage", ["auth.two_factor_reset"], { reauth: true }),
  {
    method: "delete",
    path: "/v1/instance/users/{userId}/two-factor",
    tags: ["instance"],
    summary: "Reset a user's two-factor authentication",
    security: sessionOnlyAuth,
    request: { params: UserParams },
    responses: { 204: { description: "Reset" }, ...errors(401, 403, 404) },
  },
);

/** Every account security route, by name. */
export const AUTH_ROUTES = {
  getSecurityStatus,
  reauthenticate,
  listSessions,
  revokeSession,
  revokeOtherSessions,
  clearSignInLockout,
  resetUserTwoFactor,
} as const;
