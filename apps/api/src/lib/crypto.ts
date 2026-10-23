/**
 * Cryptographic helpers for the control plane (ADR 0003, ADR 0014 "Crypto"):
 *
 * - sealing under the master keyring's KEK: format 2 for every new value,
 *   format 1 still readable under each key of the keyring;
 * - project data keys (DEKs): sealing them under the KEK, and sealing values
 *   under them with the DEK's id as `kid`;
 * - keyed value fingerprints;
 * - signed state tokens, verified under every key of the keyring;
 * - token generation, hashing and constant-time comparison.
 *
 * @module
 */
import { fromBase64, toBase64 } from "@roundhouse/protocol";
import {
  dekId,
  deriveKeyV2,
  fingerprintKey,
  type Keyring,
  type KeySource,
  keyByKid,
  keyringOf,
  type MasterKey,
  projectKeyAadV2,
  variableFingerprint,
} from "./keyring";

export { isValidMasterKey, type KeyEnv, type KeySource } from "./keyring";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Purposes a format 1 subkey can be derived for. Each yields an independent key. */
export type KeyPurpose = "auth-secret" | "kek" | "state-token";

/**
 * Derives a purpose-bound 32-byte subkey from the master key with
 * HKDF-SHA256, format 1 (one salt for every purpose). Format 2 uses
 * `deriveKeyV2` in `./keyring`.
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
      salt: encoder.encode("roundhouse/v1"),
      info: encoder.encode(purpose),
    },
    ikm,
    256,
  );
}

/** Ciphertext as stored in the database, format 1 (ADR 0003): one key, short AADs. Read-only now. */
export interface SealedV1 {
  /** Format version, so the scheme can change without ambiguity. */
  v: 1;
  /** 96-bit AES-GCM nonce, base64. Random per seal. */
  iv: string;
  /** Ciphertext with the GCM tag appended, base64. */
  ct: string;
}

/**
 * Format 2 (ADR 0014): `kid` names the sealing key (a KEK id from the
 * master keyring, or a project DEK id), and AADs are the long v2 forms.
 */
export interface SealedV2 {
  v: 2;
  /** 8 lowercase hex characters. */
  kid: string;
  /** 96-bit AES-GCM nonce, base64. Random per seal. */
  iv: string;
  /** Ciphertext with the GCM tag appended, base64. */
  ct: string;
}

/** Any stored ciphertext. Every new seal is {@link SealedV2}. */
export type Sealed = SealedV1 | SealedV2;

async function encrypt(key: CryptoKey, plaintext: string, aad: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(plaintext),
  );
  return { iv: toBase64(iv), ct: toBase64(ct) };
}

async function decrypt(key: CryptoKey, sealed: Sealed, aad: string): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData: encoder.encode(aad) },
    key,
    fromBase64(sealed.ct),
  );
  return decoder.decode(pt);
}

// -----------------------------------------------------------------------------
// KEK sealing
// -----------------------------------------------------------------------------

// PERF: An HKDF and a key import per seal add up across a rotation batch.
// Keyed by format and kid; the keyring holds at most a handful of keys.
const kekCache = new Map<string, Promise<CryptoKey>>();

function kek(key: MasterKey, format: 1 | 2): Promise<CryptoKey> {
  const id = `${format}:${key.kid}`;
  let cached = kekCache.get(id);
  if (!cached) {
    cached = (format === 2 ? deriveKeyV2(key, "kek") : deriveKey(key.base64, "kek")).then((raw) =>
      crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]),
    );
    kekCache.set(id, cached);
  }
  return cached;
}

/**
 * Encrypts a string with AES-256-GCM under the current master key's KEK,
 * format 2.
 *
 * @param keys - The keyring bindings, or `MASTER_KEY` alone.
 * @param plaintext - Value to protect.
 * @param aad - Context the ciphertext is bound to (e.g. the settings key), so
 *   a value can't be swapped into another row undetected.
 * @returns Sealed value safe to persist.
 */
export async function seal(keys: KeySource, plaintext: string, aad: string): Promise<SealedV2> {
  const ring = await keyringOf(keys);
  return {
    v: 2,
    kid: ring.current.kid,
    ...(await encrypt(await kek(ring.current, 2), plaintext, aad)),
  };
}

/**
 * Decrypts a value produced by {@link seal}: format 2 under the key its
 * `kid` names, format 1 under each key of the keyring in turn.
 *
 * @param keys - The keyring bindings, or `MASTER_KEY` alone.
 * @param sealed - Stored ciphertext.
 * @param aad - Must equal the `aad` used when sealing.
 * @returns The plaintext.
 * @throws When no key of the keyring opens it with this AAD.
 */
export async function unseal(keys: KeySource, sealed: Sealed, aad: string): Promise<string> {
  return unsealWithRing(await keyringOf(keys), sealed, aad);
}

