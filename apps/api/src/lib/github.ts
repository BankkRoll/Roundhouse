/**
 * The instance's GitHub App: creation through the manifest flow, sealed
 * credential storage, App JWTs (RS256 via WebCrypto), installation tokens,
 * the few REST calls the control plane makes, and webhook signatures.
 *
 * GitHub hands out App private keys as PKCS#1 PEM (`BEGIN RSA PRIVATE KEY`),
 * which WebCrypto can't import; {@link pemToPkcs8} wraps it in a PKCS#8
 * envelope first.
 *
 * @module
 */
import { type Db, instanceSettings } from "@roundhouse/db";
import { fromBase64, toBase64 } from "@roundhouse/protocol";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Sealed } from "./crypto";
import {
  SealedSchema as InstanceSealedSchema,
  type KeyEnv,
  sealInstanceSecret,
  unsealInstanceSecret,
} from "./instance-secrets";
import { SettingKey } from "./settings";

/** GitHub REST API origin. */
export const GITHUB_API = "https://api.github.com";

/** GitHub web origin. */
export const GITHUB_WEB = "https://github.com";

/** The App's permissions: read code, report commit statuses, comment on PRs (previews). */
export const GITHUB_APP_PERMISSIONS = {
  contents: "read",
  metadata: "read",
  statuses: "write",
  pull_requests: "write",
} as const;

/**
 * Events the App subscribes to. `installation` and `installation_repositories`
 * are delivered to every App without subscribing.
 */
export const GITHUB_APP_EVENTS = ["push"] as const;

/** How long a manifest-flow state token is valid. */
export const MANIFEST_STATE_TTL_MS = 10 * 60 * 1000;

const encoder = new TextEncoder();

// -----------------------------------------------------------------------------
// Keys and JWTs
// -----------------------------------------------------------------------------

