/**
 * age X25519 keys (https://age-encryption.org/v1) for backup encryption
 * (ADR 0004, "Encryption"): generation with WebCrypto and the Bech32
 * encodings `filippo.io/age` reads.
 *
 * - Recipient: Bech32 with HRP `age` over the 32-byte public key, lowercase
 *   (`age1…`).
 * - Identity: Bech32 with HRP `AGE-SECRET-KEY-` over the 32-byte private
 *   scalar, uppercase (`AGE-SECRET-KEY-1…`).
 *
 * Both are classic Bech32 (BIP 173 checksum constant 1, not Bech32m), without
 * BIP 173's 90-character limit, as age uses it.
 *
 * @module
 */
import { fromBase64, x25519PublicKey } from "@roundhouse/protocol";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

/** HRP of an age X25519 recipient. */
export const AGE_RECIPIENT_HRP = "age";

/** HRP of an age X25519 identity (encoded uppercase). */
export const AGE_IDENTITY_HRP = "AGE-SECRET-KEY-";

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i]!;
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function convertBits(data: Iterable<number>, from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from) throw new Error("invalid data for bit conversion");
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv) !== 0) {
    throw new Error("invalid padding");
  }
  return out;
}

/**
 * Encodes bytes as Bech32 (lowercase).
 *
 * @param hrp - Human-readable part; lowercased for the checksum and output.
 * @param bytes - Payload.
 * @returns `<hrp>1<data><checksum>`.
 */
export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const h = hrp.toLowerCase();
  const data = convertBits(bytes, 8, 5, true);
  const mod = polymod([...hrpExpand(h), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${h}1${[...data, ...checksum].map((d) => CHARSET[d]).join("")}`;
}

/**
 * Decodes Bech32, verifying the checksum. Mixed case is rejected.
 *
 * @param text - Encoded string, all lowercase or all uppercase.
 * @returns The lowercase HRP and the payload.
 * @throws {Error} For a malformed string or a bad checksum.
 */
export function bech32Decode(text: string): { hrp: string; bytes: Uint8Array } {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) {
    throw new Error("mixed-case bech32");
  }
  const s = text.toLowerCase();
  const sep = s.lastIndexOf("1");
  if (sep < 1 || sep + 7 > s.length) throw new Error("malformed bech32");
  const hrp = s.slice(0, sep);
  for (const c of hrp) {
    const code = c.charCodeAt(0);
    if (code < 33 || code > 126) throw new Error("invalid bech32 prefix");
  }
  const data: number[] = [];
  for (const c of s.slice(sep + 1)) {
    const d = CHARSET.indexOf(c);
    if (d < 0) throw new Error("invalid bech32 character");
    data.push(d);
  }
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error("bad bech32 checksum");
  return { hrp, bytes: Uint8Array.from(convertBits(data.slice(0, -6), 5, 8, false)) };
}

/** An age X25519 keypair in its text encodings. */
export interface AgeKeyPair {
  /** `age1…`: what backups are encrypted to. */
  recipient: string;
  /** `AGE-SECRET-KEY-1…`: decrypts them. Seal it before storing. */
  identity: string;
}

/**
 * Encodes a raw private scalar as an identity.
 *
 * @param privateKey - 32 bytes.
 * @returns `AGE-SECRET-KEY-1…`.
 */
export function encodeAgeIdentity(privateKey: Uint8Array): string {
  if (privateKey.byteLength !== 32) throw new Error("X25519 private keys are 32 bytes");
  return bech32Encode(AGE_IDENTITY_HRP, privateKey).toUpperCase();
}

/**
 * Encodes a raw public key as a recipient.
 *
 * @param publicKey - 32 bytes.
 * @returns `age1…`.
 */
export function encodeAgeRecipient(publicKey: Uint8Array): string {
  if (publicKey.byteLength !== 32) throw new Error("X25519 public keys are 32 bytes");
  return bech32Encode(AGE_RECIPIENT_HRP, publicKey);
}

/**
 * The recipient of an identity.
 *
 * @param identity - `AGE-SECRET-KEY-1…`.
 * @returns `age1…`.
 * @throws {Error} When the identity doesn't decode.
 */
export async function ageRecipientOf(identity: string): Promise<string> {
  const { hrp, bytes } = bech32Decode(identity);
  if (hrp !== AGE_IDENTITY_HRP.toLowerCase() || identity !== identity.toUpperCase()) {
    throw new Error("not an age identity");
  }
  if (bytes.byteLength !== 32) throw new Error("age identities hold 32 bytes");
  return encodeAgeRecipient(fromBase64(await x25519PublicKey(bytes)));
}

/**
 * Generates a keypair from 32 random bytes, as `age-keygen` does.
 *
 * @returns The recipient and identity.
 */
export async function generateAgeKeyPair(): Promise<AgeKeyPair> {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const identity = encodeAgeIdentity(privateKey);
    return { identity, recipient: await ageRecipientOf(identity) };
  } finally {
    privateKey.fill(0);
  }
}
