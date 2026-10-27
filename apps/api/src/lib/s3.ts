/**
 * A minimal S3 client for backups (ADR 0004, "Storage"): AWS Signature
 * Version 4 over WebCrypto, path-style addressing, and only the calls
 * backups need.
 *
 * - {@link signV4} and {@link presignV4}: header and query signing. The
 *   canonical forms follow S3's rules (paths encoded once, never normalised).
 * - {@link createMultipartUpload}, {@link presignUploadPart},
 *   {@link completeMultipartUpload}, {@link abortMultipartUpload},
 *   {@link headObject}, {@link deleteObject}, {@link presignGet}.
 *
 * NOTE: Written instead of depending on `aws4fetch` (which ADR 0004 names):
 * the signer is ~150 lines, every byte of it is tested against AWS's
 * published vectors, and the same code then presigns and signs, so the
 * Worker carries no dependency that sees the secret access key.
 *
 * SECURITY: presigned URLs are credentials. They name exactly one object
 * (and one part), expire in at most {@link MAX_PRESIGN_EXPIRES_S}, and are
 * never logged, stored, or put in an error message; errors carry only the
 * operation, the HTTP status and S3's error code.
 *
 * @module
 */
/** Where backups live and the credentials that reach them. */
export interface S3Config {
  /** Origin of the S3 API, e.g. `https://<account>.r2.cloudflarestorage.com`. */
  endpoint: string;
  bucket: string;
  /** SigV4 region; `auto` for R2. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** A part of a multipart upload, for {@link completeMultipartUpload}. */
export interface CompletedPart {
  partNumber: number;
  etag: string;
}

/** An S3 call that failed. The message never contains a URL or a signature. */
export class S3Error extends Error {
  override name = "S3Error";

  /**
   * @param operation - The S3 operation, e.g. `CompleteMultipartUpload`.
   * @param status - HTTP status, or 0 when the request never got an answer.
   * @param code - S3's error code (`NoSuchUpload`, `AccessDenied`, …), if any.
   */
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(`S3 ${operation} failed: ${status || "network error"}${code ? ` ${code}` : ""}`);
  }
}

/** Longest lifetime of a presigned URL S3 accepts (7 days); backups use far less. */
export const MAX_PRESIGN_EXPIRES_S = 7 * 24 * 3600;

/** Lifetime of an `UploadPart` URL (ADR 0004: at most 1 h). */
export const UPLOAD_PART_URL_TTL_S = 3600;

/** Lifetime of a download URL handed to a person (`GET …/download`). */
export const DOWNLOAD_URL_TTL_S = 15 * 60;

/** Lifetime of the download URL a restore sends to the agent. */
export const RESTORE_URL_TTL_S = 3600;

/** SHA-256 of the empty string, the payload hash of body-less requests. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const ALGORITHM = "AWS4-HMAC-SHA256";
const encoder = new TextEncoder();

// -----------------------------------------------------------------------------
// Transport
// -----------------------------------------------------------------------------

type Transport = (request: Request) => Promise<Response>;

const defaultTransport: Transport = (request) => fetch(request);
let transport: Transport = defaultTransport;

/**
 * Replaces the HTTP transport, so tests run against a fake S3.
 *
 * @param next - A fetch-like function; omit to restore the real `fetch`.
 */
export function setS3Transport(next?: Transport): void {
  transport = next ?? defaultTransport;
}

// -----------------------------------------------------------------------------
// Signature Version 4
// -----------------------------------------------------------------------------

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Lowercase hex SHA-256.
 *
 * @param data - Bytes, or a string encoded as UTF-8.
 * @returns 64 hex characters.
 */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as Uint8Array<ArrayBuffer>,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, encoder.encode(data));
}

/**
 * RFC 3986 percent-encoding as SigV4 wants it: every byte but
 * `A-Z a-z 0-9 - _ . ~` is encoded, in uppercase hex.
 *
 * @param value - Text to encode.
 * @param keepSlash - Leave `/` alone (object key paths).
 * @returns The encoded text.
 */
export function uriEncode(value: string, keepSlash = false): string {
  let out = "";
  for (const byte of encoder.encode(value)) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(ch) || (keepSlash && ch === "/")) out += ch;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * Canonical query string: each name and value encoded, sorted by name and
 * then value.
 *
 * @param params - Decoded name/value pairs.
 * @returns E.g. `partNumber=1&uploadId=abc`.
 */
