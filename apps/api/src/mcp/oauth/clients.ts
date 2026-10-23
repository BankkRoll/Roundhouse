/**
 * MCP OAuth clients, identified by Client ID Metadata Documents (ADR 0012:
 * DCR is not offered). A `client_id` is an HTTPS URL; the document it serves
 * names the client and lists its redirect URIs. Documents are fetched with a
 * size cap, a timeout and no redirects, then cached for 24 h in
 * `oauth_clients`.
 *
 * Also the redirect URI rules every client must follow: HTTPS, or plain HTTP
 * on a loopback address, matched exactly against the document.
 *
 * @module
 */
import { type Db, oauthClients } from "@roundhouse/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { hashToken } from "../../lib/crypto";
import { OAuthFailure } from "./errors";

/** Most bytes read from a client metadata document (ADR 0012: 64 KiB). */
export const MAX_CLIENT_METADATA_BYTES = 64 * 1024;

/** How long a client metadata fetch may take (ADR 0012: 5 s). */
export const CLIENT_METADATA_TIMEOUT_MS = 5_000;

/** How long a fetched document is trusted before it is fetched again (ADR 0012: 24 h). */
export const CLIENT_METADATA_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_REDIRECT_URIS = 20;
const MAX_URL_LENGTH = 2048;

