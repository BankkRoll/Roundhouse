/**
 * Install-wide settings: the first-run setup lock and completion marker, the
 * control-plane signing key, and the ingress settings (`apps_domain`, `tls_mode`).
 *
 * @module
 */
import { type Db, instanceSettings } from "@openrail/db";
import { generateSigningKey, importSigningKey } from "@openrail/protocol";
import { DEFAULT_TLS_MODE, TLS_MODES, type TlsMode } from "@openrail/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { seal, unseal } from "./crypto";

/** Keys used in `instance_settings`. */
export const SettingKey = {
  setupLock: "setup_lock",
  setupCompletedAt: "setup_completed_at",
  signingKey: "signing_key",
  /** Parent domain of generated hostnames (a string); unset until an owner sets it. */
  appsDomain: "apps_domain",
  /** Ingress TLS mode (`TlsMode`); `DEFAULT_TLS_MODE` when unset. */
  tlsMode: "tls_mode",
  /** GitHub App credentials from the manifest flow, sealed like the signing key. */
  githubApp: "github_app",
  /** Pending manifest-flow state token and its expiry, checked by the callback. */
  githubManifestState: "github_manifest_state",
} as const;

/**
 * Age after which a setup lock is presumed abandoned. Setup finishes in well
 * under a second, so a lock this old means the isolate died mid-setup.
 */
export const SETUP_LOCK_TTL_MS = 120_000;

const StoredSigningKeySchema = z.object({
  kid: z.string(),
  public_key: z.string(),
  private_key: z.object({ v: z.literal(1), iv: z.string(), ct: z.string() }),
});

type StoredSigningKey = z.infer<typeof StoredSigningKeySchema>;

/** The signing key ready for use. */
export interface SigningKey {
  kid: string;
  publicKey: string;
  privateKey: CryptoKey;
}

/**
 * Reads a setting.
 *
 * @param db - Database client.
 * @param key - Setting key.
 * @returns The stored value, or `undefined` when unset.
 */
export async function getSetting<T>(db: Db, key: string): Promise<T | undefined> {
  const row = await db.query.instanceSettings.findFirst({ where: eq(instanceSettings.key, key) });
  return row?.value as T | undefined;
}

/**
 * Whether the first-run setup wizard has completed.
 *
 * @param db - Database client.
 * @returns `true` once setup has written its completion marker.
 */
export async function isSetupComplete(db: Db): Promise<boolean> {
  return (await getSetting(db, SettingKey.setupCompletedAt)) !== undefined;
}

/**
 * Takes the single-shot setup lock.
 *
 * The lock is a primary-key row, so concurrent claims serialise on the insert.
 * A lock older than {@link SETUP_LOCK_TTL_MS} is taken over in the same
 * statement, but only while setup hasn't completed, so a crashed attempt can't
 * block the install forever and a finished one can't be re-run.
 *
 * @param db - Database client.
 * @param now - Current time, unix ms; doubles as the lock's identity.
 * @returns The lock token to pass to {@link releaseSetupLock}, or `undefined`
 *   when another attempt holds the lock or setup is already done.
 */
export async function claimSetupLock(db: Db, now = Date.now()): Promise<number | undefined> {
  const [row] = await db
    .insert(instanceSettings)
    .values({ key: SettingKey.setupLock, value: now })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: { value: now, updatedAt: new Date(now) },
      setWhere: sql`CAST(${instanceSettings.value} AS INTEGER) < ${now - SETUP_LOCK_TTL_MS}
        AND NOT EXISTS (SELECT 1 FROM instance_settings AS done WHERE done.key = ${SettingKey.setupCompletedAt})`,
    })
    .returning({ key: instanceSettings.key });
  return row ? now : undefined;
}

/**
 * Releases a setup lock taken by {@link claimSetupLock}. A no-op if the lock
 * has since been reclaimed by another attempt.
 *
 * @param db - Database client.
 * @param token - Value returned when the lock was claimed.
 */
export async function releaseSetupLock(db: Db, token: number): Promise<void> {
  await db
    .delete(instanceSettings)
    .where(
      and(
        eq(instanceSettings.key, SettingKey.setupLock),
        sql`CAST(${instanceSettings.value} AS INTEGER) = ${token}`,
      ),
    );
}

/**
 * Generates and stores the control-plane signing key. The private half is
 * sealed under the master-derived KEK.
 *
 * @param db - Database client.
 * @param masterKey - Base64 master key.
 * @returns The new public key, base64.
 */
export async function createSigningKey(db: Db, masterKey: string): Promise<string> {
  const keys = await generateSigningKey();
  const kid = `k${Date.now().toString(36)}`;
  const value: StoredSigningKey = {
    kid,
    public_key: keys.publicKey,
    private_key: await seal(masterKey, keys.privateKey, `setting:${SettingKey.signingKey}`),
  };
  await db
    .insert(instanceSettings)
    .values({ key: SettingKey.signingKey, value })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value } });
  cached = undefined;
  return keys.publicKey;
}

// PERF: Every join and every signed control frame needs the key. Caching it
// skips a D1 read, an AES-GCM unseal, and a key import on each of them.
let cached: Promise<SigningKey> | undefined;

/**
 * Loads the signing key, caching it for the lifetime of the isolate.
 *
 * @param db - Database client.
 * @param masterKey - Base64 master key.
 * @returns The usable signing key.
 * @throws When setup hasn't created a key yet or the stored key is corrupt.
 */
export function loadSigningKey(db: Db, masterKey: string): Promise<SigningKey> {
  cached ??= (async () => {
    const raw = await getSetting<unknown>(db, SettingKey.signingKey);
    if (raw === undefined) throw new Error("signing key not initialised; run setup first");
    const stored = StoredSigningKeySchema.parse(raw);
    const pkcs8 = await unseal(masterKey, stored.private_key, `setting:${SettingKey.signingKey}`);
    return {
      kid: stored.kid,
      publicKey: stored.public_key,
      privateKey: await importSigningKey(pkcs8),
    };
  })().catch((err) => {
    cached = undefined;
    throw err;
  });
  return cached;
}

// -----------------------------------------------------------------------------
// Ingress settings
// -----------------------------------------------------------------------------

/** Install-wide ingress settings as handlers use them. */
export interface IngressSettings {
  appsDomain: string | null;
  tlsMode: TlsMode;
}

/**
 * Reads `apps_domain` and `tls_mode`, applying defaults for unset keys.
 *
 * @param db - Database client.
 * @returns The effective ingress settings.
 */
export async function getIngressSettings(db: Db): Promise<IngressSettings> {
  const rows = await db
    .select()
    .from(instanceSettings)
    .where(inArray(instanceSettings.key, [SettingKey.appsDomain, SettingKey.tlsMode]));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const appsDomain = byKey.get(SettingKey.appsDomain);
  const tlsMode = byKey.get(SettingKey.tlsMode);
  return {
    appsDomain: typeof appsDomain === "string" ? appsDomain : null,
    tlsMode: (TLS_MODES as readonly unknown[]).includes(tlsMode)
      ? (tlsMode as TlsMode)
      : DEFAULT_TLS_MODE,
  };
}

/**
 * Writes one setting, creating or replacing it. `null` deletes it.
 *
 * @param db - Database client.
 * @param key - Setting key.
 * @param value - New value, or `null` to unset.
 * @returns The statement, for `db.batch`.
 */
export function putSetting(db: Db, key: string, value: unknown) {
  if (value === null) return db.delete(instanceSettings).where(eq(instanceSettings.key, key));
  return db
    .insert(instanceSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value, updatedAt: new Date() } });
}