async function unsealWithRing(ring: Keyring, sealed: Sealed, aad: string): Promise<string> {
  if (sealed.v === 2) {
    const key = keyByKid(ring, sealed.kid);
    if (!key) throw new Error(`Sealed under master key ${sealed.kid}, which the keyring lacks`);
    return decrypt(await kek(key, 2), sealed, aad);
  }
  for (const key of [ring.current, ...ring.previous]) {
    try {
      return await decrypt(await kek(key, 1), sealed, aad);
    } catch {
      // Try the next key; format 1 doesn't say which key sealed it.
    }
  }
  throw new Error("No key of the keyring opens this value");
}

/**
 * Whether a KEK-sealed value is already in its final form: format 2 under
 * the current master key. The rotation workflow re-wraps everything else.
 *
 * @param keys - The keyring bindings.
 * @param sealed - Stored ciphertext.
 * @returns `true` when nothing needs re-wrapping.
 */
export async function isCurrentKek(keys: KeySource, sealed: Sealed): Promise<boolean> {
  return sealed.v === 2 && sealed.kid === (await keyringOf(keys)).current.kid;
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

// -----------------------------------------------------------------------------
// Project data keys
// -----------------------------------------------------------------------------

/**
 * Generates a fresh 256-bit project data encryption key (DEK).
 *
 * @returns The raw key, base64. Seal it with {@link sealDataKey} before storing.
 */
export function generateDataKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Format 1 AAD of a project's sealed DEK. New DEKs use `projectKeyAadV2`.
 *
 * @param projectId - Owning project.
 * @returns The AAD string.
 */
export function projectKeyAad(projectId: string): string {
  return `project-key:${projectId}`;
}

/** What a project DEK is: its id and the project it belongs to. */
export interface DataKeyInfo {
  /** `dekId` of the raw key: the `kid` of every value sealed under it. */
  dekId: string;
  projectId: string;
  /** Owning workspace, for the format 2 AADs. */
  workspaceId: string;
  /** HMAC key for {@link valueFingerprint}. */
  fingerprintKey: CryptoKey;
}

// The imported DEK is non-extractable, so what format 2 needs about it is
// recorded when it is imported, keyed by the CryptoKey itself.
const dataKeys = new WeakMap<CryptoKey, DataKeyInfo>();

/**
 * What {@link openDataKey} recorded about a DEK.
 *
 * @param key - A key from {@link openDataKey} (via `projectKey`).
 * @returns Its id, project and workspace.
 * @throws {Error} For a key that didn't come from {@link openDataKey}.
 */
export function dataKeyInfo(key: CryptoKey): DataKeyInfo {
  const info = dataKeys.get(key);
  if (!info) throw new Error("Not a project data key");
  return info;
}

/**
 * Seals a raw DEK under the current KEK, format 2.
 *
 * @param keys - The keyring bindings, or `MASTER_KEY` alone.
 * @param rawDek - The DEK, base64.
 * @param workspaceId - Owning workspace; part of the AAD.
 * @param projectId - Owning project; part of the AAD.
 * @returns The sealed DEK and the ids `project_keys` mirrors.
 */
export async function sealDataKey(
  keys: KeySource,
  rawDek: string,
  workspaceId: string,
  projectId: string,
): Promise<{ dekSealed: SealedV2; kekKid: string; dekId: string }> {
  const dekSealed = await seal(keys, rawDek, projectKeyAadV2(workspaceId, projectId));
  return { dekSealed, kekKid: dekSealed.kid, dekId: await dekId(fromBase64(rawDek)) };
}

/**
 * Unseals a project's DEK, whichever format and master key sealed it.
 *
 * @param keys - The keyring bindings, or `MASTER_KEY` alone.
 * @param sealed - `project_keys.dek_sealed`.
 * @param workspaceId - Owning workspace.
 * @param projectId - Owning project.
 * @returns The raw DEK, base64. Never store or return it.
 */
export function unsealDataKey(
  keys: KeySource,
  sealed: Sealed,
  workspaceId: string,
  projectId: string,
): Promise<string> {
  return unseal(
    keys,
    sealed,
    sealed.v === 2 ? projectKeyAadV2(workspaceId, projectId) : projectKeyAad(projectId),
  );
}

/**
 * Unseals a project's DEK and imports it for AES-256-GCM, recording its id,
 * project and fingerprint key for {@link sealWith} and {@link valueFingerprint}.
 *
 * @param keys - The keyring bindings, or `MASTER_KEY` alone.
 * @param sealed - `project_keys.dek_sealed`.
 * @param workspaceId - Owning workspace.
 * @param projectId - Owning project.
 * @returns A non-extractable AES-GCM key.
 */
export async function openDataKey(
  keys: KeySource,
  sealed: Sealed,
  workspaceId: string,
  projectId: string,
): Promise<CryptoKey> {
  const raw = fromBase64(await unsealDataKey(keys, sealed, workspaceId, projectId));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  dataKeys.set(key, {
    dekId: await dekId(raw),
    projectId,
    workspaceId,
    fingerprintKey: await fingerprintKey(raw, projectId),
  });
  raw.fill(0);
  return key;
}

/**
 * Encrypts a string with AES-256-GCM under a project DEK, format 2 with the
 * DEK's id as `kid`.
 *
 * @param key - Key from {@link openDataKey} (via `projectKey`).
 * @param plaintext - Value to protect.
 * @param aad - Context the ciphertext is bound to.
 * @returns Sealed value safe to persist.
 */
export async function sealWith(key: CryptoKey, plaintext: string, aad: string): Promise<SealedV2> {
  return { v: 2, kid: dataKeyInfo(key).dekId, ...(await encrypt(key, plaintext, aad)) };
}

/**
 * Decrypts a value produced by {@link sealWith}, or a format 1 value sealed
 * under the same DEK.
 *
 * @param key - The same data key.
 * @param sealed - Stored ciphertext.
 * @param aad - Must equal the AAD used when sealing.
 * @returns The plaintext.
 * @throws When the key, AAD, or ciphertext doesn't match.
 */
export async function unsealWith(key: CryptoKey, sealed: Sealed, aad: string): Promise<string> {
  if (sealed.v === 2) {
    const info = dataKeys.get(key);
    if (info && info.dekId !== sealed.kid) {
      throw new Error(`Sealed under data key ${sealed.kid}, not ${info.dekId}`);
    }
  }
  return decrypt(key, sealed, aad);
}

/**
 * A value's fingerprint under its project's fingerprint key (ADR 0014
 * "Fingerprints"): 8 hex characters, safe to show to every reader.
 *
 * @param key - The project's DEK from {@link openDataKey}.
 * @param value - The raw (unresolved) value.
 * @returns 8 lowercase hex characters.
 */
export function valueFingerprint(key: CryptoKey, value: string): Promise<string> {
  return variableFingerprint(dataKeyInfo(key).fingerprintKey, value);
}

// -----------------------------------------------------------------------------
// Signed state tokens
// -----------------------------------------------------------------------------

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return fromBase64(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

const stateKeyCache = new Map<string, Promise<CryptoKey>>();

function stateKey(key: MasterKey, format: 1 | 2): Promise<CryptoKey> {
  const id = `${format}:${key.kid}`;
  let cached = stateKeyCache.get(id);
  if (!cached) {
    cached = (
      format === 2 ? deriveKeyV2(key, "state-token") : deriveKey(key.base64, "state-token")
    ).then((raw) =>
      crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
        "verify",
      ]),
    );
    stateKeyCache.set(id, cached);
  }
  return cached;
}