/** A client as the authorization server knows it. */
export interface OAuthClient {
  /** The metadata document's URL. */
  clientId: string;
  name: string;
  /** Host of `clientId`, which consent always shows (ADR 0012). */
  domain: string;
  logoUri: string | null;
  clientUri: string | null;
  redirectUris: readonly string[];
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Whether `raw` is an acceptable redirect URI: HTTPS, or HTTP on a loopback
 * host, absolute, with no fragment or credentials.
 *
 * @param raw - Candidate URI.
 * @returns `true` when a client may register it.
 * @example
 * isAllowedRedirectUri("http://127.0.0.1:33418/callback"); // true
 * isAllowedRedirectUri("http://example.com/callback"); // false
 */
export function isAllowedRedirectUri(raw: string): boolean {
  if (raw.length > MAX_URL_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash || raw.includes("#") || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Whether a presented redirect URI matches a registered one. Matching is
 * exact string comparison, except that a loopback HTTP URI may use any port
 * (OAuth 2.1 section 8.4.2, RFC 8252 section 7.3): native clients bind an
 * ephemeral port at sign-in, so their documents can't name it.
 *
 * @param registered - URIs from the client's metadata document.
 * @param presented - `redirect_uri` from the request.
 * @returns `true` when `presented` is one of `registered`.
 */
export function redirectUriMatches(registered: readonly string[], presented: string): boolean {
  if (!isAllowedRedirectUri(presented)) return false;
  if (registered.includes(presented)) return true;
  const p = new URL(presented);
  if (p.protocol !== "http:") return false;
  return registered.some((r) => {
    let u: URL;
    try {
      u = new URL(r);
    } catch {
      return false;
    }
    return (
      u.protocol === "http:" &&
      u.hostname === p.hostname &&
      u.pathname === p.pathname &&
      u.search === p.search
    );
  });
}

/**
 * Whether `raw` can be a client ID: an HTTPS URL with a path, naming a host
 * by DNS name, without fragment, credentials or dot segments.
 *
 * SECURITY: The server fetches this URL, so IP literals and loopback names
 * are refused outright rather than relying on the platform's egress rules.
 */
function clientIdUrl(raw: string): URL | null {
  if (raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.href !== raw) return null;
  if (url.pathname === "/" || url.hash || url.username || url.password) return null;
  if (/\/\.\.?(\/|$)/.test(raw.slice(url.origin.length))) return null;
  const host = url.hostname;
  if (host === "localhost" || host.endsWith(".localhost") || host.startsWith("[")) return null;
  if (/^[\d.]+$/.test(host) || !host.includes(".")) return null;
  return url;
}

const HttpsUrl = z
  .string()
  .max(MAX_URL_LENGTH)
  .refine((v) => {
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  });

const ClientMetadataDocument = z.object({
  client_id: z.string(),
  client_name: z.string().trim().min(1).max(200).optional(),
  client_uri: z.unknown().optional(),
  logo_uri: z.unknown().optional(),
  redirect_uris: z.array(z.string()).min(1).max(MAX_REDIRECT_URIS),
  token_endpoint_auth_method: z.literal("none").optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  client_secret: z.never().optional(),
  client_secret_expires_at: z.never().optional(),
});

async function readCapped(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_CLIENT_METADATA_BYTES) return null;
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_CLIENT_METADATA_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

const invalidClient = (description: string) =>
  new OAuthFailure("invalid_client", `Client metadata document: ${description}`);

/**
 * Fetches and validates a client metadata document.
 *
 * @param url - The client ID.
 * @returns The client it describes.
 * @throws {OAuthFailure} `invalid_client` when the document can't be fetched
 *   or fails validation.
 */
async function fetchClientMetadata(url: URL): Promise<Omit<OAuthClient, "domain">> {
  let res: Response;
  try {
    res = await fetch(url.href, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(CLIENT_METADATA_TIMEOUT_MS),
    });
  } catch {
    throw invalidClient("could not be fetched");
  }
  if (res.status !== 200) {
    await res.body?.cancel();
    throw invalidClient(
      res.status >= 300 && res.status < 400 ? "redirects are not followed" : `HTTP ${res.status}`,
    );
  }
  const text = await readCapped(res);
  if (text === null) throw invalidClient(`larger than ${MAX_CLIENT_METADATA_BYTES} bytes`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw invalidClient("not JSON");
  }
  const parsed = ClientMetadataDocument.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalidClient(`${issue?.path.join(".") || "document"} is invalid`);
  }
  const doc = parsed.data;
  if (doc.client_id !== url.href) throw invalidClient("client_id does not match its URL");
  if (doc.grant_types && !doc.grant_types.includes("authorization_code")) {
    throw invalidClient("grant_types must include authorization_code");
  }
  if (doc.response_types && !doc.response_types.includes("code")) {
    throw invalidClient("response_types must include code");
  }
  const badRedirect = doc.redirect_uris.find((u) => !isAllowedRedirectUri(u));
  if (badRedirect !== undefined) {
    throw invalidClient("redirect_uris must be https, or http on a loopback address");
  }
  const optionalHttps = (v: unknown) => (HttpsUrl.safeParse(v).success ? (v as string) : null);
  return {
    clientId: url.href,
    name: doc.client_name ?? url.hostname,
    logoUri: optionalHttps(doc.logo_uri),
    clientUri: optionalHttps(doc.client_uri),
    redirectUris: doc.redirect_uris,
  };
}

/** Hooks for {@link resolveClient}. */
export interface ResolveClientOptions {
  /** Called before a network fetch; throw to refuse (e.g. a rate limit). */
  beforeFetch?: () => Promise<void>;
  now?: number;
}

/**
 * Looks up a client by its ID, fetching (or refreshing) its metadata
 * document when the cached copy is missing or older than 24 h.
 *
 * @param db - Database client.
 * @param clientId - Untrusted `client_id` parameter.
 * @param options - Rate-limit hook and clock.
 * @returns The client.
 * @throws {OAuthFailure} `invalid_client` for an unusable client ID or document.
 */
export async function resolveClient(
  db: Db,
  clientId: string,
  options: ResolveClientOptions = {},
): Promise<OAuthClient> {
  const url = clientIdUrl(clientId);
  if (!url) {
    throw new OAuthFailure(
      "invalid_client",
      "client_id must be the HTTPS URL of a client metadata document",
    );
  }
  const now = options.now ?? Date.now();
  const [cached] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, url.href))
    .limit(1);
  if (cached && now - +cached.fetchedAt < CLIENT_METADATA_TTL_MS) {
    return { ...toClient(cached), domain: url.hostname };
  }
  await options.beforeFetch?.();
  const fresh = await fetchClientMetadata(url);
  const row = {
    id: await hashToken(fresh.clientId),
    clientId: fresh.clientId,
    name: fresh.name,
    logoUri: fresh.logoUri,
    clientUri: fresh.clientUri,
    redirectUris: [...fresh.redirectUris],
    fetchedAt: new Date(now),
  };
  await db
    .insert(oauthClients)
    .values(row)
    .onConflictDoUpdate({
      target: oauthClients.clientId,
      set: {
        name: row.name,
        logoUri: row.logoUri,
        clientUri: row.clientUri,
        redirectUris: row.redirectUris,
        fetchedAt: row.fetchedAt,
        updatedAt: new Date(now),
      },
    });
  return { ...fresh, domain: url.hostname };
}

function toClient(row: typeof oauthClients.$inferSelect): Omit<OAuthClient, "domain"> {
  return {
    clientId: row.clientId,
    name: row.name,
    logoUri: row.logoUri,
    clientUri: row.clientUri,
    redirectUris: row.redirectUris,
  };
}
