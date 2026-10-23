/**
 * An RFC 8555 ACME client for the Workers runtime (WebCrypto + fetch only).
 *
 * Responsibilities:
 * - directory discovery and URL policy (HTTPS only unless `allowInsecure`);
 * - the replay-nonce pool, with bounded `badNonce` retries;
 * - JWS-signed requests (`jwk` for newAccount, `kid` after) and POST-as-GET;
 * - problem documents into {@link AcmeError}, `Retry-After` into ms;
 * - account registration, orders, authorizations, challenges, finalization,
 *   certificate download and ARI (RFC 9773) renewal information.
 *
 * The client is stateless apart from caches, so a Workflow step can rebuild
 * it from `{ directoryUrl, accountKey, accountUrl }` and continue an order by
 * URL. It never polls or sleeps: waiting is the caller's job, guided by
 * {@link AcmeClient.lastRetryAfterMs}.
 *
 * SECURITY: nothing here logs. The account key never leaves the client except
 * through the caller's own copy, and error messages carry only the CA's
 * problem detail.
 *
 * @module
 */

import { splitPemChain } from "./certificate";
import { base64UrlEncode, toArrayBuffer, utf8 } from "./encoding";
import { normalizeHostnames } from "./hostnames";
import {
  type AccountSigner,
  importAccountKey,
  type JwsKeyRef,
  jwkThumbprint,
  signJws,
} from "./jws";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** An RFC 7807 problem document as ACME servers return it (RFC 8555 §6.7). */
export interface AcmeProblem {
  /** e.g. `urn:ietf:params:acme:error:unauthorized`. */
  type: string;
  detail?: string;
  status?: number;
  /** Per-identifier problems (RFC 8555 §6.7.1). */
  subproblems?: AcmeSubproblem[];
}

/** One entry of a problem document's `subproblems`. */
export interface AcmeSubproblem {
  type: string;
  detail?: string;
  identifier?: { type: string; value: string };
}

/** An ACME order object (RFC 8555 §7.1.3). */
export type AcmeOrder = {
  status: "pending" | "ready" | "processing" | "valid" | "invalid";
  identifiers: { type: "dns"; value: string }[];
  authorizations: string[];
  finalize: string;
  certificate?: string;
  error?: AcmeProblem;
  expires?: string;
};

/** An ACME authorization object (RFC 8555 §7.1.4). */
export type AcmeAuthorization = {
  status: "pending" | "valid" | "invalid" | "deactivated" | "expired" | "revoked";
  identifier: { type: "dns"; value: string };
  wildcard?: boolean;
  challenges: AcmeChallenge[];
  expires?: string;
};

/** An ACME challenge object (RFC 8555 §7.1.5, §8). */
export type AcmeChallenge = {
  type: string;
  url: string;
  token: string;
  status: "pending" | "processing" | "valid" | "invalid";
  error?: AcmeProblem;
  validated?: string;
};

/** The ACME directory (RFC 8555 §7.1.1, plus RFC 9773 `renewalInfo`). */
export interface AcmeDirectory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
  revokeCert?: string;
  keyChange?: string;
  renewalInfo?: string;
  meta?: { termsOfService?: string; website?: string; profiles?: Record<string, string> };
}

/** An ARI suggested renewal window with the server's polling hint. */
export interface RenewalInfo {
  /** Window start, ms since the epoch. */
  start: number;
  /** Window end, ms since the epoch. */
  end: number;
  /** When to poll again, from `Retry-After`; `null` when absent. */
  retryAfterMs: number | null;
}

