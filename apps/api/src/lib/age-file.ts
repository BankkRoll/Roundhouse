/**
 * The age v1 file format (https://age-encryption.org/v1) with one X25519
 * recipient, for data the control plane encrypts itself: shell recordings
 * (ADR 0012 "Recording"), encrypted to the project's backup recipient
 * (`./backups/keys`) and readable with `age -d -i` and the same identity.
 *
 * - {@link ageEncrypt}: a fresh file key wrapped to the recipient (an
 *   `X25519` stanza), the header MAC, and the STREAM payload in 64 KiB
 *   ChaCha20-Poly1305 chunks.
 * - {@link ageDecrypt}: the inverse, for an identity; any other stanza type
 *   is skipped, as age does.
 *
 * Interoperability with `filippo.io/age` is covered by
 * `test/age-file.test.ts` (a file it wrote decrypts here, and the reverse).
 *
 * @module
 */
import { fromBase64, toBase64 } from "@roundhouse/protocol";
import { bech32Decode } from "./age";
import { chacha20poly1305Open, chacha20poly1305Seal } from "./chacha20-poly1305";

const VERSION_LINE = "age-encryption.org/v1";
const X25519_INFO = "age-encryption.org/v1/X25519";
const CHUNK = 64 * 1024;
const TAG = 16;
const X25519 = { name: "X25519" } as const;
// NOTE: WebCrypto imports X25519 private keys only as PKCS#8: this fixed
// 16-byte DER prefix wraps the raw scalar (RFC 8410), as in `@roundhouse/protocol`'s box.
const PKCS8_X25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Base64 without padding, as age writes it. */
function b64(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/=+$/, "");
}

function unb64(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]*$/.test(text)) throw new Error("age: invalid base64");
  return fromBase64(text.padEnd(Math.ceil(text.length / 4) * 4, "="));
}

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm as Uint8Array<ArrayBuffer>, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: salt as Uint8Array<ArrayBuffer>,
        info: encoder.encode(info),
      },
      key,
      256,
    ),
  );
}

async function headerMac(fileKey: Uint8Array, header: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    await hkdf(fileKey, new Uint8Array(0), "header"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(header)));
}

function x25519(publicKey: CryptoKey, privateKey: CryptoKey): Promise<ArrayBuffer> {
  // COMPAT: @cloudflare/workers-types names the peer key `$public`; the
  // runtime field is `public` (see `@roundhouse/protocol`'s box).
  const params = { name: "X25519", public: publicKey } as unknown as Parameters<
    SubtleCrypto["deriveBits"]
  >[0];
  return crypto.subtle.deriveBits(params, privateKey, 256);
}

