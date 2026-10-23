/**
 * Two-factor material and verification outside Better Auth's own endpoints
 * (ADR 0014 "Auth"):
 *
 * - Backup codes are stored as SHA-256 hashes inside Better Auth's encrypted
 *   envelope ({@link backupCodeStorage}), so neither a database dump nor the
 *   master key gives back a usable code.
 * - {@link verifySecondFactor} checks a TOTP or backup code for a user, for
 *   `POST /v1/auth/reauth` and any route guard that wants a second factor.
 * - {@link claimTotpStep} makes each TOTP time step usable once per user.
 * - {@link rewrapTwoFactorBatch} re-encrypts the material under the current
 *   master key during key rotation.
 *
 * Better Auth encrypts the TOTP secret and backup codes with its secret,
 * which `./auth-secrets` derives from the keyring with key format 2.
 *
 * @module
 */
import { type Db, twoFactors, users } from "@roundhouse/db";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { type AuthSecretConfig, authSecretsFor } from "./auth-secrets";
import type { KeyEnv } from "./keyring";
import { matchTotpStep } from "./totp";

const encoder = new TextEncoder();

/** Prefix of a stored backup code hash, telling it apart from a plain code. */
export const BACKUP_CODE_HASH_PREFIX = "sha256:";

/** How many backup codes enrollment and regeneration hand out. */
export const BACKUP_CODE_COUNT = 10;

/**
 * Normalises a backup code as typed: surrounding whitespace dropped, and the
 * dash Better Auth prints (`abcde-12345`) restored when it was left out.
 * Codes are case-sensitive.
 *
 * @param code - The code as entered.
 * @returns The canonical form.
 */
export function normalizeBackupCode(code: string): string {
  const trimmed = code.trim();
  return /^[A-Za-z0-9]{10}$/.test(trimmed) ? `${trimmed.slice(0, 5)}-${trimmed.slice(5)}` : trimmed;
}

/**
 * The stored form of a backup code.
 *
 * Backup codes carry about 59 bits of entropy and sit inside an encrypted
 * envelope, so an unsalted fast hash is enough to make the stored list
 * useless without the codes themselves.
 *
 * @param code - A plain backup code.
 * @returns `sha256:<hex>` of its canonical form.
 */