/** Options for {@link AcmeClient}. */
export interface AcmeClientOptions {
  /** The CA's directory URL, e.g. Let's Encrypt production. */
  directoryUrl: string;
  /** The account's private EC P-256 JWK (from {@link generateAccountKey}). */
  accountKey: JsonWebKey;
  /** The account URL (`kid`) from an earlier {@link AcmeClient.register}. */
  accountUrl?: string | null;
  /** A fetch implementation; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Allow `http:` URLs. Test-only: ACME over plain HTTP exposes the account. */
  allowInsecure?: boolean;
  /** Per-request timeout in ms (default 30 s). */
  timeoutMs?: number;
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

const ERR = "urn:ietf:params:acme:error:";

/** Problem type for responses this client could not interpret. */
export const MALFORMED_RESPONSE = "urn:roundhouse:acme:malformedResponse";

/** Problem type for transport failures (timeouts, connection errors). */
export const TRANSPORT_ERROR = "urn:roundhouse:acme:transport";

/**
 * A failed ACME request: the server's problem document, or a synthesised one
 * for transport and parsing failures.
 */
export class AcmeError extends Error {
  /** Problem type URN, e.g. `urn:ietf:params:acme:error:rateLimited`. */
  readonly type: string;
  /** HTTP status (0 for transport failures). */
  readonly status: number;
  /** Human-readable detail from the server. */
  readonly detail: string;
  /** Per-identifier subproblems, as sent. */
  readonly subproblems: unknown[];
  /** `Retry-After` in ms, when the server sent one. */
  readonly retryAfterMs: number | null;

  /**
   * @param init - The problem fields.
   */
  constructor(init: {
    type: string;
    status: number;
    detail: string;
    subproblems?: unknown[];
    retryAfterMs?: number | null;
  }) {
    super(`${init.detail || "ACME request failed"} (${init.type}, HTTP ${init.status})`);
    this.name = "AcmeError";
    this.type = init.type;
    this.status = init.status;
    this.detail = init.detail;
    this.subproblems = init.subproblems ?? [];
    this.retryAfterMs = init.retryAfterMs ?? null;
  }

