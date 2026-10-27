/**
 * Custom domains through Cloudflare for SaaS (ADR 0009, "Cloudflare for SaaS
 * mode"; `docs/cloudflare-for-saas.md`). Customers CNAME their hostname to
 * `customers.<saas zone>`; Cloudflare terminates TLS at its edge and
 * connects to the ingress servers with the customer's hostname as SNI.
 *
 * - The setting (`saas`): zone, API token (sealed, write-only, re-wrapped by
 *   key rotation), the fallback origin's state, the origin firewall choice
 *   and the last origin records written.
 * - Origin records, all proxied in the SaaS zone: `origin.<zone>` (the
 *   fallback origin) with every eligible ingress server of the install,
 *   `origin-<workspace>.<zone>` with each workspace's, used as each custom
 *   hostname's `custom_origin_server` so a hostname only ever reaches its
 *   own workspace's servers, and `customers.<zone>`, a CNAME to the fallback.
 *   An eligible server is meshed, ready, online and has a public IP: with
 *   the mesh, any of them routes any hostname of its workspace (ADR 0005).
 * - Custom hostnames: created with HTTP DCV, read back for the validation
 *   records (the create response may omit them), deleted on removal (404
 *   counts as deleted), and polled by the domain checker ({@link planSaasCheck}).
 * - The gate ({@link saasProblems}): 409 `saas_requires_mesh` unless the
 *   mesh is on and every ingress server is eligible, 409
 *   `saas_requires_managed_tls` unless the origin certificates come from
 *   the control plane.
 * - The origin firewall: with `ingress_firewall: "cloudflare_only"`, nodes
 *   get Cloudflare's published ranges in `desired_state.ingress.allowed_sources`
 *   (fetched daily) and admit 80/443 only from them.
 * - {@link runSaasTick}: the minute tick's part: origin records when the
 *   server set changed, the fallback origin until active, the daily ranges.
 *
 * @module
 */
