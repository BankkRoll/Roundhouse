/**
 * An in-memory S3 for tests, enforcing what R2 enforces: SigV4 on every
 * request (header or presigned query, with expiry), multipart parts of at
 * least 5 MiB that are all the same size except the last, at most 10,000
 * parts, and ETags that match what was uploaded.
 *
 * Install it with `setS3Transport(fake.fetch)`; play the agent with
 * {@link FakeS3.put} on a presigned part URL.
 */
import { amzDate, presignV4, type S3Config, sha256Hex, signV4 } from "../src/lib/s3";

const MIB = 1024 * 1024;

/** R2's smallest non-final part. */
export const R2_MIN_PART_BYTES = 5 * MIB;

/** R2's part limit. */
export const R2_MAX_PARTS = 10_000;

interface Upload {
  key: string;
  parts: Map<number, { etag: string; bytes: Uint8Array }>;
}

/** Fake bucket credentials; obviously not real. */
export const FAKE_S3: S3Config = {
  endpoint: "https://s3.fake.test",
  bucket: "roundhouse-backups",
  region: "auto",
  accessKeyId: "test-access-key-id",
  secretAccessKey: "test-secret-access-key",
};

/** One request as the fake saw it, without its signature. */
export interface SeenRequest {
  method: string;
  /** `CreateMultipartUpload`, `UploadPart`, … */
  op: string;
  key: string;
  presigned: boolean;
}

const xml = (body: string, status = 200) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    status,
    headers: { "content-type": "application/xml" },
  });