/**
 * Signs a small JSON payload into a URL-safe token with an expiry, for state
 * that round-trips through a third party (e.g. GitHub's install redirect).
 *
 * @param keys - The keyring bindings, or `MASTER_KEY` alone; signs with the
 *   current key's format 2 state key.
 * @param purpose - Bound into the signature so tokens can't be reused elsewhere.
 * @param payload - Data to carry; not encrypted, so never put secrets in it.
 * @param ttlMs - Lifetime.
 * @returns `<payload>.<signature>`, base64url.
 */
export async function signState(
  keys: KeySource,
  purpose: string,
  payload: Record<string, unknown>,
  ttlMs: number,
): Promise<string> {
  const ring = await keyringOf(keys);
  const body = base64url(
    encoder.encode(JSON.stringify({ ...payload, p: purpose, exp: Date.now() + ttlMs })),
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    await stateKey(ring.current, 2),
    encoder.encode(body),
  );
  return `${body}.${base64url(sig)}`;
}

/**
 * Verifies a token from {@link signState} under every key of the keyring
 * (format 2, then format 1), so tokens in flight survive a key change.
 *
 * @param keys - The keyring bindings, or `MASTER_KEY` alone.
 * @param purpose - Must match the purpose it was signed for.
 * @param token - Untrusted token.
 * @returns The payload, or `null` when forged, expired, or for another purpose.
 */
export async function verifyState(
  keys: KeySource,
  purpose: string,
  token: string,
): Promise<Record<string, unknown> | null> {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ring = await keyringOf(keys);
    const signature = fromBase64url(sig);
    const data = encoder.encode(body);
    let ok = false;
    for (const format of [2, 1] as const) {
      for (const key of [ring.current, ...ring.previous]) {
        // SECURITY: WebCrypto's HMAC verify compares in constant time.
        if (await crypto.subtle.verify("HMAC", await stateKey(key, format), signature, data)) {
          ok = true;
          break;
        }
      }
      if (ok) break;
    }
    if (!ok) return null;
    const payload = JSON.parse(decoder.decode(fromBase64url(body))) as Record<string, unknown>;
    if (payload.p !== purpose || typeof payload.exp !== "number" || payload.exp < Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