function streamNonce(counter: number, last: boolean): Uint8Array {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(3, BigInt(counter), false);
  nonce[11] = last ? 1 : 0;
  return nonce;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function recipientKeyBytes(recipient: string): Uint8Array<ArrayBuffer> {
  const { hrp, bytes } = bech32Decode(recipient);
  if (hrp !== "age" || bytes.byteLength !== 32) throw new Error("age: not an X25519 recipient");
  return new Uint8Array(bytes);
}

/**
 * Encrypts bytes to one age X25519 recipient.
 *
 * @param recipient - `age1…`.
 * @param plaintext - The data.
 * @returns The binary age file.
 * @example
 * const file = await ageEncrypt(project.backupRecipient, gzipped);
 */
export async function ageEncrypt(recipient: string, plaintext: Uint8Array): Promise<Uint8Array> {
  const theirs = recipientKeyBytes(recipient);
  const fileKey = crypto.getRandomValues(new Uint8Array(16));
  try {
    const pair = (await crypto.subtle.generateKey(X25519, true, ["deriveBits"])) as CryptoKeyPair;
    const epk = new Uint8Array(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    );
    const shared = new Uint8Array(
      await x25519(await crypto.subtle.importKey("raw", theirs, X25519, true, []), pair.privateKey),
    );
    if (shared.every((b) => b === 0)) throw new Error("age: all-zero X25519 shared secret");
    const wrapKey = await hkdf(shared, concat([epk, theirs]), X25519_INFO);
    const body = chacha20poly1305Seal(wrapKey, new Uint8Array(12), fileKey);
    const header = `${VERSION_LINE}\n-> X25519 ${b64(epk)}\n${b64(body)}\n---`;
    const mac = await headerMac(fileKey, header);
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const streamKey = await hkdf(fileKey, nonce, "payload");
    const parts: Uint8Array[] = [encoder.encode(`${header} ${b64(mac)}\n`), nonce];
    const chunks = Math.max(1, Math.ceil(plaintext.byteLength / CHUNK));
    for (let i = 0; i < chunks; i++) {
      const chunk = plaintext.subarray(i * CHUNK, (i + 1) * CHUNK);
      parts.push(chacha20poly1305Seal(streamKey, streamNonce(i, i === chunks - 1), chunk));
    }
    return concat(parts);
  } finally {
    fileKey.fill(0);
  }
}

/**
 * Decrypts an age file with an X25519 identity.
 *
 * @param identity - `AGE-SECRET-KEY-1…`. Never log it.
 * @param file - The binary age file.
 * @returns The plaintext.
 * @throws {Error} When the file is malformed, not for this identity, or tampered with.
 */
export async function ageDecrypt(identity: string, file: Uint8Array): Promise<Uint8Array> {
  const { hrp, bytes: secret } = bech32Decode(identity);
  if (hrp !== "age-secret-key-" || secret.byteLength !== 32) {
    throw new Error("age: not an X25519 identity");
  }
  const pkcs8 = new Uint8Array(PKCS8_X25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_X25519_PREFIX);
  pkcs8.set(secret, PKCS8_X25519_PREFIX.length);
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, X25519, true, ["deriveBits"]);
  pkcs8.fill(0);
  const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
  const ours = unb64(jwk.x!.replace(/-/g, "+").replace(/_/g, "/"));

  // The header is text up to and including the `--- <mac>` line.
  const macLineAt = indexOf(file, encoder.encode("\n--- "));
  if (macLineAt < 0) throw new Error("age: no header MAC");
  const macEnd = file.indexOf(0x0a, macLineAt + 5);
  if (macEnd < 0) throw new Error("age: truncated header");
  const headerText = decoder.decode(file.subarray(0, macLineAt + 4));
  const mac = unb64(decoder.decode(file.subarray(macLineAt + 5, macEnd)));
  const lines = headerText.split("\n");
  if (lines[0] !== VERSION_LINE) throw new Error("age: unsupported version");

  let fileKey: Uint8Array | null = null;
  for (let i = 1; i < lines.length - 1; ) {
    const args = lines[i]!.split(" ");
    if (args[0] !== "->") throw new Error("age: malformed stanza");
    const bodyLines: string[] = [];
    i++;
    while (i < lines.length - 1) {
      const line = lines[i]!;
      bodyLines.push(line);
      i++;
      if (line.length < 64) break;
    }
    if (args[1] !== "X25519" || args.length !== 3 || fileKey) continue;
    const epk = unb64(args[2]!);
    const body = unb64(bodyLines.join(""));
    if (epk.byteLength !== 32 || body.byteLength !== 32) throw new Error("age: bad X25519 stanza");
    const shared = new Uint8Array(
      await x25519(await crypto.subtle.importKey("raw", epk, X25519, true, []), privateKey),
    );
    const wrapKey = await hkdf(shared, concat([epk, ours]), X25519_INFO);
    try {
      fileKey = chacha20poly1305Open(wrapKey, new Uint8Array(12), body);
    } catch {
      // Wrapped to another recipient.
    }
  }
  if (!fileKey) throw new Error("age: no identity matched");
  const expected = await headerMac(fileKey, headerText);
  let diff = expected.byteLength ^ mac.byteLength;
  for (let i = 0; i < expected.byteLength; i++) diff |= expected[i]! ^ (mac[i] ?? 0);
  if (diff !== 0) throw new Error("age: bad header MAC");

  const payload = file.subarray(macEnd + 1);
  if (payload.byteLength < 16 + TAG) throw new Error("age: truncated payload");
  const streamKey = await hkdf(fileKey, payload.subarray(0, 16), "payload");
  const sealed = payload.subarray(16);
  const out: Uint8Array[] = [];
  const stride = CHUNK + TAG;
  const chunks = Math.max(1, Math.ceil(sealed.byteLength / stride));
  for (let i = 0; i < chunks; i++) {
    const chunk = sealed.subarray(i * stride, (i + 1) * stride);
    const last = i === chunks - 1;
    if (chunk.byteLength < TAG) throw new Error("age: truncated chunk");
    const plain = chacha20poly1305Open(streamKey, streamNonce(i, last), chunk);
    if (last && plain.byteLength === 0 && i > 0) throw new Error("age: empty final chunk");
    out.push(plain);
  }
  return concat(out);
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.byteLength <= haystack.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
