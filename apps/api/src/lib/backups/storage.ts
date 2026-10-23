/**
 * The `backup_storage` instance setting (ADR 0004, "Storage"): the
 * S3-compatible bucket every backup goes to.
 *
 * Stored as `{ endpoint, bucket, region, access_key_id, secret_access_key }`
 * where `secret_access_key` is sealed like the other instance secrets
 * (`sealInstanceSecret`, field `secret_access_key`), so the key rotation
 * workflow re-wraps it. The secret is write-only: reads report only whether
 * one is set.
 *
 * @module
 */
import type { Db } from "@roundhouse/db";
import { z } from "zod";
import { ApiError } from "../errors";
import {
  type KeyEnv,
  SealedSchema,
  sealInstanceSecret,
  unsealInstanceSecret,
} from "../instance-secrets";
import type { S3Config } from "../s3";
import { getSetting, putSetting, SettingKey } from "../settings";

/** Field the secret access key is sealed under. */
const SECRET_FIELD = "secret_access_key";

/** Region R2 expects; also the default. */
export const DEFAULT_BACKUP_REGION = "auto";

const StoredBackupStorageSchema = z.object({
  endpoint: z.string(),
  bucket: z.string(),
  region: z.string(),
  access_key_id: z.string(),
  secret_access_key: SealedSchema,
});

/** The setting as stored. */
export type StoredBackupStorage = z.infer<typeof StoredBackupStorageSchema>;

/** The setting as callers may read it: everything but the secret. */
export interface BackupStorageView {
  configured: boolean;
  endpoint: string | null;
  bucket: string | null;
  region: string | null;
  access_key_id: string | null;
  /** Always `true` when configured; the secret itself is never returned. */
  secret_access_key_set: boolean;
}

/** New values for the setting. */
export interface BackupStorageInput {
  endpoint: string;
  bucket: string;
  region?: string | undefined;
  access_key_id: string;
  /** Omit to keep the stored secret (only when one is stored). */
  secret_access_key?: string | undefined;
}

/**
 * S3 bucket names (3–63 lowercase letters, digits, dots and hyphens) as R2
 * and MinIO accept them.
 */
export const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/**
 * Checks an S3 endpoint: an origin only (no path, query, fragment or
 * credentials), HTTPS unless `allowHttp` (local development).
 *
 * @param endpoint - Candidate endpoint.
 * @param allowHttp - Accept `http:` too.
 * @returns The normalised origin, or `null` when unacceptable.
 * @example
 * normalizeEndpoint("https://acc.r2.cloudflarestorage.com/", false); // "https://acc.r2.cloudflarestorage.com"
 */
export function normalizeEndpoint(endpoint: string, allowHttp: boolean): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

async function readStored(db: Db): Promise<StoredBackupStorage | null> {
  const raw = await getSetting<unknown>(db, SettingKey.backupStorage);
  if (raw === undefined) return null;
  const parsed = StoredBackupStorageSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Reads the setting without its secret.
 *
 * @param db - Database client.
 * @returns What is configured.
 */
export async function getBackupStorageView(db: Db): Promise<BackupStorageView> {
  const s = await readStored(db);
  return {
    configured: s !== null,
    endpoint: s?.endpoint ?? null,
    bucket: s?.bucket ?? null,
    region: s?.region ?? null,
    access_key_id: s?.access_key_id ?? null,
    secret_access_key_set: s !== null,
  };
}

/**
 * Loads the bucket configuration with its secret unsealed.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @returns The configuration, or `null` when unset. Never return it to a caller.
 */
export async function loadBackupStorage(db: Db, keys: KeyEnv): Promise<S3Config | null> {
  const s = await readStored(db);
  if (!s) return null;
  return {
    endpoint: s.endpoint,
    bucket: s.bucket,
    region: s.region,
    accessKeyId: s.access_key_id,
    secretAccessKey: await unsealInstanceSecret(
      keys,
      s.secret_access_key,
      SettingKey.backupStorage,
      SECRET_FIELD,
    ),
  };
}

/** The 409 every backup route answers without storage configured. */
export const storageNotConfigured = () =>
  new ApiError(
    409,
    "backup_storage_not_configured",
    "Backup storage is not configured; an instance admin sets it under Settings → Backups",
  );

/**
 * Loads the bucket configuration, or refuses.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @returns The configuration.
 * @throws {ApiError} 409 `backup_storage_not_configured`.
 */
export async function requireBackupStorage(db: Db, keys: KeyEnv): Promise<S3Config> {
  const config = await loadBackupStorage(db, keys);
  if (!config) throw storageNotConfigured();
  return config;
}

/**
 * Whether storage is configured, without unsealing anything.
 *
 * @param db - Database client.
 * @returns `true` when the setting is present and well-formed.
 */
export async function isBackupStorageConfigured(db: Db): Promise<boolean> {
  return (await readStored(db)) !== null;
}

/**
 * Builds the stored value for new settings, sealing a new secret or keeping
 * the stored one.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @param input - Validated values (endpoint already normalised).
 * @returns The value to store and the configuration it describes.
 * @throws {ApiError} 400 when no secret is given and none is stored.
 */
export async function prepareBackupStorage(
  db: Db,
  keys: KeyEnv,
  input: BackupStorageInput,
): Promise<{ stored: StoredBackupStorage; config: S3Config }> {
  const region = input.region ?? DEFAULT_BACKUP_REGION;
  if (input.secret_access_key !== undefined) {
    return {
      stored: {
        endpoint: input.endpoint,
        bucket: input.bucket,
        region,
        access_key_id: input.access_key_id,
        secret_access_key: await sealInstanceSecret(
          keys,
          input.secret_access_key,
          SettingKey.backupStorage,
          SECRET_FIELD,
        ),
      },
      config: {
        endpoint: input.endpoint,
        bucket: input.bucket,
        region,
        accessKeyId: input.access_key_id,
        secretAccessKey: input.secret_access_key,
      },
    };
  }
  const current = await readStored(db);
  if (!current) {
    throw new ApiError(400, "invalid_request", "secret_access_key is required");
  }
  return {
    stored: {
      endpoint: input.endpoint,
      bucket: input.bucket,
      region,
      access_key_id: input.access_key_id,
      secret_access_key: current.secret_access_key,
    },
    config: {
      endpoint: input.endpoint,
      bucket: input.bucket,
      region,
      accessKeyId: input.access_key_id,
      secretAccessKey: await unsealInstanceSecret(
        keys,
        current.secret_access_key,
        SettingKey.backupStorage,
        SECRET_FIELD,
      ),
    },
  };
}

/**
 * Writes the setting.
 *
 * @param db - Database client.
 * @param stored - From {@link prepareBackupStorage}, or `null` to remove it.
 * @returns The statement, for `db.batch`.
 */
export function putBackupStorage(db: Db, stored: StoredBackupStorage | null) {
  return putSetting(db, SettingKey.backupStorage, stored);
}