import {
  type CloudflareDcvRecord,
  createDb,
  type Db,
  domains,
  nodes,
  workspaces,
} from "@roundhouse/db";
import { CERTS_PROTOCOL_VERSION, MAX_INGRESS_SOURCES } from "@roundhouse/protocol";
import {
  DOMAIN_VERIFY_WINDOW_MS,
  type DomainDnsObservation,
  nextCheckDelayMs,
  type TlsMode,
  VERIFIED_RECHECK_MS,
} from "@roundhouse/shared";
import { and, count, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { CloudflareApiError, cloudflareCall } from "../certificates/cloudflare-dns";
import { ApiError } from "../errors";
import {
  type KeyEnv,
  SealedSchema,
  sealInstanceSecret,
  unsealInstanceSecret,
} from "../instance-secrets";
import { meshServing } from "../mesh";
import { getMeshSettings, getSetting, putSetting, SettingKey } from "../settings";
import { evaluateOwnership } from "./records";
import { isIngressNode } from "./serving";

// -----------------------------------------------------------------------------
// Setting
// -----------------------------------------------------------------------------

/** How new custom domains are served. */
export type CustomDomainsMode = "direct" | "cloudflare_saas";

/** Whether nodes admit 80/443 from everyone or only from Cloudflare. */
export const INGRESS_FIREWALL_VALUES = ["off", "cloudflare_only"] as const;

/** See {@link INGRESS_FIREWALL_VALUES}. */
export type IngressFirewall = (typeof INGRESS_FIREWALL_VALUES)[number];

/** Field the SaaS API token is sealed under. */
export const SAAS_TOKEN_FIELD = "api_token";

/** Label of the fallback origin under the SaaS zone. */
export const FALLBACK_ORIGIN_LABEL = "origin";

/** Label of the CNAME target customers point at. */
export const CNAME_TARGET_LABEL = "customers";

const StoredSaasSchema = z.object({
  zone_id: z.string(),
  zone_name: z.string(),
  api_token: SealedSchema,
  enterprise: z.boolean(),
  ingress_firewall: z.enum(INGRESS_FIREWALL_VALUES),
  /** Cloudflare's fallback origin `status`, as last read. */
  fallback_status: z.string().nullable(),
  fallback_errors: z.array(z.string()),
  /** Record name → the addresses last written there. */
  origin_records: z.record(z.string(), z.array(z.string())),
  updated_at: z.number(),
});

/** The setting as stored. */
export type StoredSaas = z.infer<typeof StoredSaasSchema>;

/** The setting as an instance admin may read it: never the token. */
export interface SaasView {
  zone_id: string;
  zone_name: string;
  /** `customers.<zone>`: what customers CNAME their hostnames to. */
  cname_target: string;
  /** `origin.<zone>`: the fallback origin, A/AAAA records of the ingress servers. */
  fallback_origin: string;
  /** Cloudflare's state of the fallback origin; `active` once it serves. */
  fallback_status: string | null;
  fallback_errors: string[];
  enterprise: boolean;
  ingress_firewall: IngressFirewall;
  updated_at: number;
}

/** The SaaS zone with its token unsealed. Never return or log it. */
export interface SaasZone {
  zoneId: string;
  zoneName: string;
  apiToken: string;
  enterprise: boolean;
  ingressFirewall: IngressFirewall;
}

async function readStored(db: Db): Promise<StoredSaas | null> {
  const parsed = StoredSaasSchema.safeParse(await getSetting<unknown>(db, SettingKey.saas));
  return parsed.success ? parsed.data : null;
}

/**
 * The fallback origin's name in a zone.
 *
 * @param zoneName - The SaaS zone.
 * @returns `origin.<zone>`.
 */
export const fallbackOrigin = (zoneName: string) => `${FALLBACK_ORIGIN_LABEL}.${zoneName}`;

/**
 * The CNAME target in a zone.
 *
 * @param zoneName - The SaaS zone.
 * @returns `customers.<zone>`.
 */
export const cnameTarget = (zoneName: string) => `${CNAME_TARGET_LABEL}.${zoneName}`;

/**
 * A workspace's origin: its custom hostnames' `custom_origin_server`.
 *
 * @param workspaceId - The workspace.
 * @param zoneName - The SaaS zone.
 * @returns `origin-<workspace ULID, lowercase>.<zone>`.
 */
export function workspaceOrigin(workspaceId: string, zoneName: string): string {
  return `${FALLBACK_ORIGIN_LABEL}-${workspaceId.slice(workspaceId.indexOf("_") + 1).toLowerCase()}.${zoneName}`;
}

/**
 * How new custom domains are served.
 *
 * @param db - Database client.
 * @returns `cloudflare_saas` only when chosen and a zone is configured.
 */
export async function getCustomDomainsMode(db: Db): Promise<CustomDomainsMode> {
  const mode = await getSetting<unknown>(db, SettingKey.customDomainsMode);
  if (mode !== "cloudflare_saas") return "direct";
  return (await readStored(db)) ? "cloudflare_saas" : "direct";
}

/**
 * Reads the setting without its token.
 *
 * @param db - Database client.
 * @returns The view, or `null` when unset.
 */
export async function getSaasView(db: Db): Promise<SaasView | null> {
  const s = await readStored(db);
  if (!s) return null;
  return {
    zone_id: s.zone_id,
    zone_name: s.zone_name,
    cname_target: cnameTarget(s.zone_name),
    fallback_origin: fallbackOrigin(s.zone_name),
    fallback_status: s.fallback_status,
    fallback_errors: s.fallback_errors,
    enterprise: s.enterprise,
    ingress_firewall: s.ingress_firewall,
    updated_at: s.updated_at,
  };
}

/**
 * Loads the zone with its token unsealed.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @returns The zone, or `null` when unset.
 */
export async function loadSaasZone(db: Db, keys: KeyEnv): Promise<SaasZone | null> {
  const s = await readStored(db);
  if (!s) return null;
  return {
    zoneId: s.zone_id,
    zoneName: s.zone_name,
    apiToken: await unsealInstanceSecret(keys, s.api_token, SettingKey.saas, SAAS_TOKEN_FIELD),
    enterprise: s.enterprise,
    ingressFirewall: s.ingress_firewall,
  };
}

/** New values for the setting; an omitted token keeps the stored one. */
export interface SaasInput {
  zone_id: string;
  api_token?: string | undefined;
  enterprise?: boolean | undefined;
  ingress_firewall?: IngressFirewall | undefined;
}

/**
 * Checks a token against a SaaS zone and builds the stored value. The token
 * must read the zone, its custom hostnames (SSL and Certificates) and its
 * DNS records.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @param input - The new values.
 * @param now - Unix ms.
 * @returns The value to store and the unsealed zone.
 * @throws {ApiError} 400 without a token to use, 422 `cloudflare_saas_invalid`.
 */
export async function prepareSaas(
  db: Db,
  keys: KeyEnv,
  input: SaasInput,
  now = Date.now(),
): Promise<{ stored: StoredSaas; zone: SaasZone }> {
  const current = await readStored(db);
  const sameZone = current?.zone_id === input.zone_id;
  let token = input.api_token;
  if (token === undefined) {
    if (!current || !sameZone) throw new ApiError(400, "invalid_request", "api_token is required");
    token = await unsealInstanceSecret(keys, current.api_token, SettingKey.saas, SAAS_TOKEN_FIELD);
  }
  let zoneName: string;
  try {
    zoneName = await verifySaasZone(input.zone_id, token);
  } catch (err) {
    throw new ApiError(
      422,
      "cloudflare_saas_invalid",
      err instanceof CloudflareApiError
        ? `The token can't manage custom hostnames in that zone: ${err.message}`
        : "The token couldn't be checked against Cloudflare; try again.",
    );
  }
  const zone: SaasZone = {
    zoneId: input.zone_id,
    zoneName,
    apiToken: token,
    enterprise: input.enterprise ?? current?.enterprise ?? false,
    ingressFirewall: input.ingress_firewall ?? current?.ingress_firewall ?? "off",
  };
  return {
    stored: {
      zone_id: zone.zoneId,
      zone_name: zone.zoneName,
      api_token:
        input.api_token === undefined && current
          ? current.api_token
          : await sealInstanceSecret(keys, token, SettingKey.saas, SAAS_TOKEN_FIELD),
      enterprise: zone.enterprise,
      ingress_firewall: zone.ingressFirewall,
      fallback_status: sameZone ? (current?.fallback_status ?? null) : null,
      fallback_errors: sameZone ? (current?.fallback_errors ?? []) : [],
      origin_records: sameZone ? (current?.origin_records ?? {}) : {},
      updated_at: now,
    },
    zone,
  };
}

/**
 * Writes the setting.
 *
 * @param db - Database client.
 * @param stored - From {@link prepareSaas}, or `null` to remove it.
 * @returns The statement, for `db.batch`.
 */
export function putSaas(db: Db, stored: StoredSaas | null) {
  return putSetting(db, SettingKey.saas, stored);
}

async function patchStored(db: Db, patch: Partial<StoredSaas>): Promise<void> {
  const current = await readStored(db);
  if (!current) return;
  await putSaas(db, { ...current, ...patch });
}

/**
 * Custom domains served through Cloudflare for SaaS, for the quota meter.
 *
 * @param db - Database client.
 * @returns How many there are.
 */
export async function saasHostnameCount(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(domains)
    .where(eq(domains.mode, "cloudflare_saas"));
  return Number(row?.n ?? 0);
}

// -----------------------------------------------------------------------------
// Gate
// -----------------------------------------------------------------------------

/** A node as the origin records need it. */
interface OriginNode {
  id: string;
  name: string;
  workspaceId: string;
  publicIp: string | null;
}

/**
 * The install's ingress servers, split into those that may be a SaaS
 * origin (meshed, ready, online, with a public IP) and those that may not.
 *
 * @param db - Database client.
 * @param now - Unix ms.
 * @returns Both lists.
 */
export async function originNodes(
  db: Db,
  now = Date.now(),
): Promise<{ eligible: OriginNode[]; ineligible: (OriginNode & { why: string })[] }> {
  const mesh = await getMeshSettings(db);
  const rows = await db
    .select()
    .from(nodes)
    .innerJoin(workspaces, eq(workspaces.id, nodes.workspaceId))
    .where(and(isNull(nodes.deletedAt), isNull(workspaces.deletedAt)));
  const eligible: OriginNode[] = [];
  const ineligible: (OriginNode & { why: string })[] = [];
  for (const { nodes: n } of rows) {
    if (!isIngressNode(n.capabilities)) continue;
    const node = { id: n.id, name: n.name, workspaceId: n.workspaceId, publicIp: n.publicIp };
    if (!meshServing(n, mesh, now)) ineligible.push({ ...node, why: "not on a ready mesh" });
    else if (!n.publicIp) ineligible.push({ ...node, why: "no public IP" });
    else if (n.protocolVersion < CERTS_PROTOCOL_VERSION) {
      ineligible.push({ ...node, why: "agent too old for control-plane certificates" });
    } else eligible.push(node);
  }
  return { eligible, ineligible };
}

/**
 * Why the install can't serve custom domains through Cloudflare for SaaS.
 *
 * @param db - Database client.
 * @param tlsMode - The TLS mode the install will be in.
 * @returns The error to throw, or `null` when SaaS mode may be used.
 */
export async function saasProblems(db: Db, tlsMode: TlsMode): Promise<ApiError | null> {
  if (tlsMode !== "managed") {
    return new ApiError(
      409,
      "saas_requires_managed_tls",
      "Cloudflare connects to the servers with Full (strict) TLS, so each custom hostname needs " +
        "a certificate from the control plane: switch the TLS mode to managed first.",
    );
  }
  const mesh = await getMeshSettings(db);
  const { eligible, ineligible } = await originNodes(db);
  if (!mesh.enabled || ineligible.length || !eligible.length) {
    const detail = !mesh.enabled
      ? "The private network is off."
      : !eligible.length
        ? "There is no ingress server yet."
        : `Not ready: ${ineligible.map((n) => `${n.name} (${n.why})`).join(", ")}.`;
    return new ApiError(
      409,
      "saas_requires_mesh",
      "Cloudflare may send a custom hostname's traffic to any ingress server, so every one of " +
        `them must be on the private network and ready. ${detail}`,
    );
  }
  return null;
}

// -----------------------------------------------------------------------------
// Cloudflare API
// -----------------------------------------------------------------------------

/**
 * Checks a token can read a zone, its custom hostnames and its DNS records.
 *
 * @param zoneId - The SaaS zone.
 * @param apiToken - The token.
 * @returns The zone's name.
 * @throws {CloudflareApiError} When it can't.
 */
export async function verifySaasZone(zoneId: string, apiToken: string): Promise<string> {
  if (!/^[a-f0-9]{32}$/.test(zoneId)) {
    throw new CloudflareApiError("A zone ID is 32 hexadecimal characters.", 400);
  }
  const zone = { apiToken };
  const info = await cloudflareCall<{ name?: string }>(zone, "GET", `/zones/${zoneId}`);
  if (typeof info?.name !== "string" || !info.name) {
    throw new CloudflareApiError("Cloudflare returned the zone without a name.", 200);
  }
  await cloudflareCall(zone, "GET", `/zones/${zoneId}/custom_hostnames?per_page=5`);
  await cloudflareCall(zone, "GET", `/zones/${zoneId}/dns_records?per_page=5`);
  return info.name.toLowerCase();
}

/** A custom hostname as Cloudflare returns it (the fields used here). */
interface CloudflareHostname {
  id?: string;
  hostname?: string;
  status?: string;
  ssl?: {
    status?: string;
    validation_records?: { txt_name?: string; txt_value?: string }[];
    validation_errors?: { message?: string }[];
  };
  ownership_verification?: { type?: string; name?: string; value?: string };
  verification_errors?: string[];
}

/** A custom hostname's state as the checker uses it. */
export interface SaasHostnameState {
  id: string;
  status: string;
  sslStatus: string | null;
  /** Cloudflare's verification and validation errors, verbatim. */
  errors: string[];
  dcv: CloudflareDcvRecord[];
}

function toState(h: CloudflareHostname): SaasHostnameState {
  if (typeof h.id !== "string") {
    throw new CloudflareApiError("Cloudflare returned a custom hostname without an ID.", 200);
  }
  const dcv: CloudflareDcvRecord[] = [];
  const own = h.ownership_verification;
  if (own?.name && own.value) dcv.push({ type: "TXT", name: own.name, value: own.value });
  for (const r of h.ssl?.validation_records ?? []) {
    if (r.txt_name && r.txt_value) dcv.push({ type: "TXT", name: r.txt_name, value: r.txt_value });
  }
  return {
    id: h.id,
    status: h.status ?? "pending",
    sslStatus: h.ssl?.status ?? null,
    errors: [
      ...(h.verification_errors ?? []),
      ...(h.ssl?.validation_errors ?? []).flatMap((e) => (e.message ? [e.message] : [])),
    ]
      .map((e) => e.slice(0, 500))
      .slice(0, 10),
    dcv: dcv.slice(0, 10),
  };
}

/**
 * Creates a custom hostname with HTTP DCV, sent to its workspace's origin,
 * then reads it back: the create response may lack the validation records.
 *
 * @param zone - The SaaS zone.
 * @param hostname - The customer's hostname.
 * @param workspaceId - Its workspace, whose servers are the origin.
 * @returns Its state.
 */
export async function createSaasHostname(
  zone: SaasZone,
  hostname: string,
  workspaceId: string,
): Promise<SaasHostnameState> {
  const created = await cloudflareCall<CloudflareHostname>(
    zone,
    "POST",
    `/zones/${zone.zoneId}/custom_hostnames`,
    {
      hostname,
      ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
      custom_origin_server: workspaceOrigin(workspaceId, zone.zoneName),
    },
  );
  const { id } = toState(created);
  return getSaasHostname(zone, id);
}

/**
 * Reads a custom hostname.
 *
 * @param zone - The SaaS zone.
 * @param id - Its Cloudflare ID.
 * @returns Its state.
 */
export async function getSaasHostname(zone: SaasZone, id: string): Promise<SaasHostnameState> {
  return toState(
    await cloudflareCall<CloudflareHostname>(
      zone,
      "GET",
      `/zones/${zone.zoneId}/custom_hostnames/${encodeURIComponent(id)}`,
    ),
  );
}

/**
 * Deletes a custom hostname; one already gone counts as deleted.
 *
 * @param zone - The SaaS zone.
 * @param id - Its Cloudflare ID.
 */
export async function deleteSaasHostname(zone: SaasZone, id: string): Promise<void> {
  try {
    await cloudflareCall(
      zone,
      "DELETE",
      `/zones/${zone.zoneId}/custom_hostnames/${encodeURIComponent(id)}`,
    );
  } catch (err) {
    if (err instanceof CloudflareApiError && err.status === 404) return;
    throw err;
  }
}

/** A DNS record as Cloudflare lists it. */
interface CloudflareRecord {
  id: string;
  type: string;
  name: string;
  content: string;
}

/**
 * Makes one name's proxied records exactly `want`: creates the missing and
 * deletes the others (A, AAAA and CNAME only).
 *
 * @param zone - The SaaS zone.
 * @param name - The record name.
 * @param want - Records to have.
 */
async function reconcileRecords(
  zone: SaasZone,
  name: string,
  want: { type: "A" | "AAAA" | "CNAME"; content: string }[],
): Promise<void> {
  const have = await cloudflareCall<CloudflareRecord[]>(
    zone,
    "GET",
    `/zones/${zone.zoneId}/dns_records?name=${encodeURIComponent(name)}&per_page=100`,
  );
  const key = (r: { type: string; content: string }) => `${r.type} ${r.content.toLowerCase()}`;
  const wanted = new Set(want.map(key));
  const present = new Set<string>();
  for (const r of have ?? []) {
    if (!["A", "AAAA", "CNAME"].includes(r.type)) continue;
    if (wanted.has(key(r)) && !present.has(key(r))) {
      present.add(key(r));
      continue;
    }
    try {
      await cloudflareCall(zone, "DELETE", `/zones/${zone.zoneId}/dns_records/${r.id}`);
    } catch (err) {
      if (!(err instanceof CloudflareApiError && err.status === 404)) throw err;
    }
  }
  for (const r of want) {
    if (present.has(key(r))) continue;
    await cloudflareCall(zone, "POST", `/zones/${zone.zoneId}/dns_records`, {
      type: r.type,
      name,
      content: r.content,
      proxied: true,
      ttl: 1,
      comment: "Roundhouse custom hostnames origin; managed automatically",
    });
  }
}

const addressRecords = (ips: readonly string[]) =>
  ips.map((ip) => ({ type: ip.includes(":") ? ("AAAA" as const) : ("A" as const), content: ip }));

/**
 * The origin records the install should have: the fallback origin with
 * every eligible server, each workspace's origin with its own.
 *
 * @param db - Database client.
 * @param zoneName - The SaaS zone.
 * @returns Record name → sorted addresses.
 */
export async function desiredOriginRecords(
  db: Db,
  zoneName: string,
): Promise<Map<string, string[]>> {
  const { eligible } = await originNodes(db);
  const out = new Map<string, string[]>();
  const add = (name: string, ip: string) => {
    const list = out.get(name) ?? [];
    if (!list.includes(ip)) list.push(ip);
    out.set(name, list);
  };
  for (const n of eligible) {
    const ip = n.publicIp!.toLowerCase();
    add(fallbackOrigin(zoneName), ip);
    add(workspaceOrigin(n.workspaceId, zoneName), ip);
  }
  for (const list of out.values()) list.sort();
  return out;
}

/**
 * Writes the origin records whose servers changed since the last write,
 * and the CNAME target once. A name with no eligible server left keeps its
 * last records: stale addresses beat none while a server is briefly unready.
 *
 * @param db - Database client.
 * @param zone - The SaaS zone.
 * @param options - `force` rewrites every record (setup).
 * @returns How many names were written.
 */
export async function syncOriginRecords(
  db: Db,
  zone: SaasZone,
  options: { force?: boolean } = {},
): Promise<number> {
  const stored = await readStored(db);
  if (!stored) return 0;
  const written = { ...stored.origin_records };
  const desired = await desiredOriginRecords(db, zone.zoneName);
  let changed = 0;
  for (const [name, ips] of desired) {
    if (!options.force && JSON.stringify(written[name]) === JSON.stringify(ips)) continue;
    await reconcileRecords(zone, name, addressRecords(ips));
    written[name] = ips;
    changed++;
  }
  const target = cnameTarget(zone.zoneName);
  const fallback = fallbackOrigin(zone.zoneName);
  if (options.force || JSON.stringify(written[target]) !== JSON.stringify([fallback])) {
    await reconcileRecords(zone, target, [{ type: "CNAME", content: fallback }]);
    written[target] = [fallback];
    changed++;
  }
  if (changed) await patchStored(db, { origin_records: written });
  return changed;
}

/**
 * Sets the zone's fallback origin and records Cloudflare's answer.
 *
 * @param db - Database client.
 * @param zone - The SaaS zone.
 * @returns Its status.
 */
export async function setFallbackOrigin(db: Db, zone: SaasZone): Promise<string> {
  const result = await cloudflareCall<{ status?: string; errors?: string[] }>(
    zone,
    "PUT",
    `/zones/${zone.zoneId}/custom_hostnames/fallback_origin`,
    { origin: fallbackOrigin(zone.zoneName) },
  );
  const status = result?.status ?? "pending_deployment";
  await patchStored(db, { fallback_status: status, fallback_errors: result?.errors ?? [] });
  return status;
}

/**
 * Reads the fallback origin's status and records it.
 *
 * @param db - Database client.
 * @param zone - The SaaS zone.
 * @returns Its status.
 */
export async function pollFallbackOrigin(db: Db, zone: SaasZone): Promise<string> {
  const result = await cloudflareCall<{ status?: string; errors?: string[] }>(
    zone,
    "GET",
    `/zones/${zone.zoneId}/custom_hostnames/fallback_origin`,
  );
  const status = result?.status ?? "pending_deployment";
  await patchStored(db, { fallback_status: status, fallback_errors: result?.errors ?? [] });
  return status;
}

// -----------------------------------------------------------------------------
// Cloudflare's IP ranges (origin firewall)
// -----------------------------------------------------------------------------

/** Cloudflare's ranges are re-read this often. */
export const CLOUDFLARE_IPS_MAX_AGE_MS = 24 * 60 * 60_000;

const StoredIpsSchema = z.object({
  ipv4: z.array(z.string()),
  ipv6: z.array(z.string()),
  fetched_at: z.number(),
});

const CIDR_RE = /^(?:[0-9]{1,3}(?:\.[0-9]{1,3}){3}\/[0-9]{1,2}|[0-9a-f:]+\/[0-9]{1,3})$/i;

/**
 * Fetches Cloudflare's published ranges (no token needed) and stores them.
 *
 * @param db - Database client.
 * @param now - Unix ms.
 * @returns Whether the stored ranges changed.
 * @throws {CloudflareApiError} When Cloudflare can't be reached or answers nonsense.
 */
export async function refreshCloudflareIps(db: Db, now = Date.now()): Promise<boolean> {
  const result = await cloudflareCall<{ ipv4_cidrs?: string[]; ipv6_cidrs?: string[] }>(
    { apiToken: "" },
    "GET",
    "/ips",
  );
  const ipv4 = (result?.ipv4_cidrs ?? []).filter((c) => CIDR_RE.test(c));
  const ipv6 = (result?.ipv6_cidrs ?? []).filter((c) => CIDR_RE.test(c));
  // SECURITY: an empty answer would read as "admit no one" downstream (or be
  // dropped as invalid); keep the last good ranges instead.
  if (!ipv4.length) throw new CloudflareApiError("Cloudflare listed no IPv4 ranges.", 200);
  const before = StoredIpsSchema.safeParse(await getSetting<unknown>(db, SettingKey.cloudflareIps));
  await putSetting(db, SettingKey.cloudflareIps, { ipv4, ipv6, fetched_at: now });
  return (
    !before.success ||
    JSON.stringify([before.data.ipv4, before.data.ipv6]) !== JSON.stringify([ipv4, ipv6])
  );
}

/**
 * `desired_state.ingress.allowed_sources`: Cloudflare's ranges while SaaS
 * mode runs with `ingress_firewall: "cloudflare_only"`, else `null`.
 *
 * @param db - Database client.
 * @returns The sources, or `null` to admit everyone.
 */
export async function ingressAllowedSources(db: Db): Promise<string[] | null> {
  const stored = await readStored(db);
  if (stored?.ingress_firewall !== "cloudflare_only") return null;
  if ((await getCustomDomainsMode(db)) !== "cloudflare_saas") return null;
  const ips = StoredIpsSchema.safeParse(await getSetting<unknown>(db, SettingKey.cloudflareIps));
  if (!ips.success || !ips.data.ipv4.length) return null;
  return [...ips.data.ipv4, ...ips.data.ipv6].slice(0, MAX_INGRESS_SOURCES);
}

/**
 * Whether the stored ranges are missing or older than {@link CLOUDFLARE_IPS_MAX_AGE_MS}.
 *
 * @param db - Database client.
 * @param now - Unix ms.
 * @returns `true` when they should be fetched.
 */
export async function cloudflareIpsStale(db: Db, now = Date.now()): Promise<boolean> {
  const ips = StoredIpsSchema.safeParse(await getSetting<unknown>(db, SettingKey.cloudflareIps));
  return !ips.success || now - ips.data.fetched_at >= CLOUDFLARE_IPS_MAX_AGE_MS;
}

// -----------------------------------------------------------------------------
// Checks
// -----------------------------------------------------------------------------

type DomainRow = typeof domains.$inferSelect;

/** Cloudflare statuses after which a custom hostname never becomes active. */
const DEAD_STATUSES = new Set(["blocked", "moved", "deleted"]);

/** What {@link planSaasCheck} decides from. */
export interface SaasCheckInput {
  now: number;
  /** Cloudflare's view, or `null` when the API didn't answer. */
  cf: SaasHostnameState | null;
  cfError?: string;
  /** The ownership TXT as resolved, or `null` when the lookup failed. */
  seen: DomainDnsObservation | null;
  tlsMode: TlsMode;
}

/**
 * One check of a SaaS custom domain (`docs/cloudflare-for-saas.md`, "State
 * machine"). Cloudflare's own verification stands in for the routing
 * record; the ownership TXT is still required, because routing on the nodes
 * trusts only the control plane's verification.
 *
 * | Cloudflare                                | TXT     | `status`               |
 * | ----------------------------------------- | ------- | ---------------------- |
 * | `status` pending                          | any     | `pending_dns`          |
 * | `status` active, `ssl.status` not active  | missing | `pending_verification` |
 * | `status` active                           | ok      | verified, `issuing`    |
 * | both active, certificate on every server  | ok      | `active`               |
 * | blocked/moved/deleted, or 72 h pass       | any     | `failed`               |
 *
 * @param d - The domain before the check.
 * @param input - Cloudflare's and DNS's answers.
 * @returns The row patch and the audit event, if any.
 */
export function planSaasCheck(
  d: DomainRow,
  input: SaasCheckInput,
): { patch: Partial<DomainRow>; event: "verified" | "failed" | null } {
  const { now, cf } = input;
  const attempts = d.checkAttempts + 1;
  const base: Partial<DomainRow> = {
    lastCheckedAt: new Date(now),
    checkAttempts: attempts,
    updatedAt: new Date(now),
  };
  const verified = d.verificationStatus === "verified";
  if (!cf) {
    return {
      patch: {
        ...base,
        error: verified ? d.error : `Cloudflare didn't answer (${input.cfError}); retrying.`,
        nextCheckAt: new Date(now + nextCheckDelayMs(attempts)),
      },
      event: null,
    };
  }
  const cfPatch: Partial<DomainRow> = {
    cfStatus: cf.status,
    cfSslStatus: cf.sslStatus,
    cfErrors: cf.errors,
    cfDcv: cf.dcv,
    dnsStatus: cf.status === "active" ? "ok" : "missing",
  };
  const ownership = input.seen
    ? evaluateOwnership(input.seen, d.verificationToken ?? "")
    : d.ownershipStatus;
  const observed = input.seen ?? d.dnsObserved;
  const patch: Partial<DomainRow> = {
    ...base,
    ...cfPatch,
    ownershipStatus: ownership,
    ...(observed ? { dnsObserved: observed } : {}),
  };
  if (DEAD_STATUSES.has(cf.status)) {
    return {
      patch: {
        ...patch,
        status: "failed",
        ...(verified ? {} : { verificationStatus: "failed" as const }),
        error: `Cloudflare reports the hostname ${cf.status}. ${cf.errors.join(" ")}`.trim(),
        nextCheckAt: null,
      },
      event: verified ? null : "failed",
    };
  }
  if (verified) {
    const sslActive = cf.sslStatus === "active";
    const settle =
      d.status === "issuing" && sslActive && (d.tlsStatus === "issued" || input.tlsMode === "off");
    return {
      patch: {
        ...patch,
        ...(settle ? { status: "active" as const } : {}),
        error: sslActive
          ? null
          : `Cloudflare's edge certificate is ${cf.sslStatus ?? "pending"}. ${cf.errors.join(" ")}`.trim(),
        nextCheckAt: new Date(now + (sslActive ? VERIFIED_RECHECK_MS : nextCheckDelayMs(attempts))),
      },
      event: null,
    };
  }
  if (cf.status === "active" && ownership === "ok") {
    return {
      patch: {
        ...patch,
        verificationStatus: "verified",
        verifiedAt: new Date(now),
        status: "issuing",
        tlsStatus: input.tlsMode === "off" ? "disabled" : "pending",
        error: null,
        checkAttempts: 0,
        nextCheckAt: new Date(now + nextCheckDelayMs(1)),
      },
      event: "verified",
    };
  }
  const since = d.pendingSince ? +d.pendingSince : +d.createdAt;
  const problems = [
    cf.status === "active" ? null : `Cloudflare reports the hostname ${cf.status}.`,
    ownership === "ok" ? null : "The ownership TXT record isn't there yet.",
    ...cf.errors,
  ].filter(Boolean);
  if (now - since >= DOMAIN_VERIFY_WINDOW_MS) {
    return {
      patch: {
        ...patch,
        status: "failed",
        verificationStatus: "failed",
        error: `Not verified within 72 hours. ${problems.join(" ")} Fix the records, then check again.`,
        nextCheckAt: null,
      },
      event: "failed",
    };
  }
  return {
    patch: {
      ...patch,
      status: cf.status === "active" ? "pending_verification" : "pending_dns",
      error: problems.join(" "),
      nextCheckAt: new Date(now + nextCheckDelayMs(attempts)),
    },
    event: null,
  };
}

// -----------------------------------------------------------------------------
// Minute tick
// -----------------------------------------------------------------------------

/** Bindings the tick needs. */
export interface SaasTickEnv extends KeyEnv {
  DB: D1Database;
}

/**
 * The minute tick's SaaS work: origin records whose servers changed, the
 * fallback origin until Cloudflare reports it active, and Cloudflare's
 * ranges once a day while the origin firewall is on.
 *
 * @param env - Bindings.
 * @param now - Unix ms.
 * @param refresh - Pushes desired state everywhere when the ranges change.
 * @returns How many things changed.
 */
export async function runSaasTick(
  env: SaasTickEnv,
  now: number,
  refresh: () => Promise<void>,
): Promise<number> {
  const db = createDb(env.DB);
  if ((await getCustomDomainsMode(db)) !== "cloudflare_saas") return 0;
  const zone = await loadSaasZone(db, env);
  if (!zone) return 0;
  let changed = await syncOriginRecords(db, zone);
  const stored = await readStored(db);
  if (stored && stored.fallback_status !== "active") {
    // Never set (setup failed at Cloudflare): set it now; else follow it.
    const status =
      stored.fallback_status === null
        ? await setFallbackOrigin(db, zone)
        : await pollFallbackOrigin(db, zone);
    if (status === "active") changed++;
  }
  if (zone.ingressFirewall === "cloudflare_only" && (await cloudflareIpsStale(db, now))) {
    if (await refreshCloudflareIps(db, now)) {
      changed++;
      await refresh();
    }
  }
  return changed;
}

/**
 * The records a SaaS custom domain's owner creates: the CNAME to the
 * install's target (apex names need flattening or ALIAS), the ownership
 * TXT, and whatever Cloudflare asks for to pre-validate.
 *
 * @param d - The domain.
 * @param target - `customers.<zone>`.
 * @param ownership - The ownership TXT as {@link expectedRecords} words it.
 * @returns The records.
 */
export function saasRecords(
  d: DomainRow,
  target: string,
  ownership: { name: string; value: string },
) {
  const cfOk = d.cfStatus === "active" ? ("ok" as const) : ("unknown" as const);
  return [
    {
      type: "CNAME" as const,
      name: d.hostname,
      value: target,
      purpose: "routing" as const,
      state: cfOk,
      note: d.apex
        ? "An apex can't hold a plain CNAME. This works only if your DNS provider offers CNAME " +
          "flattening or ALIAS (Cloudflare calls apex A records an unsupported setup)."
        : null,
    },
    {
      type: "TXT" as const,
      name: ownership.name,
      value: ownership.value,
      purpose: "ownership" as const,
      state: d.ownershipStatus,
      note: null,
    },
    ...(d.cfDcv ?? []).map((r) => ({
      type: r.type,
      name: r.name,
      value: r.value,
      purpose: "cf_dcv" as const,
      state: cfOk,
      note: "Optional: lets Cloudflare validate the hostname before you switch the CNAME.",
    })),
  ];
}