const error = (status: number, code: string) =>
  xml(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`, status);

/** The fake S3. */
export class FakeS3 {
  readonly objects = new Map<string, Uint8Array>();
  readonly uploads = new Map<string, Upload>();
  readonly seen: SeenRequest[] = [];
  /** Clock used for presign expiry; tests may move it. */
  now = () => Date.now();
  /** Operations to fail once with the given status, e.g. `{ CompleteMultipartUpload: 500 }`. */
  failNext: Partial<Record<string, number>> = {};
  private nextUpload = 1;

  constructor(readonly cfg: S3Config = FAKE_S3) {}

  /** Transport for `setS3Transport`. */
  fetch = (request: Request): Promise<Response> => this.handle(request);

  /**
   * Uploads a body to a presigned URL, as the agent does.
   *
   * @param url - Presigned `UploadPart` URL.
   * @param bytes - Part body.
   * @returns The response (ETag header on success).
   */
  put(url: string, bytes: Uint8Array): Promise<Response> {
    return this.handle(new Request(url, { method: "PUT", body: bytes }));
  }

  private async verify(request: Request, url: URL): Promise<Response | null> {
    const q = url.searchParams;
    const presigned = q.has("X-Amz-Signature");
    if (presigned) {
      const date = q.get("X-Amz-Date")!;
      const expires = Number(q.get("X-Amz-Expires"));
      const issued = Date.UTC(
        +date.slice(0, 4),
        +date.slice(4, 6) - 1,
        +date.slice(6, 8),
        +date.slice(9, 11),
        +date.slice(11, 13),
        +date.slice(13, 15),
      );
      if (!(expires > 0) || this.now() > issued + expires * 1000) {
        return error(403, "AccessDenied");
      }
      const unsigned = new URL(url);
      for (const k of [
        "X-Amz-Algorithm",
        "X-Amz-Credential",
        "X-Amz-Date",
        "X-Amz-Expires",
        "X-Amz-SignedHeaders",
        "X-Amz-Signature",
      ]) {
        unsigned.searchParams.delete(k);
      }
      const expected = await presignV4({
        method: request.method,
        url: unsigned.toString().replace(/\+/g, "%20"),
        region: this.cfg.region,
        accessKeyId: this.cfg.accessKeyId,
        secretAccessKey: this.cfg.secretAccessKey,
        now: issued,
        expiresIn: expires,
      });
      const sig = new URL(expected).searchParams.get("X-Amz-Signature");
      return sig === q.get("X-Amz-Signature") ? null : error(403, "SignatureDoesNotMatch");
    }
    const auth = request.headers.get("authorization") ?? "";
    const date = request.headers.get("x-amz-date") ?? "";
    const payloadHash = request.headers.get("x-amz-content-sha256") ?? "";
    const m = /SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
    if (!m || !auth.includes(`Credential=${this.cfg.accessKeyId}/`)) {
      return error(403, "AccessDenied");
    }
    const body = new Uint8Array(await request.clone().arrayBuffer());
    if ((await sha256Hex(body)) !== payloadHash) return error(400, "XAmzContentSHA256Mismatch");
    const issued = Date.UTC(
      +date.slice(0, 4),
      +date.slice(4, 6) - 1,
      +date.slice(6, 8),
      +date.slice(9, 11),
      +date.slice(11, 13),
      +date.slice(13, 15),
    );
    if (amzDate(issued) !== date) return error(403, "AccessDenied");
    const headers: Record<string, string> = {};
    for (const name of m[1]!.split(";")) {
      if (name !== "host") headers[name] = request.headers.get(name) ?? "";
    }
    const signed = await signV4({
      method: request.method,
      url: url.toString(),
      headers,
      payloadHash,
      region: this.cfg.region,
      service: "s3",
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      now: issued,
    });
    return signed.signature === m[2] ? null : error(403, "SignatureDoesNotMatch");
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== new URL(this.cfg.endpoint).origin) return error(404, "NoSuchHost");
    const prefix = `/${this.cfg.bucket}/`;
    if (!url.pathname.startsWith(prefix)) return error(404, "NoSuchBucket");
    const key = decodeURIComponent(url.pathname.slice(prefix.length));
    const q = url.searchParams;
    const op =
      request.method === "POST" && q.has("uploads")
        ? "CreateMultipartUpload"
        : request.method === "PUT" && q.has("partNumber")
          ? "UploadPart"
          : request.method === "POST" && q.has("uploadId")
            ? "CompleteMultipartUpload"
            : request.method === "DELETE" && q.has("uploadId")
              ? "AbortMultipartUpload"
              : request.method === "HEAD"
                ? "HeadObject"
                : request.method === "GET"
                  ? "GetObject"
                  : request.method === "DELETE"
                    ? "DeleteObject"
                    : "Unknown";
    this.seen.push({ method: request.method, op, key, presigned: q.has("X-Amz-Signature") });
    const denied = await this.verify(request, url);
    if (denied) return denied;
    const injected = this.failNext[op];
    if (injected) {
      delete this.failNext[op];
      return error(injected, "InternalError");
    }

    switch (op) {
      case "CreateMultipartUpload": {
        const id = `upload-${this.nextUpload++}`;
        this.uploads.set(id, { key, parts: new Map() });
        return xml(
          `<InitiateMultipartUploadResult><Bucket>${this.cfg.bucket}</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
      }
      case "UploadPart": {
        const upload = this.uploads.get(q.get("uploadId")!);
        if (!upload || upload.key !== key) return error(404, "NoSuchUpload");
        const n = Number(q.get("partNumber"));
        if (!Number.isInteger(n) || n < 1 || n > R2_MAX_PARTS) return error(400, "InvalidArgument");
        const bytes = new Uint8Array(await request.arrayBuffer());
        const etag = `"${(await sha256Hex(bytes)).slice(0, 32)}"`;
        upload.parts.set(n, { etag, bytes });
        return new Response(null, { status: 200, headers: { etag } });
      }
      case "CompleteMultipartUpload": {
        const upload = this.uploads.get(q.get("uploadId")!);
        if (!upload || upload.key !== key) return error(404, "NoSuchUpload");
        const body = await request.text();
        const listed = [
          ...body.matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]*)<\/ETag>/g),
        ].map((m) => ({ n: Number(m[1]), etag: m[2]!.replace(/&quot;/g, '"') }));
        if (!listed.length || listed.length > R2_MAX_PARTS) return error(400, "InvalidRequest");
        const chunks: Uint8Array[] = [];
        for (const [i, p] of listed.entries()) {
          const part = upload.parts.get(p.n);
          if (!part || part.etag !== p.etag) return error(400, "InvalidPart");
          if (i > 0 && p.n <= listed[i - 1]!.n) return error(400, "InvalidPartOrder");
          const last = i === listed.length - 1;
          if (!last && part.bytes.byteLength < R2_MIN_PART_BYTES) {
            return error(400, "EntityTooSmall");
          }
          if (!last && i > 0 && part.bytes.byteLength !== chunks[0]!.byteLength) {
            // R2: every non-final part has the same size.
            return error(400, "InvalidPart");
          }
          if (last && i > 0 && part.bytes.byteLength > chunks[0]!.byteLength) {
            return error(400, "InvalidPart");
          }
          chunks.push(part.bytes);
        }
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) {
          out.set(c, at);
          at += c.byteLength;
        }
        this.objects.set(key, out);
        this.uploads.delete(q.get("uploadId")!);
        return xml(
          `<CompleteMultipartUploadResult><Key>${key}</Key><ETag>"etag-${listed.length}"</ETag></CompleteMultipartUploadResult>`,
        );
      }
      case "AbortMultipartUpload":
        if (!this.uploads.delete(q.get("uploadId")!)) return error(404, "NoSuchUpload");
        return new Response(null, { status: 204 });
      case "HeadObject": {
        const o = this.objects.get(key);
        return o
          ? new Response(null, { status: 200, headers: { "content-length": String(o.byteLength) } })
          : new Response(null, { status: 404 });
      }
      case "GetObject": {
        const o = this.objects.get(key);
        return o ? new Response(o, { status: 200 }) : error(404, "NoSuchKey");
      }
      case "DeleteObject":
        this.objects.delete(key);
        return new Response(null, { status: 204 });
      default:
        return error(400, "NotImplemented");
    }
  }
}
