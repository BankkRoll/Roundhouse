/**
 * Tables owned by Better Auth (users, sessions, accounts, verifications, and
 * the two-factor plugin's table), plus the per-account sign-in lockout
 * state. Property names of Better Auth tables must match Better Auth's field
 * names exactly (it addresses columns through Drizzle keys, not SQL names);
 * the SQL column names follow our snake_case convention.
 *
 * @module
 */
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { id, timestamp, timestamps } from "./columns";

/** Registered user accounts. */
export const users = sqliteTable("users", {
  id: id(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  /**
   * Grants the install-wide actions (`instance:manage`, `workspaces:create`).
   * Set for the setup user; the migration backfills the earliest owner.
   * Not a Better Auth field, so Better Auth never writes it.
   */
  instanceAdmin: integer("instance_admin", { mode: "boolean" }).notNull().default(false),
  /** Better Auth two-factor plugin field. */
  twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" }).notNull().default(false),
  ...timestamps,
});

/** Active browser sessions. */
export const sessions = sqliteTable(
  "sessions",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    /**
     * Last re-authentication (`POST /v1/auth/reauth`). A session is fresh for
     * dangerous actions within `REAUTH_WINDOW_MS` of the later of this and
     * `created_at`. Not a Better Auth field.
     */
    reauthenticatedAt: timestamp("reauthenticated_at"),
    ...timestamps,
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

/** Credential and OAuth links for a user (one row per provider). */
export const accounts = sqliteTable(
  "accounts",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (t) => [index("accounts_user_id_idx").on(t.userId)],
);

/** Short-lived verification values (email verification, password reset, magic links). */
export const verifications = sqliteTable(
  "verifications",
  {
    id: id(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    ...timestamps,
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

/**
 * Better Auth two-factor plugin table (model `twoFactor`): the TOTP secret
 * and backup codes, both encrypted by Better Auth with the auth secret.
 */
export const twoFactors = sqliteTable(
  "two_factors",
  {
    id: id(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `false` until the first code is verified after enabling. */
    verified: integer("verified", { mode: "boolean" }).notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until"),
    ...timestamps,
  },
  (t) => [
    index("two_factors_user_id_idx").on(t.userId),
    index("two_factors_secret_idx").on(t.secret),
  ],
);

/**
 * Failed sign-in counter per account, for exponential lockout (see
 * `recordLoginFailure` in `@roundhouse/shared`). Keyed by a hash of the
 * normalised email, so unknown emails lock the same way and the table holds
 * no addresses.
 */
export const loginAttempts = sqliteTable(
  "login_attempts",
  {
    /** Lowercase hex SHA-256 of `email.trim().toLowerCase()`. */
    id: text("id").primaryKey(),
    failures: integer("failures").notNull().default(0),
    lastFailureAt: timestamp("last_failure_at").notNull(),
    lockedUntil: timestamp("locked_until"),
    ...timestamps,
  },
  (t) => [index("login_attempts_last_failure_idx").on(t.lastFailureAt)],
);
