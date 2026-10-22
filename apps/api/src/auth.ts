/**
 * Better Auth configuration. Constructed per request because bindings
 * (D1, secrets) are only available on the request's `env`.
 *
 * @module
 */
import { accounts, type Db, sessions, users, verifications } from "@openrail/db";
import { toBase64 } from "@openrail/protocol";
import { isIdKind, newId } from "@openrail/shared";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { deriveKey } from "./lib/crypto";

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
 * @param masterKey - Base64 master key; the auth secret is derived from it.
 * @param origin - Public origin of the control plane (e.g. `https://cp.example.com`).
 * @param options - Per-call options.
 * @returns A configured Better Auth instance.
 */
export async function createAuth(
  db: Db,
  masterKey: string,
  origin: string,
  options: AuthOptions = {},
) {
  const secret = toBase64(await deriveKey(masterKey, "auth-secret"));
  return betterAuth({
    secret,
    baseURL: origin,
    basePath: "/api/auth",
    trustedOrigins: [origin],
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
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
