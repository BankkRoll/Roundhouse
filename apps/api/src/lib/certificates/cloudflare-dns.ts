/**
 * The few Cloudflare DNS API calls DNS-01 needs (ADR 0009): check a token
 * against a zone, write a challenge TXT record, delete it afterwards.
 *
 * The token needs Zone → DNS → Edit and Zone → Zone → Read on the apps
 * domain's zone, nothing account-wide.
 *
 * @module
 */

/** Cloudflare's API base. */
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** Per-call timeout: a stuck API must not hold a workflow step. */
const CALL_TIMEOUT_MS = 15_000;

/** TTL of challenge records: the CA looks once, and stale ones only confuse retries. */
const CHALLENGE_TTL_S = 60;

let transport: typeof fetch | null = null;

/**
 * Replaces the `fetch` Cloudflare API calls use, for tests.
 *
 * @param fn - A fetch implementation, or `null` to restore the global one.
 */
export function setCloudflareTransport(fn: typeof fetch | null): void {
  transport = fn;
}

/** A Cloudflare API answer that wasn't a success, in words safe to show. */
export class CloudflareApiError extends Error {
  override name = "CloudflareApiError";
  constructor(
    message: string,
    /** HTTP status; 0 when the request never got an answer. */
    readonly status: number,
  ) {
    super(message);
  }
}

/** Where DNS-01 records are written. */
export interface CloudflareZone {
  zoneId: string;
  apiToken: string;
}

interface Envelope<T> {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
}

async function call<T>(
  zone: CloudflareZone,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await (transport ?? fetch)(`${CLOUDFLARE_API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${zone.apiToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CloudflareApiError(
      `Cloudflare API unreachable: ${err instanceof Error ? err.message : "request failed"}`,
      0,
    );
  }
  let parsed: Envelope<T> | null = null;
  try {
    parsed = (await res.json()) as Envelope<T>;
  } catch {
    // Non-JSON answers (an HTML error page) are reported by status below.
  }
  if (!res.ok || !parsed?.success) {
    const detail = parsed?.errors
      ?.map((e) => e.message)
      .filter(Boolean)
      .join("; ");
    throw new CloudflareApiError(
      `Cloudflare API answered ${res.status}${detail ? `: ${detail}` : ""}`.slice(0, 300),
      res.status,
    );
  }
  return parsed.result as T;
}

/**
 * Checks that a token can read a zone and its DNS records.
 *
 * @param zone - Zone ID and token.
 * @returns The zone's name, e.g. `example.com`.
 * @throws {CloudflareApiError} When the zone is missing or the token lacks access.
 */
export async function verifyZone(zone: CloudflareZone): Promise<string> {
  if (!/^[a-f0-9]{32}$/.test(zone.zoneId)) {
    throw new CloudflareApiError("A zone ID is 32 hexadecimal characters.", 400);
  }
  const info = await call<{ name?: string; status?: string }>(zone, "GET", `/zones/${zone.zoneId}`);
  if (typeof info?.name !== "string" || !info.name) {
    throw new CloudflareApiError("Cloudflare returned the zone without a name.", 200);
  }
  await call<unknown[]>(zone, "GET", `/zones/${zone.zoneId}/dns_records?per_page=1`);
  return info.name.toLowerCase();
}

/**
 * Whether a name is the zone or inside it.
 *
 * @param name - A DNS name.
 * @param zoneName - The zone, e.g. `example.com`.
 * @returns `true` for `example.com` and anything under it.
 */
export function inZone(name: string, zoneName: string): boolean {
  return name === zoneName || name.endsWith(`.${zoneName}`);
}

/**
 * Writes a DNS-01 challenge TXT record.
 *
 * @param zone - Zone ID and token.
 * @param name - The record name, e.g. `_acme-challenge.apps.example.com`.
 * @param value - The challenge value (base64url, no quotes needed).
 * @returns The record's ID, to delete it later.
 */
export async function createTxtRecord(
  zone: CloudflareZone,
  name: string,
  value: string,
): Promise<string> {
  const record = await call<{ id?: string }>(zone, "POST", `/zones/${zone.zoneId}/dns_records`, {
    type: "TXT",
    name,
    // NOTE: Cloudflare warns about unquoted TXT content; the quotes are
    // not part of the value resolvers return.
    content: `"${value}"`,
    ttl: CHALLENGE_TTL_S,
    comment: "Roundhouse ACME challenge; removed automatically",
  });
  if (typeof record?.id !== "string") {
    throw new CloudflareApiError("Cloudflare created the record without an ID.", 200);
  }
  return record.id;
}

/**
 * Deletes a record; one already gone counts as deleted.
 *
 * @param zone - Zone ID and token.
 * @param recordId - From {@link createTxtRecord}.
 */
export async function deleteRecord(zone: CloudflareZone, recordId: string): Promise<void> {
  try {
    await call(zone, "DELETE", `/zones/${zone.zoneId}/dns_records/${encodeURIComponent(recordId)}`);
  } catch (err) {
    if (err instanceof CloudflareApiError && err.status === 404) return;
    throw err;
  }
}