function concat(...parts: (Uint8Array | number[])[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function der(tag: number, content: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat([tag], derLength(content.length), content);
}

/** DER of `AlgorithmIdentifier { rsaEncryption, NULL }`. */
const RSA_ALGORITHM = Uint8Array.from([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

/**
 * Converts an RSA private key PEM to PKCS#8 DER for `crypto.subtle.importKey`.
 * PKCS#1 keys (`BEGIN RSA PRIVATE KEY`, what GitHub issues) are wrapped in a
 * `PrivateKeyInfo`; PKCS#8 keys (`BEGIN PRIVATE KEY`) pass through.
 *
 * @param pem - PEM text.
 * @returns PKCS#8 DER bytes.
 * @throws When the PEM is neither format.
 */
export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const match = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END \1?PRIVATE KEY-----/.exec(
    pem,
  );
  if (!match) throw new Error("expected an RSA private key in PEM format");
  const body = fromBase64(match[2]!.replace(/\s+/g, ""));
  if (!match[1]) return body;
  // PrivateKeyInfo ::= SEQUENCE { version 0, AlgorithmIdentifier, OCTET STRING(RSAPrivateKey) }
  return der(0x30, concat([0x02, 0x01, 0x00], RSA_ALGORITHM, der(0x04, body)));
}

/**
 * Imports an RSA private key PEM for RS256 signing.
 *
 * @param pem - PKCS#1 or PKCS#8 PEM.
 * @returns A non-extractable signing key.
 */
export function importRsaPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Signs a GitHub App JWT: RS256, issued 60 s in the past to absorb clock
 * skew, valid for 9 minutes (GitHub's maximum is 10).
 *
 * @param appId - The App's numeric ID (the `iss` claim).
 * @param key - Key from {@link importRsaPrivateKey}.
 * @param now - Current time, unix ms.
 * @returns The compact JWT.
 */
export async function appJwt(appId: number, key: CryptoKey, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000) - 60;
  const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(
    encoder.encode(JSON.stringify({ iat, exp: iat + 600, iss: String(appId) })),
  );
  const input = `${header}.${payload}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(input));
  return `${input}.${base64url(sig)}`;
}

// -----------------------------------------------------------------------------
// Stored App
// -----------------------------------------------------------------------------

const SealedSchema = InstanceSealedSchema;

const StoredAppSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
  html_url: z.string(),
  owner_login: z.string().nullable(),
  client_id: z.string(),
  client_secret: SealedSchema,
  webhook_secret: SealedSchema,
  private_key: SealedSchema,
});

/** The App with its secrets unsealed. Never serialise it. */
export interface GithubApp {
  id: number;
  slug: string;
  name: string;
  htmlUrl: string;
  webhookSecret: string;
  privateKeyPem: string;
}

/** Fields of GitHub's manifest conversion response that we keep. */
export interface ManifestConversion {
  id: number;
  slug: string;
  name: string;
  html_url: string;
  owner?: { login?: string } | null;
  client_id: string;
  client_secret: string;
  webhook_secret: string;
  pem: string;
}

const APP = SettingKey.githubApp;

/**
 * Stores the App's credentials, every secret sealed under the KEK.
 *
 * @param db - Database client.
 * @param keys - The master keyring bindings (`c.env`).
 * @param app - GitHub's manifest conversion response.
 */
export async function storeGithubApp(db: Db, keys: KeyEnv, app: ManifestConversion): Promise<void> {
  const value: z.infer<typeof StoredAppSchema> = {
    id: app.id,
    slug: app.slug,
    name: app.name,
    html_url: app.html_url,
    owner_login: app.owner?.login ?? null,
    client_id: app.client_id,
    client_secret: await sealInstanceSecret(keys, app.client_secret, APP, "client_secret"),
    webhook_secret: await sealInstanceSecret(keys, app.webhook_secret, APP, "webhook_secret"),
    private_key: await sealInstanceSecret(keys, app.pem, APP, "private_key"),
  };
  await db
    .insert(instanceSettings)
    .values({ key: SettingKey.githubApp, value })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value, updatedAt: new Date() } });
}

/** Public facts about the App, for status responses. */
export interface GithubAppInfo {
  id: number;
  slug: string;
  name: string;
  htmlUrl: string;
}

/**
 * Reads the App's public facts without unsealing anything.
 *
 * @param db - Database client.
 * @returns The App, or `null` when none has been created.
 */
export async function githubAppInfo(db: Db): Promise<GithubAppInfo | null> {
  const row = await db.query.instanceSettings.findFirst({
    where: eq(instanceSettings.key, SettingKey.githubApp),
  });
  const parsed = StoredAppSchema.safeParse(row?.value);
  if (!parsed.success) return null;
  const { id, slug, name, html_url } = parsed.data;
  return { id, slug, name, htmlUrl: html_url };
}

/**
 * Loads the App with its secrets unsealed.
 *
 * @param db - Database client.
 * @param keys - The master keyring bindings (`c.env`).
 * @returns The App, or `null` when none has been created.
 */
export async function loadGithubApp(db: Db, keys: KeyEnv): Promise<GithubApp | null> {
  const row = await db.query.instanceSettings.findFirst({
    where: eq(instanceSettings.key, SettingKey.githubApp),
  });
  const parsed = StoredAppSchema.safeParse(row?.value);
  if (!parsed.success) return null;
  const a = parsed.data;
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    htmlUrl: a.html_url,
    webhookSecret: await unsealInstanceSecret(
      keys,
      a.webhook_secret as Sealed,
      APP,
      "webhook_secret",
    ),
    privateKeyPem: await unsealInstanceSecret(keys, a.private_key as Sealed, APP, "private_key"),
  };
}

// -----------------------------------------------------------------------------
// REST
// -----------------------------------------------------------------------------

/** A non-2xx answer from GitHub. */
export class GithubApiError extends Error {
  /**
   * @param status - HTTP status GitHub answered with.
   * @param message - GitHub's message.
   */
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GithubApiError";
  }
}

/**
 * Calls the GitHub REST API.
 *
 * @param path - Path under {@link GITHUB_API}, e.g. `/app/installations/1`.
 * @param init - Method, bearer credential and JSON body.
 * @returns The parsed JSON response.
 * @throws {GithubApiError} On a non-2xx answer.
 */
export async function githubRequest<T>(
  path: string,
  init: { method?: string; auth?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "roundhouse",
      ...(init.auth ? { authorization: `Bearer ${init.auth}` } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 200);
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message;
    } catch {
      // Not JSON; keep the raw prefix.
    }
    throw new GithubApiError(res.status, `GitHub ${res.status}: ${message}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * Exchanges a manifest-flow `code` for the new App's credentials. The code
 * itself is the credential, valid for one hour and one use.
 *
 * @param code - From GitHub's redirect.
 * @returns The conversion response, secrets included.
 */
export function exchangeManifestCode(code: string): Promise<ManifestConversion> {
  return githubRequest<ManifestConversion>(
    `/app-manifests/${encodeURIComponent(code)}/conversions`,
    { method: "POST" },
  );
}

/**
 * Builds the App manifest for this control plane.
 *
 * @param origin - Control plane origin; every URL GitHub calls lives under it.
 * @param name - App name; must be unique on GitHub.
 * @returns The manifest object.
 */
export function buildManifest(origin: string, name: string): Record<string, unknown> {
  const callback = `${origin}/v1/github/callback`;
  return {
    name,
    url: origin,
    hook_attributes: { url: `${origin}/v1/webhooks/github`, active: true },
    redirect_url: callback,
    callback_urls: [callback],
    setup_url: callback,
    setup_on_update: true,
    public: false,
    default_permissions: GITHUB_APP_PERMISSIONS,
    default_events: GITHUB_APP_EVENTS,
  };
}

/** An installation as GitHub describes it. */
export interface GithubInstallationInfo {
  id: number;
  account: { login: string; type: string } | null;
}

/**
 * Fetches an installation with an App JWT, proving it belongs to our App.
 *
 * @param app - The App.
 * @param installationId - GitHub's numeric installation ID.
 * @returns The installation.
 */
export async function getInstallation(
  app: GithubApp,
  installationId: number,
): Promise<GithubInstallationInfo> {
  const jwt = await appJwt(app.id, await importRsaPrivateKey(app.privateKeyPem));
  return githubRequest<GithubInstallationInfo>(`/app/installations/${installationId}`, {
    auth: jwt,
  });
}

/**
 * Mints an installation access token (valid for one hour), optionally
 * narrowed to some repositories and permissions.
 *
 * @param app - The App.
 * @param installationId - GitHub's numeric installation ID.
 * @param scope - Repository names (without owner) and permissions to narrow to.
 * @returns The token and its expiry.
 */
export async function installationToken(
  app: GithubApp,
  installationId: number,
  scope: { repositories?: string[]; permissions?: Record<string, string> } = {},
): Promise<{ token: string; expires_at: string }> {
  const jwt = await appJwt(app.id, await importRsaPrivateKey(app.privateKeyPem));
  const body = {
    ...(scope.repositories ? { repositories: scope.repositories } : {}),
    ...(scope.permissions ? { permissions: scope.permissions } : {}),
  };
  return githubRequest(`/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    auth: jwt,
    body,
  });
}

/** A repository as GitHub lists it for an installation. */
export interface GithubRepo {
  id: number;
  full_name: string;
  private: boolean;
  default_branch: string;
  clone_url: string;
}

/** Most repository pages fetched per installation (100 per page). */
const MAX_REPO_PAGES = 10;

/**
 * Lists repositories an installation token can read.
 *
 * @param token - Installation access token.
 * @returns Up to 1000 repositories.
 */
export async function listInstallationRepositories(token: string): Promise<GithubRepo[]> {
  const out: GithubRepo[] = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const res = await githubRequest<{ total_count: number; repositories: GithubRepo[] }>(
      `/installation/repositories?per_page=100&page=${page}`,
      { auth: token },
    );
    out.push(...res.repositories);
    if (res.repositories.length < 100 || out.length >= res.total_count) break;
  }
  return out;
}

/** Commit status states. */
export type CommitState = "pending" | "success" | "failure" | "error";

/**
 * Posts a commit status.
 *
 * @param token - Installation token with `statuses: write`.
 * @param fullName - `owner/repo`.
 * @param sha - Commit SHA.
 * @param status - State, link, description and context.
 */
export async function createCommitStatus(
  token: string,
  fullName: string,
  sha: string,
  status: { state: CommitState; target_url: string; description: string; context: string },
): Promise<void> {
  await githubRequest(`/repos/${fullName}/statuses/${sha}`, {
    method: "POST",
    auth: token,
    body: { ...status, description: status.description.slice(0, 140) },
  });
}

// -----------------------------------------------------------------------------
// Repositories and webhooks
// -----------------------------------------------------------------------------

/**
 * Normalises a clone URL for comparison: lowercase host and path, no `.git`,
 * no trailing slash.
 *
 * @param url - Clone or HTML URL.
 * @returns The normalised URL.
 */
export function normalizeRepoUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

/**
 * `owner/repo` of a github.com clone URL.
 *
 * @param repoUrl - Clone URL.
 * @returns The full name, or `null` for other hosts.
 */
export function githubFullName(repoUrl: string): string | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(repoUrl.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Verifies `X-Hub-Signature-256` over the raw request body.
 *
 * SECURITY: `crypto.subtle.verify` compares the MAC in constant time, and the
 * caller runs this before parsing a single byte of the body.
 *
 * @param secret - The App's webhook secret.
 * @param body - Raw request body.
 * @param header - `sha256=<hex>`.
 * @returns `true` when the signature matches.
 */
export async function verifyWebhookSignature(
  secret: string,
  body: ArrayBuffer,
  header: string,
): Promise<boolean> {
  const m = /^sha256=([a-f0-9]{64})$/.exec(header);
  if (!m) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, hexToBytes(m[1]!), body);
}
