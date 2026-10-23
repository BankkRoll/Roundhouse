/**
 * The S3 client: SigV4 against AWS's published test-suite vectors (and the
 * AWS SDK for Go v2 for presigning, which the suite doesn't cover), presign
 * scope and expiry, and multipart uploads against a fake S3 that enforces
 * R2's rules.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  deleteObject,
  headObject,
  objectUrl,
  presignGet,
  presignUploadPart,
  presignV4,
  S3Error,
  setS3Transport,
  signingKey,
  signV4,
} from "../src/lib/s3";
import { FAKE_S3, FakeS3, R2_MIN_PART_BYTES } from "./fake-s3";

// AWS SigV4 test suite (aws-sig-v4-test-suite): the published example
// credentials, region and time every vector uses.
const SUITE = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "service",
  now: Date.UTC(2015, 7, 30, 12, 36, 0),
};
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

afterEach(() => setS3Transport());

describe("SigV4 test suite", () => {
  const sign = (method: string, url: string, headers: Record<string, string> = {}) =>
    signV4({
      ...SUITE,
      method,
      url,
      headers: { "X-Amz-Date": "20150830T123600Z", ...headers },
      payloadHash: EMPTY,
    });

  it("get-vanilla: canonical request, string to sign and signature", async () => {
    const s = await sign("GET", "https://example.amazonaws.com/");
    expect(s.canonicalRequest).toBe(
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        EMPTY,
      ].join("\n"),
    );
    expect(s.stringToSign).toBe(
      [
        "AWS4-HMAC-SHA256",
        "20150830T123600Z",
        "20150830/us-east-1/service/aws4_request",
        "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
      ].join("\n"),
    );
    expect(s.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it.each([
    [
      "get-vanilla-query-order-key-case",
      "GET",
      "https://example.amazonaws.com/?Param2=value2&Param1=value1",
      "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    ],
    [
      "get-vanilla-empty-query-key",
      "GET",
      "https://example.amazonaws.com/?Param1=value1",
      "a67d582fa61cc504c4bae71f336f98b97f1ea3c7a6bfe1b6e45aec72011b9aeb",
    ],
    [
      "post-vanilla",
      "POST",
      "https://example.amazonaws.com/",
      "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
    ],
  ])("%s", async (_name, method, url, signature) => {
    expect((await sign(method, url)).signature).toBe(signature);
  });

  it("trims and collapses header values (checked against the Go SDK)", async () => {
    const s = await sign("GET", "https://example.amazonaws.com/", {
      "My-Header1": " value1",
      "My-Header2": ' "a   b   c"',
    });
    expect(s.signedHeaders).toBe("host;my-header1;my-header2;x-amz-date");
    expect(s.canonicalRequest).toContain('my-header2:"a b c"\n');
    expect(s.signature).toBe("acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736");
  });

  it("derives the documented signing key", async () => {
    // AWS General Reference, "Examples of how to derive a signing key".
    const key = await signingKey(SUITE.secretAccessKey, "20120215", "us-east-1", "iam");
    expect(hex(key)).toBe("f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
  });
});

describe("presigning", () => {
  const now = Date.UTC(2026, 9, 23, 3, 0, 0);
  const key = "backups/prj_1/svc_1/env_1/bak_1.rhbk.zst.age";

  it("matches the AWS SDK for Go v2 for UploadPart and GET", async () => {
    // Reference URLs from aws-sdk-go-v2 v1.47.0 `v4.Signer.PresignHTTP`
    // with the fake credentials, region `auto`, and UNSIGNED-PAYLOAD.
    const part = await presignUploadPart(FAKE_S3_GO, key, "up-1+x", 7, now, 3600);
    expect(part).toBe(
      "https://s3.test/roundhouse-backups/backups/prj_1/svc_1/env_1/bak_1.rhbk.zst.age?" +
        "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=test-access-key-id%2F20261023%2Fauto%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20261023T030000Z&X-Amz-Expires=3600&X-Amz-Signature=1c6c8926417d7de1bc4effc6c6313331c5a69d33885b2093b6c534940bfec8d5" +
        "&X-Amz-SignedHeaders=host&partNumber=7&uploadId=up-1%2Bx",
    );
    const get = new URL(await presignGet(FAKE_S3_GO, key, 900, now));
    expect(get.searchParams.get("X-Amz-Signature")).toBe(
      "dff3b875cc5413afa748eb41e06101c27fdd94ccba18acf31cebd96b5b3583ae",
    );
  });

  it("scopes a part URL to one object, part and upload, signing only host", async () => {
    const url = new URL(await presignUploadPart(FAKE_S3, key, "upload-1", 3, now));
    expect(url.pathname).toBe(`/roundhouse-backups/${key}`);
    expect(url.searchParams.get("partNumber")).toBe("3");
    expect(url.searchParams.get("uploadId")).toBe("upload-1");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "test-access-key-id/20261023/auto/s3/aws4_request",
    );
    expect(url.toString()).not.toContain("test-secret-access-key");
  });

  it("refuses lifetimes outside S3's bounds", async () => {
    const base = { ...FAKE_S3, url: "https://s3.fake.test/b/k", method: "GET", now };
    await expect(presignV4({ ...base, expiresIn: 0 })).rejects.toThrow(RangeError);
    await expect(presignV4({ ...base, expiresIn: 7 * 86400 + 1 })).rejects.toThrow(RangeError);
  });

  it("is refused by the fake once expired, and when tampered with", async () => {
    const fake = new FakeS3();
    setS3Transport(fake.fetch);
    const uploadId = await createMultipartUpload(FAKE_S3, key);
    const url = await presignUploadPart(FAKE_S3, key, uploadId, 1, Date.now(), 60);
    const other = url.replace("partNumber=1", "partNumber=2");
    expect((await fake.put(other, new Uint8Array(4))).status).toBe(403);
    fake.now = () => Date.now() + 61_000;
    expect((await fake.put(url, new Uint8Array(4))).status).toBe(403);
    fake.now = () => Date.now();
    expect((await fake.put(url, new Uint8Array(4))).status).toBe(200);
  });
});

/** The bucket the Go reference URLs were generated for. */
const FAKE_S3_GO = { ...FAKE_S3, endpoint: "https://s3.test" };

