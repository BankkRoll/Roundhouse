/**
 * Cryptographic helpers for the control plane: key derivation from the
 * install's `MASTER_KEY`, envelope encryption for data at rest, and token
 * generation/hashing.
 *
 * @module
 */
import { fromBase64, toBase64 } from "@openrail/protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Purposes a subkey can be derived for. Each yields an independent key. */
export type KeyPurpose = "auth-secret" | "kek";

/**
 * Validates that `MASTER_KEY` decodes to at least 32 bytes.
 *
 * @param masterKey - The raw secret value.
 * @returns `true` when it is usable.
 */
export function isValidMasterKey(masterKey: string | undefined): masterKey is string {
  if (!masterKey) return false;
  try {
    return fromBase64(masterKey.trim()).byteLength >= 32;
  } catch {
    return false;
  }
}

/**
 * Derives a purpose-bound 32-byte subkey from the master key with HKDF-SHA256,
 * so a single operator-managed secret can back several independent keys.
 *
 * @param masterKey - Base64 master key.
 * @param purpose - What the key will be used for.
 * @returns Raw subkey bytes.
 */
export async function deriveKey(masterKey: string, purpose: KeyPurpose): Promise<ArrayBuffer> {
  const ikm = await crypto.subtle.importKey("raw", fromBase64(masterKey.trim()), "HKDF", false, [
    "deriveBits",
  ]);
  return crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("openrail/v1"),
      info: encoder.encode(purpose),
    },
    ikm,
    256,
  );
}

/** Ciphertext as stored in the database. */
export interface Sealed {
  /** Format version, so the scheme can change without ambiguity. */
  v: 1;
  /** 96-bit AES-GCM nonce, base64. Random per seal. */
  iv: string;
  /** Ciphertext with the GCM tag appended, base64. */
  ct: string;
}

async function kek(masterKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await deriveKey(masterKey, "kek"), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypts a string with AES-256-GCM under the master-derived KEK.
 *
 * @param masterKey - Base64 master key.
 * @param plaintext - Value to protect.
 * @param aad - Context the ciphertext is bound to (e.g. the settings key), so
 *   a value can't be swapped into another row undetected.
 * @returns Sealed value safe to persist.
 */
export async function seal(masterKey: string, plaintext: string, aad: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    await kek(masterKey),
    encoder.encode(plaintext),
  );
  return { v: 1, iv: toBase64(iv), ct: toBase64(ct) };
}

/**
 * Decrypts a value produced by {@link seal}.
 *
 * @param masterKey - Base64 master key.
 * @param sealed - Stored ciphertext.
 * @param aad - Must equal the `aad` used when sealing.
 * @returns The plaintext.
 * @throws When the key, AAD, or ciphertext doesn't match.
 */
export async function unseal(masterKey: string, sealed: Sealed, aad: string): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData: encoder.encode(aad) },
    await kek(masterKey),
    fromBase64(sealed.ct),
  );
  return decoder.decode(pt);
}

/**
 * Generates a random bearer secret with a recognisable prefix (helps secret
 * scanners and humans identify leaked tokens).
 *
 * @param prefix - Short type prefix, e.g. `njt`.
 * @returns A token like `njt_3q2+…` encoded as base64url.
 */
export function randomToken(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64url = toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${prefix}_${b64url}`;
}

/**
 * Compares two secrets without leaking where they differ through timing.
 * Both sides are hashed first so inputs of different lengths are comparable.
 *
 * @param a - Untrusted input.
 * @param b - Expected secret.
 * @returns `true` when equal.
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

/**
 * Hashes a bearer secret for storage and lookup.
 *
 * SHA-256 (not a slow KDF) is appropriate because tokens carry 256 bits of
 * entropy; brute force is infeasible and lookups must be fast.
 *
 * @param token - The plaintext token.
 * @returns Lowercase hex digest.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
