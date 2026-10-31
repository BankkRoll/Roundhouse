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

/** Decodes canonical unpadded base64; non-zero trailing bits are refused, as age does. */
function unb64(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]*$/.test(text) || text.length % 4 === 1) {
    throw new Error("age: invalid base64");
  }
  const bytes = fromBase64(text.padEnd(Math.ceil(text.length / 4) * 4, "="));
  if (b64(bytes) !== text) throw new Error("age: non-canonical base64");
  return bytes;
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

  const header = parseHeader(file);
  let fileKey: Uint8Array | null = null;
  for (const { args, body } of header.stanzas) {
    if (args[0] !== "X25519") continue;
    // SECURITY: a malformed X25519 stanza fails the whole file instead of
    // being skipped, as the age spec requires.
    if (args.length !== 2) throw new Error("age: bad X25519 stanza");
    const epk = unb64(args[1]!);
    if (epk.byteLength !== 32 || body.byteLength !== 32) throw new Error("age: bad X25519 stanza");
    if (fileKey) continue;
    let shared: Uint8Array;
    try {
      shared = new Uint8Array(
        await x25519(await crypto.subtle.importKey("raw", epk, X25519, true, []), privateKey),
      );
    } catch {
      throw new Error("age: invalid X25519 share");
    }
    // SECURITY: a low-order share yields an all-zero secret anyone can
    // compute, which the spec requires rejecting. workerd's deriveBits refuses
    // some of these itself; this check doesn't depend on that.
    if (shared.every((b) => b === 0)) throw new Error("age: low-order X25519 share");
    const wrapKey = await hkdf(shared, concat([epk, ours]), X25519_INFO);
    try {
      fileKey = chacha20poly1305Open(wrapKey, new Uint8Array(12), body);
    } catch {
      // Wrapped to another recipient.
    }
  }
  if (!fileKey) throw new Error("age: no identity matched");
  const expected = await headerMac(fileKey, header.macInput);
  let diff = expected.byteLength ^ header.mac.byteLength;
  for (let i = 0; i < expected.byteLength; i++) diff |= expected[i]! ^ (header.mac[i] ?? 0);
  if (diff !== 0) throw new Error("age: bad header MAC");

  const payload = file.subarray(header.payloadOffset);
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
    let plain: Uint8Array;
    try {
      plain = chacha20poly1305Open(streamKey, streamNonce(i, last), chunk);
    } catch {
      throw new Error(`age: payload chunk ${i} failed to authenticate`);
    }
    if (last && plain.byteLength === 0 && i > 0) throw new Error("age: empty final chunk");
    out.push(plain);
  }
  return concat(out);
}

interface Stanza {
  args: string[];
  body: Uint8Array;
}

interface Header {
  stanzas: Stanza[];
  /** What the header MAC covers: every byte through the `---`. */
  macInput: string;
  mac: Uint8Array;
  payloadOffset: number;
}

/**
 * Parses an age v1 header strictly: printable-ASCII lines, stanza arguments
 * of VCHARs separated by single spaces, bodies of canonical unpadded base64
 * wrapped at exactly 64 columns and ended by a shorter (possibly empty)
 * line, then a `--- <mac>` line with a 32-byte MAC.
 *
 * SECURITY: a lax parser lets one header be read more than one way; the
 * C2SP CCTV vectors in `test/age-file.test.ts` pin each of these rules.
 */
function parseHeader(file: Uint8Array): Header {
  let pos = 0;
  const nextLine = (): { text: string; start: number } => {
    const nl = file.indexOf(0x0a, pos);
    if (nl < 0) throw new Error("age: truncated header");
    for (let i = pos; i < nl; i++) {
      if (file[i]! < 0x20 || file[i]! > 0x7e) throw new Error("age: invalid header character");
    }
    const line = { text: decoder.decode(file.subarray(pos, nl)), start: pos };
    pos = nl + 1;
    return line;
  };
  if (nextLine().text !== VERSION_LINE) throw new Error("age: unsupported version");
  const stanzas: Stanza[] = [];
  for (;;) {
    const { text, start } = nextLine();
    if (text.startsWith("--- ")) {
      const mac = unb64(text.slice(4));
      if (mac.byteLength !== 32) throw new Error("age: bad header MAC");
      return {
        stanzas,
        macInput: decoder.decode(file.subarray(0, start + 3)),
        mac,
        payloadOffset: pos,
      };
    }
    if (!text.startsWith("-> ")) throw new Error("age: malformed stanza");
    const args = text.slice(3).split(" ");
    if (!args.every((a) => /^[\x21-\x7e]+$/.test(a))) throw new Error("age: malformed stanza");
    const body: string[] = [];
    for (;;) {
      const line = nextLine().text;
      if (line.length > 64) throw new Error("age: stanza body line too long");
      body.push(line);
      if (line.length < 64) break;
    }
    stanzas.push({ args, body: unb64(body.join("")) });
  }
}