describe("multipart against the fake S3", () => {
  const key = "backups/prj_1/svc_1/env_1/bak_2.rhbk.zst.age";

  async function upload(fake: FakeS3, sizes: number[]) {
    const uploadId = await createMultipartUpload(FAKE_S3, key);
    const parts = [];
    for (const [i, size] of sizes.entries()) {
      const url = await presignUploadPart(FAKE_S3, key, uploadId, i + 1);
      const res = await fake.put(url, new Uint8Array(size).fill(i + 1));
      expect(res.status).toBe(200);
      parts.push({ partNumber: i + 1, etag: res.headers.get("etag")! });
    }
    return { uploadId, parts };
  }

  it("uploads, completes, heads, presigns a GET and deletes", async () => {
    const fake = new FakeS3();
    setS3Transport(fake.fetch);
    const { uploadId, parts } = await upload(fake, [R2_MIN_PART_BYTES, R2_MIN_PART_BYTES, 1234]);
    await completeMultipartUpload(FAKE_S3, key, uploadId, parts);
    expect(await headObject(FAKE_S3, key)).toEqual({ size: 2 * R2_MIN_PART_BYTES + 1234 });

    const get = await fake.fetch(new Request(await presignGet(FAKE_S3, key, 900)));
    expect(get.status).toBe(200);
    expect((await get.arrayBuffer()).byteLength).toBe(2 * R2_MIN_PART_BYTES + 1234);

    await deleteObject(FAKE_S3, key);
    expect(await headObject(FAKE_S3, key)).toBeNull();
    await deleteObject(FAKE_S3, key);
  });

  it("enforces R2's part rules", async () => {
    const fake = new FakeS3();
    setS3Transport(fake.fetch);
    const small = await upload(fake, [1024, 1024]);
    await expect(
      completeMultipartUpload(FAKE_S3, key, small.uploadId, small.parts),
    ).rejects.toMatchObject({ code: "EntityTooSmall" });

    const uneven = await upload(fake, [R2_MIN_PART_BYTES, R2_MIN_PART_BYTES + 1, 10]);
    await expect(
      completeMultipartUpload(FAKE_S3, key, uneven.uploadId, uneven.parts),
    ).rejects.toMatchObject({ code: "InvalidPart" });

    const wrongEtag = await upload(fake, [10]);
    await expect(
      completeMultipartUpload(FAKE_S3, key, wrongEtag.uploadId, [
        { partNumber: 1, etag: '"nope"' },
      ]),
    ).rejects.toBeInstanceOf(S3Error);

    const tooMany = await createMultipartUpload(FAKE_S3, key);
    const url = await presignV4({
      ...FAKE_S3,
      method: "PUT",
      url: objectUrl(FAKE_S3, key, { partNumber: "10001", uploadId: tooMany }),
      now: Date.now(),
      expiresIn: 60,
    });
    expect((await fake.put(url, new Uint8Array(1))).status).toBe(400);
  });

  it("aborts an upload, treating a gone one as aborted", async () => {
    const fake = new FakeS3();
    setS3Transport(fake.fetch);
    const { uploadId } = await upload(fake, [100]);
    await abortMultipartUpload(FAKE_S3, key, uploadId);
    expect(fake.uploads.size).toBe(0);
    await abortMultipartUpload(FAKE_S3, key, uploadId);
  });

  it("reports failures without URLs or signatures", async () => {
    const fake = new FakeS3();
    setS3Transport(fake.fetch);
    fake.failNext.CreateMultipartUpload = 503;
    const err = await createMultipartUpload(FAKE_S3, key).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(S3Error);
    expect((err as S3Error).message).toBe("S3 CreateMultipartUpload failed: 503 InternalError");

    setS3Transport(async () => {
      throw new Error(`fetch https://s3.fake.test/${key}?X-Amz-Signature=deadbeef failed`);
    });
    const net = await headObject(FAKE_S3, key).catch((e: unknown) => e);
    expect((net as Error).message).toBe("S3 HeadObject failed: network error");
  });

  it("rejects requests signed with the wrong secret", async () => {
    const fake = new FakeS3();
    setS3Transport(fake.fetch);
    const err = await createMultipartUpload({ ...FAKE_S3, secretAccessKey: "wrong" }, key).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ status: 403, code: "SignatureDoesNotMatch" });
  });
});
