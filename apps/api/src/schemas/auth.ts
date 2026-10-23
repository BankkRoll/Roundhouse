/**
 * Account security schemas (ADR 0014 "Auth"): two-factor status,
 * re-authentication, and sessions. Better Auth's own `/api/auth/two-factor/*`
 * endpoints do enrollment and verification; these routes add what it lacks.
 * Owned by the api-auth stream; re-exported from `../schemas`.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";

const Millis = z.number().int().openapi({ description: "Unix time in milliseconds" });

/** The caller's security posture, read by the dashboard after sign-in. */
export const SecurityStatusSchema = z
  .object({
    two_factor_enabled: z.boolean(),
    /** Instance admins and workspace owners/admins must enroll. */
    two_factor_required: z.boolean(),
    /** Unused backup codes left; `null` when 2FA is off. */
    backup_codes_remaining: z.number().int().nonnegative().nullable(),
    instance_admin: z.boolean(),
    /** Until when this session counts as fresh for dangerous actions; `null` when it doesn't. */
    fresh_until: Millis.nullable(),
  })
  .openapi("SecurityStatus");

/**
 * Body of `POST /v1/auth/reauth`. `code` is a TOTP or backup code, required
 * when the user has 2FA enabled.
 */
export const ReauthBody = z
  .object({
    password: z.string().min(1).max(256),
    code: z.string().min(6).max(32).optional(),
  })
  .openapi("Reauth");

/** Response of `POST /v1/auth/reauth`. */
export const ReauthResultSchema = z.object({ fresh_until: Millis }).openapi("ReauthResult");

/** One of the caller's sessions. */
export const SessionSchema = z
  .object({
    id: z.string(),
    current: z.boolean(),
    ip_address: z.string().nullable(),
    user_agent: z.string().nullable(),
    created_at: Millis,
    expires_at: Millis,
  })
  .openapi("Session");