export function canonicalQuery(params: readonly (readonly [string, string])[]): string {
  return params
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/**
 * The SigV4 signing key for a day, region and service.
 *
 * @param secretAccessKey - The secret.
 * @param date - `YYYYMMDD`.
 * @param region - E.g. `us-east-1`.
 * @param service - E.g. `s3`.
 * @returns The 32-byte key.
 */
export async function signingKey(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(encoder.encode(`AWS4${secretAccessKey}`), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

/**
 * Formats a time as SigV4's `X-Amz-Date`.
 *
 * @param ms - Unix milliseconds.
 * @returns E.g. `20150830T123600Z`.
 */
export function amzDate(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** What to sign. */
export interface SignInput {
  method: string;
  /** Absolute URL; its query becomes part of the canonical request. */
  url: string;
  /** Headers to sign, in addition to `host` (taken from the URL). */
  headers?: Record<string, string>;
  /** Hex SHA-256 of the body, or `UNSIGNED-PAYLOAD`. */
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Unix milliseconds. */
  now: number;
}

/** A signature and the intermediate forms, so tests can compare each against AWS's vectors. */
export interface Signed {
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  signedHeaders: string;
  /** The `Authorization` header value. */
  authorization: string;
  /** `X-Amz-Date` used. */
  date: string;
}

function canonicalPath(url: URL): string {
  // URL keeps the path percent-encoded; S3 signs it decoded and re-encoded once.
  return uriEncode(decodeURIComponent(url.pathname), true) || "/";
}

function queryPairs(url: URL): [string, string][] {
  if (!url.search) return [];
  // NOTE: Split by hand: URLSearchParams turns `+` into a space, which S3 does not.
  return url.search
    .slice(1)
    .split("&")
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf("=");
      const k = i < 0 ? pair : pair.slice(0, i);
      const v = i < 0 ? "" : pair.slice(i + 1);
      return [decodeURIComponent(k), decodeURIComponent(v)];
    });
}

/**
 * Signs a request with SigV4 (header form).
 *
 * @param input - Request and credentials.
 * @returns The signature, its intermediate forms and the `Authorization` value.
 */
export async function signV4(input: SignInput): Promise<Signed> {
  const url = new URL(input.url);
  const date = amzDate(input.now);
  const day = date.slice(0, 8);
  const headers = new Map<string, string>([["host", url.host]]);
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    headers.set(k.toLowerCase(), v.trim().replace(/\s+/g, " "));
  }
  const names = [...headers.keys()].sort();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url),
    canonicalQuery(queryPairs(url)),
    `${names.map((n) => `${n}:${headers.get(n)}`).join("\n")}\n`,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [ALGORITHM, date, scope, await sha256Hex(canonicalRequest)].join("\n");
  const key = await signingKey(input.secretAccessKey, day, input.region, input.service);
  const signature = hex(await hmac(key, stringToSign));
  return {
    canonicalRequest,
    stringToSign,
    signature,
    signedHeaders,
    authorization: `${ALGORITHM} Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    date,
  };
}

/** What to presign. */
export interface PresignInput {
  method: string;
  /** Absolute URL, with any operation parameters (`partNumber`, `uploadId`) already in its query. */
  url: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Unix milliseconds. */
  now: number;
  /** Seconds the URL stays valid, 1..{@link MAX_PRESIGN_EXPIRES_S}. */
  expiresIn: number;
  /** Service name; `s3` unless a test vector says otherwise. */
  service?: string;
}

/**
 * Presigns a request (query form): only `host` is signed and the payload is
 * `UNSIGNED-PAYLOAD`, so the holder may send any body but only to this
 * method, URL and window.
 *
 * @param input - Request, credentials and lifetime.
 * @returns The presigned URL.
 * @throws {RangeError} For a lifetime outside 1..{@link MAX_PRESIGN_EXPIRES_S}.
 */
export async function presignV4(input: PresignInput): Promise<string> {
  if (
    !Number.isInteger(input.expiresIn) ||
    input.expiresIn < 1 ||
    input.expiresIn > MAX_PRESIGN_EXPIRES_S
  ) {
    throw new RangeError("presigned URL lifetime out of range");
  }
  const service = input.service ?? "s3";
  const url = new URL(input.url);
  const date = amzDate(input.now);
  const scope = `${date.slice(0, 8)}/${input.region}/${service}/aws4_request`;
  const params: [string, string][] = [
    ...queryPairs(url),
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${input.accessKeyId}/${scope}`],
    ["X-Amz-Date", date],
    ["X-Amz-Expires", String(input.expiresIn)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url),
    canonicalQuery(params),
    `host:${url.host}\n`,
    "host",
    UNSIGNED_PAYLOAD,
  ].join("\n");
  const stringToSign = [ALGORITHM, date, scope, await sha256Hex(canonicalRequest)].join("\n");
  const key = await signingKey(input.secretAccessKey, date.slice(0, 8), input.region, service);
  const signature = hex(await hmac(key, stringToSign));
  return `${url.origin}${canonicalPath(url)}?${canonicalQuery([
    ...params,
    ["X-Amz-Signature", signature],
  ])}`;
}