  /**
   * Whether this is the given ACME error (short name or full URN).
   *
   * @param name - e.g. `rateLimited` or `urn:ietf:params:acme:error:rateLimited`.
   * @returns `true` on a match.
   */
  is(name: string): boolean {
    return this.type === name || this.type === ERR + name;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1 << 20;
const MAX_NONCE_ATTEMPTS = 3;
const NONCE_POOL_SIZE = 16;
const USER_AGENT = "roundhouse-acme/1";

/**
 * Parses a `Retry-After` header (delta-seconds or HTTP-date) into ms from now.
 *
 * @param value - The header value, or `null`.
 * @param now - The current time in ms, injectable for tests.
 * @returns A non-negative delay in ms, or `null` when absent or unparseable.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
}

async function readLimited(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new AcmeError({
        type: MALFORMED_RESPONSE,
        status: res.status,
        detail: "response too large",
      });
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(what: string, status = 200): AcmeError {
  return new AcmeError({
    type: MALFORMED_RESPONSE,
    status,
    detail: `malformed ${what} from ACME server`,
  });
}

function parseJson(raw: RawResponse, what: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw.text);
    if (isObject(value)) return value;
  } catch {
    // Falls through to the malformed-response error below.
  }
  throw malformed(what, raw.status);
}

function problemFrom(raw: RawResponse, retryAfterMs: number | null): AcmeError {
  let body: unknown;
  try {
    body = JSON.parse(raw.text);
  } catch {
    body = null;
  }
  if (isObject(body) && typeof body.type === "string") {
    return new AcmeError({
      type: body.type,
      status: typeof body.status === "number" ? body.status : raw.status,
      detail: typeof body.detail === "string" ? body.detail : "",
      subproblems: Array.isArray(body.subproblems) ? body.subproblems : [],
      retryAfterMs,
    });
  }
  return new AcmeError({
    type: `urn:roundhouse:acme:http${raw.status}`,
    status: raw.status,
    detail: `ACME server returned HTTP ${raw.status}`,
    retryAfterMs,
  });
}

function asOrder(value: Record<string, unknown>): AcmeOrder {
  if (
    typeof value.status !== "string" ||
    !Array.isArray(value.authorizations) ||
    !value.authorizations.every((a) => typeof a === "string") ||
    typeof value.finalize !== "string" ||
    !Array.isArray(value.identifiers)
  ) {
    throw malformed("order");
  }
  return value as unknown as AcmeOrder;
}

function asAuthorization(value: Record<string, unknown>): AcmeAuthorization {
  if (
    typeof value.status !== "string" ||
    !isObject(value.identifier) ||
    !Array.isArray(value.challenges) ||
    !value.challenges.every(isChallengeShape)
  ) {
    throw malformed("authorization");
  }
  return value as unknown as AcmeAuthorization;
}

function isChallengeShape(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.type === "string" &&
    typeof value.url === "string" &&
    typeof value.status === "string" &&
    (value.token === undefined || typeof value.token === "string")
  );
}

function asChallenge(value: Record<string, unknown>): AcmeChallenge {
  if (!isChallengeShape(value)) throw malformed("challenge");
  return value as unknown as AcmeChallenge;
}

// -----------------------------------------------------------------------------
// Client
// -----------------------------------------------------------------------------

/**
 * An ACME account session against one CA directory.
 *
 * @example
 * const client = new AcmeClient({ directoryUrl, accountKey });
 * const kid = await client.register({ contact: ["mailto:ops@example.com"] });
 * const order = await client.newOrder(["example.com"]);
 */
export class AcmeClient {
  readonly #directoryUrl: string;
  readonly #accountKey: JsonWebKey;
  readonly #fetch: typeof fetch;
  readonly #allowInsecure: boolean;
  readonly #timeoutMs: number;
  #accountUrl: string | null;
  #directory: Promise<AcmeDirectory> | null = null;
  #signer: Promise<AccountSigner> | null = null;
  #thumbprint: Promise<string> | null = null;
  #nonces: string[] = [];
  #lastRetryAfterMs: number | null = null;

  /**
   * @param opts - Directory, account key and optional account URL and transport.
   * @throws {Error} When the directory URL is not HTTPS (and `allowInsecure` is off).
   */
  constructor(opts: AcmeClientOptions) {
    this.#allowInsecure = opts.allowInsecure === true;
    this.#directoryUrl = this.#checkUrl(opts.directoryUrl);
    this.#accountKey = opts.accountKey;
    this.#accountUrl = opts.accountUrl ?? null;
    // Bound so a bare global `fetch` is not called with a foreign `this`.
    this.#fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** The account URL (`kid`), once registered or supplied. */
  get accountUrl(): string | null {
    return this.#accountUrl;
  }

  /**
   * The `Retry-After` of the most recent response in ms, or `null`. Order and
   * authorization polling should wait at least this long before the next look.
   */
  get lastRetryAfterMs(): number | null {
    return this.#lastRetryAfterMs;
  }

  /**
   * Fetches (once) and returns the directory.
   *
   * @returns The directory object.
   */
  directory(): Promise<AcmeDirectory> {
    this.#directory ??= this.#loadDirectory().catch((err: unknown) => {
      this.#directory = null;
      throw err;
    });
    return this.#directory;
  }

  /**
   * Creates the account, or finds the existing one for this key (RFC 8555
   * §7.3), agreeing to the CA's terms of service.
   *
   * @param opts - Optional `mailto:` contacts.
   * @returns The account URL, used as `kid` from then on.
   */
  async register(opts: { contact?: string[] } = {}): Promise<string> {
    const dir = await this.directory();
    const payload: Record<string, unknown> = { termsOfServiceAgreed: true };
    if (opts.contact?.length) payload.contact = opts.contact;
    const signer = await this.#getSigner();
    const res = await this.#post(dir.newAccount, payload, { jwk: signer.publicJwk });
    const location = res.headers.get("location");
    if (!location) throw malformed("account (no Location)", res.status);
    this.#accountUrl = this.#checkUrl(location);
    return this.#accountUrl;
  }

  /**
   * Places a new order.
   *
   * @param hostnames - DNS names to certify (validated, lowercased, de-duplicated).
   * @param opts - `replaces`: the ARI certificate id of the certificate this
   * order renews (RFC 9773 §5), which exempts it from rate limits at Let's Encrypt.
   * @returns The order and its URL.
   */
  async newOrder(
    hostnames: string[],
    opts: { replaces?: string } = {},
  ): Promise<AcmeOrder & { url: string }> {
    const dir = await this.directory();
    const identifiers = normalizeHostnames(hostnames).map((value) => ({ type: "dns", value }));
    const payload: Record<string, unknown> = { identifiers };
    if (opts.replaces) payload.replaces = opts.replaces;
    const res = await this.#post(dir.newOrder, payload);
    const location = res.headers.get("location");
    if (!location) throw malformed("order (no Location)", res.status);
    return { ...asOrder(parseJson(res, "order")), url: this.#checkUrl(location) };
  }

  /**
   * Fetches an order by URL (POST-as-GET).
   *
   * @param url - The order URL.
   * @returns The order.
   */
  async getOrder(url: string): Promise<AcmeOrder> {
    return asOrder(parseJson(await this.#post(url, null), "order"));
  }

  /**
   * Fetches an authorization by URL (POST-as-GET).
   *
   * @param url - The authorization URL.
   * @returns The authorization.
   */
  async getAuthorization(url: string): Promise<AcmeAuthorization> {
    return asAuthorization(parseJson(await this.#post(url, null), "authorization"));
  }

  /**
   * The key authorization for a challenge token (RFC 8555 §8.1).
   *
   * @param token - The challenge token.
   * @returns `token "." base64url(thumbprint)`; the HTTP-01 response body.
   */
  async keyAuthorization(token: string): Promise<string> {
    if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("invalid ACME challenge token");
    this.#thumbprint ??= this.#getSigner().then((s) => jwkThumbprint(s.publicJwk));
    return `${token}.${await this.#thumbprint}`;
  }

  /**
   * The DNS-01 TXT record value for a challenge token (RFC 8555 §8.4).
   *
   * @param token - The challenge token.
   * @returns `base64url(sha256(keyAuthorization))`.
   */
  async dns01Value(token: string): Promise<string> {
    const keyAuth = await this.keyAuthorization(token);
    const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(utf8(keyAuth)));
    return base64UrlEncode(new Uint8Array(digest));
  }

  /**
   * Tells the server a challenge is ready for validation (POST `{}`).
   *
   * @param url - The challenge URL.
   * @returns The challenge as the server now reports it.
   */
  async respondToChallenge(url: string): Promise<AcmeChallenge> {
    return asChallenge(parseJson(await this.#post(url, {}), "challenge"));
  }

  /**
   * Submits the CSR for a `ready` order.
   *
   * @param finalizeUrl - The order's `finalize` URL.
   * @param csrDer - The DER CSR from {@link createCsr}.
   * @returns The order (usually `processing` or `valid`).
   */
  async finalize(finalizeUrl: string, csrDer: Uint8Array): Promise<AcmeOrder> {
    const res = await this.#post(finalizeUrl, { csr: base64UrlEncode(csrDer) });
    return asOrder(parseJson(res, "order"));
  }

  /**
   * Downloads an issued certificate chain.
   *
   * @param url - The order's `certificate` URL.
   * @returns The PEM chain, leaf first, re-armoured canonically (64-column
   * base64, `\n` endings, one trailing `\n`) so its SHA-256 is stable.
   */
  async downloadCertificate(url: string): Promise<string> {
    const res = await this.#post(url, null, undefined, "application/pem-certificate-chain");
    const blocks = splitPemChain(res.text);
    if (blocks.length === 0) throw malformed("certificate chain", res.status);
    return blocks.join("");
  }

  /**
   * Fetches ARI renewal information (RFC 9773 §4), unauthenticated.
   *
   * @param certId - The certificate's ARI identifier (see {@link ariCertId}).
   * @returns The suggested window and polling hint; `null` when the CA does not
   * offer ARI or returns an unusable window (the caller then falls back to
   * the one-third rule, as RFC 9773 §4.2 permits).
   */
  async renewalInfo(certId: string): Promise<RenewalInfo | null> {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(certId)) throw new Error("invalid ARI cert id");
    const dir = await this.directory();
    if (!dir.renewalInfo) return null;
    const res = await this.#send(`${dir.renewalInfo.replace(/\/+$/, "")}/${certId}`, {
      method: "GET",
    });
    if (res.status !== 200) throw problemFrom(res, this.#lastRetryAfterMs);
    const body = parseJson(res, "renewalInfo");
    const window = body.suggestedWindow;
    if (!isObject(window) || typeof window.start !== "string" || typeof window.end !== "string") {
      return null;
    }
    const start = Date.parse(window.start);
    const end = Date.parse(window.end);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
    return { start, end, retryAfterMs: this.#lastRetryAfterMs };
  }

  // ---------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------

  #checkUrl(url: string): string {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("invalid ACME URL");
    }
    if (parsed.protocol !== "https:" && !(this.#allowInsecure && parsed.protocol === "http:")) {
      throw new Error(`ACME URLs must be https: (got ${parsed.protocol})`);
    }
    return parsed.href;
  }

  #getSigner(): Promise<AccountSigner> {
    this.#signer ??= importAccountKey(this.#accountKey);
    return this.#signer;
  }

  async #loadDirectory(): Promise<AcmeDirectory> {
    const res = await this.#send(this.#directoryUrl, { method: "GET" });
    if (res.status !== 200) throw problemFrom(res, this.#lastRetryAfterMs);
    const body = parseJson(res, "directory");
    for (const key of ["newNonce", "newAccount", "newOrder"] as const) {
      if (typeof body[key] !== "string") throw malformed("directory");
      this.#checkUrl(body[key]);
    }
    if (body.renewalInfo !== undefined) {
      if (typeof body.renewalInfo !== "string") throw malformed("directory");
      this.#checkUrl(body.renewalInfo);
    }
    return body as unknown as AcmeDirectory;
  }

  async #send(
    url: string,
    init: { method: string; body?: string; contentType?: string; accept?: string },
  ): Promise<RawResponse> {
    const headers: Record<string, string> = { "user-agent": USER_AGENT };
    if (init.contentType) headers["content-type"] = init.contentType;
    if (init.accept) headers.accept = init.accept;
    let res: Response;
    try {
      res = await this.#fetch(this.#checkUrl(url), {
        method: init.method,
        headers,
        body: init.body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      // COMPAT: the abort reason is a DOMException, which is not an Error subclass everywhere.
      const name = (err as { name?: unknown } | null)?.name;
      const timedOut = name === "TimeoutError" || name === "AbortError";
      throw new AcmeError({
        type: TRANSPORT_ERROR,
        status: 0,
        detail: timedOut ? "ACME request timed out" : "ACME request failed",
      });
    }
    const nonce = res.headers.get("replay-nonce");
    if (nonce && /^[A-Za-z0-9_-]+$/.test(nonce)) {
      this.#nonces.push(nonce);
      if (this.#nonces.length > NONCE_POOL_SIZE) this.#nonces.shift();
    }
    this.#lastRetryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
    const text = init.method === "HEAD" ? "" : await readLimited(res);
    return { status: res.status, headers: res.headers, text };
  }

  async #takeNonce(): Promise<string> {
    const pooled = this.#nonces.pop();
    if (pooled) return pooled;
    const dir = await this.directory();
    const res = await this.#send(dir.newNonce, { method: "HEAD" });
    const nonce = this.#nonces.pop();
    if (res.status >= 400 || !nonce) throw malformed("newNonce response", res.status);
    return nonce;
  }

  /**
   * Signs and POSTs `payload` (`null` = POST-as-GET), retrying `badNonce`
   * with the fresh nonce the rejection carries (RFC 8555 §6.5).
   */
  async #post(
    url: string,
    payload: unknown | null,
    keyRef?: JwsKeyRef,
    accept?: string,
  ): Promise<RawResponse> {
    const checked = this.#checkUrl(url);
    let ref = keyRef;
    if (!ref) {
      if (!this.#accountUrl) throw new Error("ACME account not registered; call register() first");
      ref = { kid: this.#accountUrl };
    }
    const signer = await this.#getSigner();
    for (let attempt = 1; ; attempt++) {
      const nonce = await this.#takeNonce();
      const jws = await signJws(signer, ref, nonce, checked, payload);
      const res = await this.#send(checked, {
        method: "POST",
        body: JSON.stringify(jws),
        contentType: "application/jose+json",
        accept,
      });
      if (res.status < 300) return res;
      const error = problemFrom(res, this.#lastRetryAfterMs);
      if (error.is("badNonce") && attempt < MAX_NONCE_ATTEMPTS) continue;
      throw error;
    }
  }
}
