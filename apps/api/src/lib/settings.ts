/**
 * Install-wide settings: the first-run setup lock and completion marker, the
 * setting keys of the control-plane signing keys (handled by
 * `./signing-keys`), the fingerprint secret, the ingress settings
 * (`apps_domain`, `tls_mode`), log retention, and whether the MCP endpoint
 * is enabled, and the mesh settings (`mesh_enabled`, `mesh_supernet`).
 *
 * @module
 */
import { type Db, instanceSettings } from "@roundhouse/db";
import { fromBase64, toBase64 } from "@roundhouse/protocol";
import {
  DEFAULT_LOG_RETENTION_DAYS,
  DEFAULT_TLS_MODE,
  MAX_LOG_RETENTION_DAYS,
  TLS_MODES,
  type TlsMode,
} from "@roundhouse/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type KeyEnv,
  SealedSchema,
  sealInstanceSecret,
  unsealInstanceSecret,
} from "./instance-secrets";

/** Keys used in `instance_settings`. */
export const SettingKey = {
  setupLock: "setup_lock",
  setupCompletedAt: "setup_completed_at",
  signingKey: "signing_key",
  /**
   * Random secret the workspaces' provider token fingerprint keys derive
   * from, sealed like the signing key; created on first use.
   */
  fingerprintSecret: "fingerprint_secret",
  /** A scheduled successor of `signing_key` and its `not_before` (ADR 0014 §13). */
  signingKeyNext: "signing_key_next",
  /** Public half and retirement time of the key the latest rollover replaced. */
  signingKeyRetired: "signing_key_retired",
  /** Parent domain of generated hostnames (a string); unset until an owner sets it. */
  appsDomain: "apps_domain",
  /** Ingress TLS mode (`TlsMode`); `DEFAULT_TLS_MODE` when unset. */
  tlsMode: "tls_mode",
  /** GitHub App credentials from the manifest flow, sealed like the signing key. */
  githubApp: "github_app",
  /** Pending manifest-flow state token and its expiry, checked by the callback. */
  githubManifestState: "github_manifest_state",
  /** Days logs are kept (an integer); `DEFAULT_LOG_RETENTION_DAYS` when unset. */
  logRetentionDays: "log_retention_days",
  /** Whether `/mcp` serves coding agents (a boolean); off when unset (ADR 0012). */
  mcpEnabled: "mcp_enabled",
  /**
   * S3-compatible bucket for backups (ADR 0004): endpoint, bucket, region,
   * access key ID, and the secret access key sealed like the signing key.
   * See `lib/backups/storage.ts`.
   */
  backupStorage: "backup_storage",
  /**
   * The CA the `managed` TLS mode orders from and the contact address
   * (ADR 0009). See `lib/certificates/settings.ts`.
   */
  acme: "acme",
  /** The control plane's ACME account: its URL and private key, sealed. */
  acmeAccount: "acme_account",
  /**
   * Zone and API token (sealed) for DNS-01 in the apps domain's zone, so the
   * apps wildcard and delegated custom wildcards can be issued.
   */
  cloudflareDns: "cloudflare_dns",
  /** Whether servers join the WireGuard mesh (a boolean); off when unset (ADR 0005). */
  meshEnabled: "mesh_enabled",
  /**
   * The mesh supernet (an IPv4 `/16`); `DEFAULT_MESH_SUPERNET` when unset.
   * Fixed once the first server joined the mesh.
   */
  meshSupernet: "mesh_supernet",
} as const;

/**
 * Age after which a setup lock is presumed abandoned. Setup finishes in well
 * under a second, so a lock this old means the isolate died mid-setup.
 */
export const SETUP_LOCK_TTL_MS = 120_000;

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

const StoredFingerprintSecretSchema = z.object({ secret: SealedSchema });

/**
 * Loads the instance fingerprint secret, creating it on first use. Keys
 * derived from it (`providerFingerprintKey`) don't change when `MASTER_KEY`
 * does: rotation re-wraps the secret but never replaces it.
 *
 * @param db - Database client.
 * @param keys - The master keyring bindings (`c.env`).
 * @returns The 32-byte secret. Never store or return it.
 */
export async function loadFingerprintSecret(
  db: Db,
  keys: KeyEnv,
): Promise<Uint8Array<ArrayBuffer>> {
  let raw = await getSetting<unknown>(db, SettingKey.fingerprintSecret);
  if (raw === undefined) {
    const fresh = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    const value = {
      secret: await sealInstanceSecret(keys, fresh, SettingKey.fingerprintSecret),
    };
    // Concurrent first uses race on the insert; whichever lands is the secret.
    await db
      .insert(instanceSettings)
      .values({ key: SettingKey.fingerprintSecret, value })
      .onConflictDoNothing();
    raw = await getSetting<unknown>(db, SettingKey.fingerprintSecret);
  }
  const stored = StoredFingerprintSecretSchema.parse(raw);
  return fromBase64(await unsealInstanceSecret(keys, stored.secret, SettingKey.fingerprintSecret));
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

// -----------------------------------------------------------------------------
// Log retention
// -----------------------------------------------------------------------------

/**
 * Reads `log_retention_days`, falling back to the default for an unset or
 * out-of-range value.
 *
 * @param db - Database client.
 * @returns Days logs are kept, between 1 and `MAX_LOG_RETENTION_DAYS`.
 */
export async function getLogRetentionDays(db: Db): Promise<number> {
  const value = await getSetting<unknown>(db, SettingKey.logRetentionDays);
  return Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_LOG_RETENTION_DAYS
    ? (value as number)
    : DEFAULT_LOG_RETENTION_DAYS;
}

// -----------------------------------------------------------------------------
// MCP
// -----------------------------------------------------------------------------

/**
 * Whether the MCP endpoint is enabled. Off unless an instance admin turned it
 * on, so a new install exposes no agent-facing surface by default.
 *
 * @param db - Database client.
 * @returns `true` only when `mcp_enabled` is stored as `true`.
 */
export async function getMcpEnabled(db: Db): Promise<boolean> {
  return (await getSetting<unknown>(db, SettingKey.mcpEnabled)) === true;
}

/** Supernet of the WireGuard mesh until an instance admin picks another (ADR 0005). */
export const DEFAULT_MESH_SUPERNET = "10.200.0.0/16";

/** The mesh's instance settings. */
export interface MeshSettings {
  /** Servers join the WireGuard mesh; off on new installs. */
  enabled: boolean;
  /** IPv4 `/16` the servers' `/24`s are carved from. */
  supernet: string;
}

/**
 * Reads the mesh settings.
 *
 * @param db - Database client.
 * @returns `mesh_enabled` (off when unset) and `mesh_supernet`
 *   ({@link DEFAULT_MESH_SUPERNET} when unset).
 */
export async function getMeshSettings(db: Db): Promise<MeshSettings> {
  const rows = await db
    .select()
    .from(instanceSettings)
    .where(inArray(instanceSettings.key, [SettingKey.meshEnabled, SettingKey.meshSupernet]));
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const supernet = byKey.get(SettingKey.meshSupernet);
  return {
    enabled: byKey.get(SettingKey.meshEnabled) === true,
    supernet: typeof supernet === "string" ? supernet : DEFAULT_MESH_SUPERNET,
  };
}
