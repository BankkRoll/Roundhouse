/**
 * The `cloudflare_account` instance setting (ADR 0011 "Eligibility and
 * settings"): the account the Containers provider runs in.
 *
 * - {@link readCloudflareAccount} / {@link cloudflareAccountView}: the
 *   stored setting without its token, for `GET /v1/instance/cloudflare`.
 * - {@link loadCloudflareAccount}: the same with the token unsealed, for the
 *   deploy workflow, the minute tick and the status route; never returned
 *   to a caller.
 * - {@link sealCloudflareAccount}: the stored form, the token sealed under
 *   the current KEK as an instance secret (`cloudflare_account`/`api_token`).
 * - {@link appsZoneFor}: the zone Worker routes go into.
 *
 * @module
 */
import type { Db } from "@roundhouse/db";
import { z } from "zod";
import {
  type KeyEnv,
  SealedSchema,
  sealInstanceSecret,
  unsealInstanceSecret,
} from "../instance-secrets";
import { getSetting, SettingKey } from "../settings";
import { CloudflareClient, type Zone } from "./client";

/** Field the token is sealed under (its AAD), and the property holding it. */
export const CLOUDFLARE_ACCOUNT_TOKEN_FIELD = "api_token";

const StoredSchema = z.object({
  account_id: z.string(),
  api_token: SealedSchema,
  /** Last 4 characters, so an operator can tell tokens apart. */
  token_hint: z.string(),
  workers_subdomain: z.string(),
  apps_domain_proxied: z.boolean(),
  /** The apps domain's zone as last resolved, or `null` when it wasn't found. */
  apps_zone: z.object({ id: z.string(), name: z.string() }).nullable(),
  validated_at: z.number(),
  updated_at: z.number(),
});

/** The stored setting. */
export type StoredCloudflareAccount = z.infer<typeof StoredSchema>;

/** The setting as `GET /v1/instance/cloudflare` shows it: never the token. */
export interface CloudflareAccountView {
  account_id: string;
  token_hint: string;
  workers_subdomain: string;
  apps_domain_proxied: boolean;
  apps_zone: { id: string; name: string } | null;
  validated_at: number;
}

/** The account with its token, for API calls. */
export interface CloudflareAccount extends CloudflareAccountView {
  apiToken: string;
}

/**
 * Reads the stored setting.
 *
 * @param db - Database client.
 * @returns The setting, or `null` when the provider is not configured.
 */
export async function readCloudflareAccount(db: Db): Promise<StoredCloudflareAccount | null> {
  const parsed = StoredSchema.safeParse(
    await getSetting<unknown>(db, SettingKey.cloudflareAccount),
  );
  return parsed.success ? parsed.data : null;
}

/**
 * The setting without its token.
 *
 * @param db - Database client.
 * @returns The view, or `null` when unset.
 */
export async function cloudflareAccountView(db: Db): Promise<CloudflareAccountView | null> {
  const s = await readCloudflareAccount(db);
  return s ? toView(s) : null;
}

function toView(s: StoredCloudflareAccount): CloudflareAccountView {
  return {
    account_id: s.account_id,
    token_hint: s.token_hint,
    workers_subdomain: s.workers_subdomain,
    apps_domain_proxied: s.apps_domain_proxied,
    apps_zone: s.apps_zone,
    validated_at: s.validated_at,
  };
}

/**
 * The setting with its token unsealed.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @returns The account, or `null` when unset. Never return it to a caller.
 */
export async function loadCloudflareAccount(
  db: Db,
  keys: KeyEnv,
): Promise<CloudflareAccount | null> {
  const s = await readCloudflareAccount(db);
  if (!s) return null;
  return {
    ...toView(s),
    apiToken: await unsealInstanceSecret(
      keys,
      s.api_token,
      SettingKey.cloudflareAccount,
      CLOUDFLARE_ACCOUNT_TOKEN_FIELD,
    ),
  };
}

/**
 * A client for the configured account.
 *
 * @param account - From {@link loadCloudflareAccount}.
 * @returns The client.
 */
export function clientFor(account: Pick<CloudflareAccount, "account_id" | "apiToken">) {
  return new CloudflareClient({ accountId: account.account_id, apiToken: account.apiToken });
}

/**
 * The stored form of the setting. Write it with
 * `putSetting(db, SettingKey.cloudflareAccount, …)`; `null` there removes it.
 *
 * @param keys - The keyring bindings.
 * @param value - Validated account, token and facts.
 * @param now - Current time, unix ms.
 * @returns The setting's value.
 */
export async function sealCloudflareAccount(
  keys: KeyEnv,
  value: {
    accountId: string;
    apiToken: string;
    workersSubdomain: string;
    appsDomainProxied: boolean;
    appsZone: Zone | null;
  },
  now = Date.now(),
): Promise<StoredCloudflareAccount> {
  return {
    account_id: value.accountId,
    api_token: await sealInstanceSecret(
      keys,
      value.apiToken,
      SettingKey.cloudflareAccount,
      CLOUDFLARE_ACCOUNT_TOKEN_FIELD,
    ),
    token_hint: value.apiToken.slice(-4),
    workers_subdomain: value.workersSubdomain,
    apps_domain_proxied: value.appsDomainProxied,
    apps_zone: value.appsZone ? { id: value.appsZone.id, name: value.appsZone.name } : null,
    validated_at: now,
    updated_at: now,
  };
}

/**
 * Finds the zone holding the apps domain: the apps domain itself, or the
 * nearest parent the account has as a zone.
 *
 * @param client - Client of the configured account.
 * @param appsDomain - e.g. `apps.example.com`.
 * @returns The zone, or `null` when the account has none covering it.
 */
export async function appsZoneFor(
  client: CloudflareClient,
  appsDomain: string | null,
): Promise<Zone | null> {
  if (!appsDomain) return null;
  const labels = appsDomain.toLowerCase().split(".");
  // Stop before the bare TLD: a zone always has at least two labels.
  for (let i = 0; i <= labels.length - 2; i++) {
    const zone = await client.findZone(labels.slice(i).join("."));
    if (zone) return zone;
  }
  return null;
}

/**
 * Whether a hostname belongs to a zone.
 *
 * @param hostname - A DNS name.
 * @param zoneName - The zone, e.g. `example.com`.
 * @returns `true` for the zone itself or a name under it.
 */
export function inCloudflareZone(hostname: string, zoneName: string): boolean {
  const h = hostname.toLowerCase();
  const z = zoneName.toLowerCase();
  return h === z || h.endsWith(`.${z}`);
}
