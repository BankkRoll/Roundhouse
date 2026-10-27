/**
 * Instance settings of the `managed` TLS mode (ADR 0009):
 *
 * - `acme`: the CA's directory URL (Let's Encrypt production by default;
 *   tests point it at Pebble) and an optional contact address;
 * - `acme_account`: the control plane's account at that CA, its private key
 *   sealed (field `key`), created on first use;
 * - `cloudflare_dns`: zone and token (sealed, field `api_token`) for DNS-01
 *   in the apps domain's zone; without it there is no apps wildcard and no
 *   custom wildcard;
 * - {@link managedTlsProblems}: what stops `managed` from being selected.
 *
 * Secrets are write-only: reads report only whether one is set.
 *
 * @module
 */
import { type Db, instanceSettings } from "@roundhouse/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { generateAccountKey } from "../acme";
import {
  type KeyEnv,
  SealedSchema,
  sealInstanceSecret,
  unsealInstanceSecret,
} from "../instance-secrets";
import { configuredOrigin, type OriginEnv } from "../origin";
import { getSetting, putSetting, SettingKey } from "../settings";
import { type CloudflareZone, inZone } from "./cloudflare-dns";

/** Let's Encrypt production, the default CA. */
export const LETS_ENCRYPT_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";

/** Field the Cloudflare token is sealed under. */
export const CLOUDFLARE_TOKEN_FIELD = "api_token";

/** Field the ACME account key is sealed under. */
export const ACME_ACCOUNT_KEY_FIELD = "key";

const AcmeConfigSchema = z.object({
  directory_url: z.string().url(),
  email: z.string().nullable(),
});

/** The `acme` setting. */
export type AcmeConfig = z.infer<typeof AcmeConfigSchema>;

const StoredAccountSchema = z.object({
  /** The directory the account belongs to; a different CA needs a new account. */
  directory_url: z.string(),
  url: z.string().nullable(),
  key: SealedSchema,
});

const StoredCloudflareDnsSchema = z.object({
  zone_id: z.string(),
  zone_name: z.string(),
  api_token: SealedSchema,
  updated_at: z.number(),
});

/** The `cloudflare_dns` setting without its token. */
export interface CloudflareDnsView {
  zone_id: string;
  zone_name: string;
  updated_at: number;
}

/**
 * Reads the CA settings, applying defaults.
 *
 * @param db - Database client.
 * @returns The directory URL and contact address.
 */
export async function getAcmeConfig(db: Db): Promise<AcmeConfig> {
  const parsed = AcmeConfigSchema.safeParse(await getSetting<unknown>(db, SettingKey.acme));
  return parsed.success ? parsed.data : { directory_url: LETS_ENCRYPT_DIRECTORY, email: null };
}

/**
 * Writes the CA settings.
 *
 * @param db - Database client.
 * @param config - New values.
 * @returns The statement, for `db.batch`.
 */
export function putAcmeConfig(db: Db, config: AcmeConfig) {
  return putSetting(db, SettingKey.acme, config);
}

/** The ACME account, unsealed for one order. */
export interface AcmeAccount {
  directoryUrl: string;
  url: string | null;
  key: JsonWebKey;
}

/**
 * The control plane's account at the configured CA, creating its key on
 * first use. The account itself is registered by the first order.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @param create - Create the key when there is none for the configured CA.
 * @returns Directory, account URL (`null` until registered) and private key. Never log it.
 */
export async function loadAcmeAccount(db: Db, keys: KeyEnv, create = true): Promise<AcmeAccount> {
  const { directory_url } = await getAcmeConfig(db);
  const stored = StoredAccountSchema.safeParse(
    await getSetting<unknown>(db, SettingKey.acmeAccount),
  );
  if (stored.success && (stored.data.directory_url === directory_url || !create)) {
    const key = JSON.parse(
      await unsealInstanceSecret(
        keys,
        stored.data.key,
        SettingKey.acmeAccount,
        ACME_ACCOUNT_KEY_FIELD,
      ),
    ) as JsonWebKey;
    return { directoryUrl: directory_url, url: stored.data.url, key };
  }
  const key = await generateAccountKey();
  const value = {
    directory_url,
    url: null,
    key: await sealInstanceSecret(
      keys,
      JSON.stringify(key),
      SettingKey.acmeAccount,
      ACME_ACCOUNT_KEY_FIELD,
    ),
  };
  if (stored.success) {
    // Another CA: its account is useless here, so it is replaced.
    await db
      .update(instanceSettings)
      .set({ value, updatedAt: new Date() })
      .where(eq(instanceSettings.key, SettingKey.acmeAccount));
  } else {
    // Orders started together must agree on one key: the first insert wins.
    await db
      .insert(instanceSettings)
      .values({ key: SettingKey.acmeAccount, value })
      .onConflictDoNothing();
  }
  return loadAcmeAccount(db, keys, false);
}

