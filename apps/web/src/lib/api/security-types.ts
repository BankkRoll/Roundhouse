/**
 * Wire types of account security: the caller's two-factor and freshness state, their
 * sessions, and Better Auth's two-factor endpoints. Mirrors
 * `apps/api/src/schemas/auth.ts` and Better Auth's `twoFactor` plugin.
 *
 * @module
 */

/** `GET /v1/auth/security`. */
export interface SecurityStatus {
  two_factor_enabled: boolean;
  /** Instance admins and workspace owners/admins must enroll before changing anything. */
  two_factor_required: boolean;
  /** Unused backup codes left; `null` while two-factor is off. */
  backup_codes_remaining: number | null;
  instance_admin: boolean;
  /** Until when dangerous actions need no re-authentication (Unix ms); `null` when now. */
  fresh_until: number | null;
}

/** One of the caller's sessions (`GET /v1/auth/sessions`). Never carries its token. */
export interface AccountSession {
  id: string;
  /** The session this browser is using. */
  current: boolean;
  ip_address: string | null;
  user_agent: string | null;
  created_at: number;
  expires_at: number;
}

/** `POST /v1/auth/reauth` body. `code` is required while two-factor is on. */
export interface ReauthRequest {
  password: string;
  code?: string;
}

/** `POST /api/auth/two-factor/enable` response: shown once, never stored by the dashboard. */
export interface TwoFactorEnrollment {
  /** `otpauth://totp/…` URI for the authenticator app (rendered as a QR code locally). */
  totpURI: string;
  /** Ten single-use backup codes in plain text; the server keeps only hashes. */
  backupCodes: string[];
}