// -----------------------------------------------------------------------------
// Operations
// -----------------------------------------------------------------------------

/**
 * Path-style URL of an object.
 *
 * @param cfg - Storage settings.
 * @param key - Object key.
 * @param query - Operation parameters.
 * @returns E.g. `https://s3.example/bucket/backups/…?uploads=`.
 */
export function objectUrl(
  cfg: Pick<S3Config, "endpoint" | "bucket">,
  key: string,
  query: Record<string, string> = {},
): string {
  const base = cfg.endpoint.replace(/\/+$/, "");
  const search = Object.entries(query)
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .join("&");
  return `${base}/${uriEncode(cfg.bucket)}/${uriEncode(key, true)}${search ? `?${search}` : ""}`;
}

function xmlField(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return m ? decodeXml(m[1]!) : null;
}

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function encodeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function send(
  cfg: S3Config,
  operation: string,
  method: string,
  url: string,
  body?: string,
  now = Date.now(),
): Promise<Response> {
  const payloadHash = body === undefined ? EMPTY_SHA256 : await sha256Hex(body);
  const headers: Record<string, string> = { "x-amz-content-sha256": payloadHash };
  const signed = await signV4({
    method,
    url,
    headers: { ...headers, "x-amz-date": amzDate(now) },
    payloadHash,
    region: cfg.region,
    service: "s3",
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    now,
  });
  const request = new Request(url, {
    method,
    headers: {
      ...headers,
      "x-amz-date": signed.date,
      authorization: signed.authorization,
      ...(body !== undefined ? { "content-type": "application/xml" } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
  try {
    return await transport(request);
  } catch {
    throw new S3Error(operation, 0, null);
  }
}

async function failure(operation: string, res: Response): Promise<S3Error> {
  const text = await res.text().catch(() => "");
  return new S3Error(operation, res.status, xmlField(text, "Code"));
}

/**
 * Starts a multipart upload.
 *
 * @param cfg - Storage settings.
 * @param key - Object key.
 * @returns The upload ID.
 * @throws {S3Error} When S3 refuses or is unreachable.
 */
export async function createMultipartUpload(cfg: S3Config, key: string): Promise<string> {
  const op = "CreateMultipartUpload";
  const res = await send(cfg, op, "POST", objectUrl(cfg, key, { uploads: "" }));
  if (!res.ok) throw await failure(op, res);
  const uploadId = xmlField(await res.text(), "UploadId");
  if (!uploadId) throw new S3Error(op, res.status, "MissingUploadId");
  return uploadId;
}

/**
 * Presigns one `UploadPart`.
 *
 * @param cfg - Storage settings.
 * @param key - Object key.
 * @param uploadId - From {@link createMultipartUpload}.
 * @param partNumber - 1..10,000.
 * @param now - Unix ms.
 * @param expiresIn - Seconds; {@link UPLOAD_PART_URL_TTL_S} by default.
 * @returns A URL the agent `PUT`s exactly one part to.
 */
export function presignUploadPart(
  cfg: S3Config,
  key: string,
  uploadId: string,
  partNumber: number,
  now = Date.now(),
  expiresIn = UPLOAD_PART_URL_TTL_S,
): Promise<string> {
  return presignV4({
    method: "PUT",
    url: objectUrl(cfg, key, { partNumber: String(partNumber), uploadId }),
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    now,
    expiresIn,
  });
}

/**
 * Presigns a `PUT` of a whole object (an archived WAL file), so the holder
 * can write exactly this key, once per URL lifetime.
 *
 * @param cfg - Storage settings.
 * @param key - Object key.
 * @param expiresIn - Seconds, e.g. {@link UPLOAD_PART_URL_TTL_S}.
 * @param now - Unix ms.
 * @returns The URL.
 */
export function presignPut(
  cfg: S3Config,
  key: string,
  expiresIn: number,
  now = Date.now(),
): Promise<string> {
  return presignV4({
    method: "PUT",
    url: objectUrl(cfg, key),
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    now,
    expiresIn,
  });
}

/**
 * Presigns a `GET` of a whole object.
 *
 * @param cfg - Storage settings.
 * @param key - Object key.
 * @param expiresIn - Seconds, e.g. {@link DOWNLOAD_URL_TTL_S}.
 * @param now - Unix ms.
 * @returns The URL.
 */
export function presignGet(
  cfg: S3Config,
  key: string,
  expiresIn: number,
  now = Date.now(),
): Promise<string> {
  return presignV4({
    method: "GET",
    url: objectUrl(cfg, key),
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    now,
    expiresIn,
  });
}

/**
 * Completes a multipart upload.
 *
 * @param cfg - Storage settings.
 * @param key - Object key.
 * @param uploadId - The upload.
 * @param parts - Every part, ascending by number.
 * @returns The object's ETag.
 * @throws {S3Error} Also when S3 answers 200 with an error document, which
 *   CompleteMultipartUpload may do after it started streaming the reply.
 */
export async function completeMultipartUpload(
  cfg: S3Config,
  key: string,
  uploadId: string,
  parts: readonly CompletedPart[],
): Promise<string | null> {
  const op = "CompleteMultipartUpload";
  const body = `<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${parts
    .map(
      (p) =>
        `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>${encodeXml(p.etag)}</ETag></Part>`,
    )
    .join("")}</CompleteMultipartUpload>`;
  const res = await send(cfg, op, "POST", objectUrl(cfg, key, { uploadId }), body);
  if (!res.ok) throw await failure(op, res);
  const text = await res.text();
  if (/<Error>/.test(text)) throw new S3Error(op, res.status, xmlField(text, "Code"));
  return xmlField(text, "ETag");
}

/**
 * Aborts a multipart upload, discarding its parts. An upload that is
 * already gone counts as aborted.
 *
 * @param cfg - Storage settings.
 * @param key - Object key.
 * @param uploadId - The upload.
 * @throws {S3Error} For any other failure.
 */
export async function abortMultipartUpload(
  cfg: S3Config,
  key: string,
  uploadId: string,
): Promise<void> {
  const op = "AbortMultipartUpload";
  const res = await send(cfg, op, "DELETE", objectUrl(cfg, key, { uploadId }));
  if (res.ok || res.status === 404) {
    await res.body?.cancel();
    return;
  }
  throw await failure(op, res);
}

/**
 * Reads an object's size.
 *
 * @param cfg - Storage settings.
 * @param key - Object key.
 * @returns `{ size }`, or `null` when there is no such object.
 * @throws {S3Error} For any other failure.
 */
export async function headObject(cfg: S3Config, key: string): Promise<{ size: number } | null> {
  const op = "HeadObject";
  const res = await send(cfg, op, "HEAD", objectUrl(cfg, key));
  await res.body?.cancel();
  if (res.status === 404) return null;
  if (!res.ok) throw new S3Error(op, res.status, null);
  const size = Number(res.headers.get("content-length"));
  if (!Number.isFinite(size)) throw new S3Error(op, res.status, "MissingContentLength");
  return { size };
}

/**
 * Deletes an object. A missing object counts as deleted.
 *
 * @param cfg - Storage settings.
 * @param key - Object key.
 * @throws {S3Error} For any other failure.
 */
export async function deleteObject(cfg: S3Config, key: string): Promise<void> {
  const op = "DeleteObject";
  const res = await send(cfg, op, "DELETE", objectUrl(cfg, key));
  if (res.ok || res.status === 404) {
    await res.body?.cancel();
    return;
  }
  throw await failure(op, res);
}