/**
 * Records the account URL once registered.
 *
 * @param db - Database client.
 * @param directoryUrl - The CA it was registered at.
 * @param url - The account URL.
 */
export async function saveAcmeAccountUrl(db: Db, directoryUrl: string, url: string) {
  const stored = StoredAccountSchema.safeParse(
    await getSetting<unknown>(db, SettingKey.acmeAccount),
  );
  if (!stored.success || stored.data.directory_url !== directoryUrl) return;
  await putSetting(db, SettingKey.acmeAccount, { ...stored.data, url });
}

/**
 * Whether an account is registered at the configured CA.
 *
 * @param db - Database client.
 * @returns The account URL, or `null`.
 */
export async function acmeAccountUrl(db: Db): Promise<string | null> {
  const [{ directory_url }, raw] = await Promise.all([
    getAcmeConfig(db),
    getSetting<unknown>(db, SettingKey.acmeAccount),
  ]);
  const stored = StoredAccountSchema.safeParse(raw);
  return stored.success && stored.data.directory_url === directory_url ? stored.data.url : null;
}

async function readCloudflareDns(db: Db) {
  const parsed = StoredCloudflareDnsSchema.safeParse(
    await getSetting<unknown>(db, SettingKey.cloudflareDns),
  );
  return parsed.success ? parsed.data : null;
}

/**
 * The DNS-01 zone without its token.
 *
 * @param db - Database client.
 * @returns The zone, or `null` when unset.
 */
export async function getCloudflareDnsView(db: Db): Promise<CloudflareDnsView | null> {
  const s = await readCloudflareDns(db);
  return s ? { zone_id: s.zone_id, zone_name: s.zone_name, updated_at: s.updated_at } : null;
}

/**
 * The DNS-01 zone with its token unsealed.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @returns Zone ID, name and token, or `null` when unset. Never return it to a caller.
 */
export async function loadCloudflareDns(
  db: Db,
  keys: KeyEnv,
): Promise<(CloudflareZone & { zoneName: string }) | null> {
  const s = await readCloudflareDns(db);
  if (!s) return null;
  return {
    zoneId: s.zone_id,
    zoneName: s.zone_name,
    apiToken: await unsealInstanceSecret(
      keys,
      s.api_token,
      SettingKey.cloudflareDns,
      CLOUDFLARE_TOKEN_FIELD,
    ),
  };
}

/**
 * The stored form of the DNS-01 zone, its token sealed. Write it with
 * `putSetting(db, SettingKey.cloudflareDns, …)`; `null` there removes it.
 *
 * @param keys - The keyring bindings.
 * @param value - Zone ID, its verified name and the token.
 * @param now - Current time, unix ms.
 * @returns The setting's value.
 */
export async function sealCloudflareDns(
  keys: KeyEnv,
  value: { zoneId: string; zoneName: string; apiToken: string },
  now = Date.now(),
) {
  return {
    zone_id: value.zoneId,
    zone_name: value.zoneName,
    api_token: await sealInstanceSecret(
      keys,
      value.apiToken,
      SettingKey.cloudflareDns,
      CLOUDFLARE_TOKEN_FIELD,
    ),
    updated_at: now,
  };
}

/**
 * Whether the control plane can answer DNS-01 for names under the apps
 * domain: the apps wildcard, and the delegation targets of custom wildcards.
 *
 * @param appsDomain - The install's apps domain.
 * @param dns - The DNS-01 zone, if set.
 * @returns `true` when the apps domain is inside the zone.
 */
export function dns01Available(
  appsDomain: string | null,
  dns: Pick<CloudflareDnsView, "zone_name"> | null,
): boolean {
  return !!appsDomain && !!dns && inZone(appsDomain, dns.zone_name);
}

/**
 * What stops the `managed` mode: Caddy proxies HTTP-01 challenges to the
 * control plane's public origin, which must be HTTPS.
 *
 * @param env - Bindings with `PUBLIC_ORIGIN`.
 * @returns Problems in words; empty when `managed` may be selected.
 */
export function managedTlsProblems(env: OriginEnv): string[] {
  const origin = configuredOrigin(env);
  if (!origin?.startsWith("https://")) {
    return [
      "PUBLIC_ORIGIN must be the control plane's https:// origin: servers forward ACME HTTP-01 challenges to it.",
    ];
  }
  return [];
}
