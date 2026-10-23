/**
 * Better Auth configuration. Constructed per request because bindings
 * (D1, secrets) are only available on the request's `env`.
 *
 * - Secrets come from the master keyring with key format 2
 *   (`lib/auth-secrets.ts`): the current key signs, every key decrypts.
 * - Two-factor (TOTP and backup codes) is Better Auth's `twoFactor` plugin;
 *   `lib/auth-hooks.ts` adds lockout, sign-in audit, replay protection and
 *   hashed backup codes around it (ADR 0014 "Auth").
 *
 * @module
 */
import { accounts, type Db, sessions, twoFactors, users, verifications } from "@roundhouse/db";
import { isIdKind, newId, PRODUCT_NAME } from "@roundhouse/shared";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins/two-factor";
import { securityHooks } from "./lib/auth-hooks";
import { authSecretsFor } from "./lib/auth-secrets";
import type { KeyEnv } from "./lib/keyring";
import { TOTP_DIGITS, TOTP_PERIOD_S } from "./lib/totp";
import { BACKUP_CODE_COUNT, backupCodeStorage } from "./lib/two-factor";

/**
 * Better Auth endpoints the control plane turns off.
 *
 * - Sessions are listed and revoked through `/v1/auth/sessions`, which
 *   never hands session tokens to page scripts (the cookie is `HttpOnly`)
 *   and audits revocations.
 * - Reading the TOTP URI back would let anyone holding a session and the
 *   password copy the secret and pass the second factor forever.
 * - Email/SMS one-time codes aren't configured.
 */
export const DISABLED_AUTH_PATHS = [
  "/list-sessions",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/two-factor/get-totp-uri",
  "/two-factor/send-otp",
  "/two-factor/verify-otp",
];

/** Options that vary per call site. */
export interface AuthOptions {
  /**
   * Public sign-up is always closed: accounts are created by the setup wizard
   * or by accepting an invite, and only those code paths pass `true`.
   */
  allowSignUp?: boolean;
}

/** Longest display name stored; matches the API's own `name` fields. */
export const MAX_NAME_LENGTH = 100;

/**
 * Normalises the profile fields of a user write: trims and caps `name`, and
 * only lets `image` be `null` or an `https:` URL so it is safe to render as an
 * `<img src>`. Fields absent from `user` stay absent.
 *
 * @param user - The fields Better Auth is about to write.
 * @returns The normalised `name`/`image` fields that were present.
 * @throws {APIError} `BAD_REQUEST` for an empty name or a disallowed image URL.
 */
export function boundedProfile(user: { name?: unknown; image?: unknown }): {
  name?: string;
  image?: string | null;
} {
  const out: { name?: string; image?: string | null } = {};
  if (user.name !== undefined) {
    const name =
      typeof user.name === "string" ? user.name.trim().slice(0, MAX_NAME_LENGTH).trim() : "";
    if (!name) throw new APIError("BAD_REQUEST", { message: "Name is required" });
    out.name = name;
  }
  if (user.image !== undefined) {
    out.image = user.image === null || user.image === "" ? null : httpsUrl(user.image);
  }
  return out;
}

function httpsUrl(value: unknown): string {
  if (typeof value === "string" && value.length <= 2048 && URL.canParse(value)) {
    const url = new URL(value);
    if (url.protocol === "https:") return url.href;
  }
  throw new APIError("BAD_REQUEST", { message: "Image must be an https: URL" });
}

/**
 * Creates a Better Auth instance bound to this request.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings; the auth secrets are derived from them.
 * @param origin - Public origin of the control plane (e.g. `https://cp.example.com`).
 * @param options - Per-call options.
 * @returns A configured Better Auth instance.
 */
export async function createAuth(db: Db, keys: KeyEnv, origin: string, options: AuthOptions = {}) {
  const { secrets, config } = await authSecretsFor(keys);
  return betterAuth({
    appName: PRODUCT_NAME,
    secrets,
    baseURL: origin,
    basePath: "/api/auth",
    trustedOrigins: [origin],
    disabledPaths: DISABLED_AUTH_PATHS,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        twoFactor: twoFactors,
      },
    }),
    plugins: [
      twoFactor({
        issuer: PRODUCT_NAME,
        totpOptions: { digits: TOTP_DIGITS, period: TOTP_PERIOD_S },
        backupCodeOptions: {
          amount: BACKUP_CODE_COUNT,
          storeBackupCodes: backupCodeStorage(config),
        },
      }),
      securityHooks({ db, keys }),
    ],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      disableSignUp: !options.allowSignUp,
    },
    // Better Auth's built-in limiter keeps counters in isolate memory, which
    // doesn't hold on Workers; `rateLimitSecrets` uses the platform binding.
    rateLimit: { enabled: false },
    // SECURITY: Better Auth's own endpoints (e.g. `/update-user`) write the
    // profile without our route schemas, so the bounds are enforced here, on
    // every write path.
    databaseHooks: {
      user: {
        create: { before: async (user) => ({ data: { ...user, ...boundedProfile(user) } }) },
        update: { before: async (user) => ({ data: { ...user, ...boundedProfile(user) } }) },
      },
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      database: {
        generateId: ({ model }) => (isIdKind(model) ? newId(model) : false),
      },
    },
  });
}