export async function hashBackupCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(normalizeBackupCode(code)));
  return `${BACKUP_CODE_HASH_PREFIX}${[...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * Better Auth's `backupCodeOptions.storeBackupCodes` for this install:
 * hashes every plain code, then encrypts the list.
 *
 * Better Auth hands `encrypt` the plain codes when it generates them and the
 * already hashed survivors after one is used, so only plain entries are
 * hashed. Its verifier compares the entered code with the stored entries, so
 * the `/two-factor/verify-backup-code` hook replaces the entered code with
 * {@link hashBackupCode} first.
 *
 * @param config - Better Auth's secret config (`authSecretsFor(...).config`).
 * @returns The custom `encrypt`/`decrypt` pair.
 */
export function backupCodeStorage(config: AuthSecretConfig) {
  return {
    async encrypt(json: string): Promise<string> {
      const codes = JSON.parse(json) as string[];
      const stored = await Promise.all(
        codes.map((c) => (c.startsWith(BACKUP_CODE_HASH_PREFIX) ? c : hashBackupCode(c))),
      );
      return symmetricEncrypt({ key: config, data: JSON.stringify(stored) });
    },
    decrypt(data: string): Promise<string> {
      return symmetricDecrypt({ key: config, data });
    },
  };
}

async function storedCodes(config: AuthSecretConfig, data: string): Promise<string[]> {
  const parsed: unknown = JSON.parse(await symmetricDecrypt({ key: config, data }));
  return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === "string") : [];
}

/** A user's two-factor state, as the security page shows it. */
export interface TwoFactorState {
  enabled: boolean;
  /** Unused backup codes; `null` when two-factor is off. */
  backupCodesRemaining: number | null;
}

/**
 * Reads whether a user has two-factor on and how many backup codes are left.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @param userId - The user.
 * @returns Their state.
 */
export async function twoFactorState(
  db: Db,
  keys: KeyEnv,
  userId: string,
): Promise<TwoFactorState> {
  const [row] = await db
    .select({ enabled: users.twoFactorEnabled, backupCodes: twoFactors.backupCodes })
    .from(users)
    .leftJoin(twoFactors, and(eq(twoFactors.userId, users.id), eq(twoFactors.verified, true)))
    .where(eq(users.id, userId))
    .limit(1);
  if (!row?.enabled || !row.backupCodes) return { enabled: false, backupCodesRemaining: null };
  const { config } = await authSecretsFor(keys);
  return {
    enabled: true,
    backupCodesRemaining: (await storedCodes(config, row.backupCodes)).length,
  };
}

/**
 * Marks a TOTP time step as used for a user. Steps only move forward, so a
 * code from this step or an earlier one can't be used again.
 *
 * @param db - Database client.
 * @param userId - The user.
 * @param step - The step the code matched.
 * @returns `false` when the step (or a later one) was already used.
 */
export async function claimTotpStep(db: Db, userId: string, step: number): Promise<boolean> {
  const claimed = await db
    .update(twoFactors)
    .set({ lastTotpStep: step })
    .where(
      and(
        eq(twoFactors.userId, userId),
        or(isNull(twoFactors.lastTotpStep), lt(twoFactors.lastTotpStep, step)),
      ),
    )
    .returning({ id: twoFactors.id });
  return claimed.length > 0;
}

/**
 * Finds which time step a TOTP code matches for a user, without claiming it.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @param userId - The user.
 * @param code - The code entered.
 * @param now - Unix ms.
 * @returns The step, or `null` when the user has no secret or the code is wrong.
 */
export async function totpStepFor(
  db: Db,
  keys: KeyEnv,
  userId: string,
  code: string,
  now = Date.now(),
): Promise<number | null> {
  const [row] = await db
    .select({ secret: twoFactors.secret })
    .from(twoFactors)
    .where(eq(twoFactors.userId, userId))
    .limit(1);
  if (!row) return null;
  const { config } = await authSecretsFor(keys);
  return matchTotpStep(await symmetricDecrypt({ key: config, data: row.secret }), code, now);
}

/** A second factor that {@link verifySecondFactor} accepted. */
export interface SecondFactor {
  method: "totp" | "backup_code";
  /** Backup codes left after this one was used; only for `backup_code`. */
  backupCodesRemaining?: number;
}

/**
 * Checks a second factor for a user who has two-factor enabled: a 6-digit
 * TOTP code, or one of their backup codes.
 *
 * The hook for anything that wants proof of the second factor beyond the
 * session (re-authentication, a route guard asking for it again). It has
 * side effects that make each factor single-use: a TOTP code's time step is
 * claimed and a backup code is consumed. It does **not** count failures
 * toward the sign-in lockout or write audit entries; callers do that
 * (`recordLoginFailure` and `auth.two_factor_failed` /
 * `auth.backup_code_used`), as `POST /v1/auth/reauth` does.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings (`c.env`).
 * @param userId - The user.
 * @param code - The code entered.
 * @param now - Unix ms.
 * @returns The factor used, or `null` when two-factor is off or the code is
 *   wrong, replayed or already used.
 * @example
 * const factor = await verifySecondFactor(c.get("db"), c.env, user.id, body.code);
 * if (!factor) throw new ApiError(401, "unauthorized", "Incorrect code");
 */
export async function verifySecondFactor(
  db: Db,
  keys: KeyEnv,
  userId: string,
  code: string,
  now = Date.now(),
): Promise<SecondFactor | null> {
  const [row] = await db
    .select({ id: twoFactors.id, secret: twoFactors.secret, backupCodes: twoFactors.backupCodes })
    .from(twoFactors)
    .innerJoin(users, eq(users.id, twoFactors.userId))
    .where(
      and(
        eq(twoFactors.userId, userId),
        eq(twoFactors.verified, true),
        eq(users.twoFactorEnabled, true),
      ),
    )
    .limit(1);
  if (!row) return null;
  const { config } = await authSecretsFor(keys);
  const entered = code.trim();

  if (/^\d{6}$/.test(entered)) {
    const secret = await symmetricDecrypt({ key: config, data: row.secret });
    const step = await matchTotpStep(secret, entered, now);
    if (step === null || !(await claimTotpStep(db, userId, step))) return null;
    return { method: "totp" };
  }

  const hashed = await hashBackupCode(entered);
  const codes = await storedCodes(config, row.backupCodes);
  if (!codes.includes(hashed)) return null;
  const remaining = codes.filter((c) => c !== hashed);
  // SECURITY: Compare-and-swap on the ciphertext, so two concurrent requests
  // can't both spend the same backup code.
  const spent = await db
    .update(twoFactors)
    .set({ backupCodes: await symmetricEncrypt({ key: config, data: JSON.stringify(remaining) }) })
    .where(and(eq(twoFactors.id, row.id), eq(twoFactors.backupCodes, row.backupCodes)))
    .returning({ id: twoFactors.id });
  if (spent.length === 0) return null;
  return { method: "backup_code", backupCodesRemaining: remaining.length };
}

/**
 * Counts the backup codes a stored list holds, for audit metadata after
 * Better Auth's own endpoint consumed one.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @param userId - The user.
 * @returns Codes left, or `null` without a two-factor row.
 */
export async function backupCodesRemaining(
  db: Db,
  keys: KeyEnv,
  userId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ backupCodes: twoFactors.backupCodes })
    .from(twoFactors)
    .where(eq(twoFactors.userId, userId))
    .limit(1);
  if (!row) return null;
  const { config } = await authSecretsFor(keys);
  return (await storedCodes(config, row.backupCodes)).length;
}

// -----------------------------------------------------------------------------
// Key rotation
// -----------------------------------------------------------------------------

/** Rows {@link rewrapTwoFactorBatch} handles per call. */
export const TWO_FACTOR_REWRAP_BATCH = 100;

const envelopeOf = (version: number) => `$ba$${version}$%`;

/**
 * SQL condition for a two-factor row with material not under the current
 * auth secret version.
 *
 * @param currentVersion - The current Better Auth secret version.
 * @returns A condition for `where`.
 */
export function staleTwoFactorCondition(currentVersion: number) {
  const prefix = envelopeOf(currentVersion);
  return sql`(${twoFactors.secret} NOT LIKE ${prefix} OR ${twoFactors.backupCodes} NOT LIKE ${prefix})`;
}

/**
 * Re-encrypts up to {@link TWO_FACTOR_REWRAP_BATCH} users' TOTP secrets and
 * backup codes under the current master key, so `MASTER_KEYS_PREVIOUS` can
 * be emptied without locking anyone out of two-factor. Idempotent; each row
 * is replaced only if it didn't change meanwhile.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @returns How many rows needed work; `0` when none are left.
 */
export async function rewrapTwoFactorBatch(db: Db, keys: KeyEnv): Promise<number> {
  const { config } = await authSecretsFor(keys);
  const rows = await db
    .select({ id: twoFactors.id, secret: twoFactors.secret, backupCodes: twoFactors.backupCodes })
    .from(twoFactors)
    .where(staleTwoFactorCondition(config.currentVersion))
    .limit(TWO_FACTOR_REWRAP_BATCH);
  for (const row of rows) {
    const reencrypt = async (data: string) =>
      symmetricEncrypt({ key: config, data: await symmetricDecrypt({ key: config, data }) });
    await db
      .update(twoFactors)
      .set({ secret: await reencrypt(row.secret), backupCodes: await reencrypt(row.backupCodes) })
      .where(
        and(
          eq(twoFactors.id, row.id),
          eq(twoFactors.secret, row.secret),
          eq(twoFactors.backupCodes, row.backupCodes),
        ),
      );
  }
  return rows.length;
}
