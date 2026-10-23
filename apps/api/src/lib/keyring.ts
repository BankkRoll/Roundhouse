/**
 * The master keyring and the format 2 building blocks of ADR 0014 "Crypto":
 * key IDs, purpose-bound key derivation, the v2 AAD strings, DEK IDs and
 * variable fingerprints. Everything here is fixed byte for byte by the ADR;
 * sealing and unsealing with it (and the rotation workflow) belong to the
 * api-secrets-crypto stream.
 *
 * @module
 */
import { fromBase64 } from "@openrail/protocol";
import type { VariableScope } from "@openrail/shared";
import { isValidMasterKey } from "./crypto";

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hkdf(
  ikm: Uint8Array<ArrayBuffer>,
  salt: string,
  info: string,
  bits = 256,
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(salt), info: encoder.encode(info) },
    key,
    bits,
  );
}

// -----------------------------------------------------------------------------
// Keyring
// -----------------------------------------------------------------------------

/** One master key and its ID. */
export interface MasterKey {
  /** {@link masterKeyId} of the key. */
  kid: string;
  /** The raw key bytes (at least 32). */
  raw: Uint8Array<ArrayBuffer>;
  /** The key as configured, base64; v1 derivation (`deriveKey` in ./crypto) takes this form. */
  base64: string;
}

/** `MASTER_KEY` and the keys before it. */
export interface Keyring {
  current: MasterKey;
  /** `MASTER_KEYS_PREVIOUS`, in configured order (newest first). */
  previous: MasterKey[];
}

/**
 * ID of a master key: the first 8 hex characters of SHA-256 over
 * HKDF-SHA256(key, salt `openrail/v2/kid`, info `kid`, 32 bytes). Derived
 * through HKDF so the ID reveals nothing usable about the key itself.
 *
 * @param base64Key - The master key as configured.
 * @returns 8 lowercase hex characters.
 */
export async function masterKeyId(base64Key: string): Promise<string> {
  const derived = await hkdf(fromBase64(base64Key.trim()), "openrail/v2/kid", "kid");
  return hex(await crypto.subtle.digest("SHA-256", derived)).slice(0, 8);
}

/**
 * Parses the keyring from the Worker's environment.
 *
 * @param env - `MASTER_KEY` and the optional comma-separated `MASTER_KEYS_PREVIOUS`.
 * @returns The keyring, or `null` when `MASTER_KEY` is missing or invalid.
 * @throws {Error} When a previous key is invalid or duplicates another.
 */
export async function parseKeyring(env: {
  MASTER_KEY?: string;
  MASTER_KEYS_PREVIOUS?: string;
}): Promise<Keyring | null> {
  if (!isValidMasterKey(env.MASTER_KEY)) return null;
  const toKey = async (b64: string): Promise<MasterKey> => ({
    kid: await masterKeyId(b64),
    raw: fromBase64(b64.trim()),
    base64: b64.trim(),
  });
  const current = await toKey(env.MASTER_KEY);
  const previous: MasterKey[] = [];
  for (const part of (env.MASTER_KEYS_PREVIOUS ?? "").split(",")) {
    const b64 = part.trim();
    if (!b64) continue;
    if (!isValidMasterKey(b64)) throw new Error("MASTER_KEYS_PREVIOUS holds an invalid key");
    const key = await toKey(b64);
    if (key.kid === current.kid || previous.some((p) => p.kid === key.kid)) {
      throw new Error(`MASTER_KEYS_PREVIOUS repeats key ${key.kid}`);
    }
    previous.push(key);
  }
  return { current, previous };
}

/**
 * Finds a key of the keyring by ID.
 *
 * @param keyring - The keyring.
 * @param kid - A `kid` from a v2 sealed value.
 * @returns The key, or `undefined` when it was removed from the keyring.
 */
export function keyByKid(keyring: Keyring, kid: string): MasterKey | undefined {
  return [keyring.current, ...keyring.previous].find((k) => k.kid === kid);
}

/** Purposes a v2 subkey is derived for. */
export type KeyPurposeV2 = "kek" | "state-token" | "auth-secret";

/**
 * Derives a purpose-bound 32-byte subkey, format 2: HKDF-SHA256 with salt
 * `openrail/v2/<purpose>` and info `<purpose>`. A salt per purpose (v1 used
 * one salt for all) keeps the derivations independent even if an `info`
 * string is ever reused.
 *
 * @param key - A master key of the keyring.
 * @param purpose - What the subkey is for.
 * @returns Raw subkey bytes.
 */
export function deriveKeyV2(key: MasterKey, purpose: KeyPurposeV2): Promise<ArrayBuffer> {
  return hkdf(key.raw, `openrail/v2/${purpose}`, purpose);
}

// -----------------------------------------------------------------------------
// Format 2 AADs
// -----------------------------------------------------------------------------

/** Where a variable lives, as its v2 AAD binds it. */
export interface VariableAadInput {
  workspaceId: string;
  projectId: string;
  environmentId: string;
  scope: VariableScope;
  /** `null` for shared variables. */
  serviceId: string | null;
  key: string;
  /** `variables.id`. */
  rowId: string;
  /** `variables.version` the value is stored with. */
  version: number;
}

/**
 * AAD of a variable value, format 2. Binds the value to its workspace,
 * project, environment, scope, service, key, row and version, so a row
 * can't be copied to another row, or rolled back to an older ciphertext of
 * itself, undetected.
 *
 * @param v - The variable.
 * @returns `variable:v2:<ws>:<prj>:<env>:<scope>:<svc|->:<key>:<row>:<version>`.
 */
export function variableAadV2(v: VariableAadInput): string {
  return [
    "variable:v2",
    v.workspaceId,
    v.projectId,
    v.environmentId,
    v.scope,
    v.serviceId ?? "-",
    v.key,
    v.rowId,
    v.version,
  ].join(":");
}

/**
 * AAD of a project's sealed DEK, format 2.
 *
 * @param workspaceId - Owning workspace.
 * @param projectId - The project.
 * @returns `project-key:v2:<ws>:<prj>`.
 */
export function projectKeyAadV2(workspaceId: string, projectId: string): string {
  return `project-key:v2:${workspaceId}:${projectId}`;
}

/**
 * AAD of a deployment's sealed environment, format 2.
 *
 * @param workspaceId - Owning workspace.
 * @param projectId - Owning project.
 * @param deploymentId - The deployment.
 * @returns `deployment-env:v2:<ws>:<prj>:<dep>`.
 */
export function deploymentEnvAadV2(
  workspaceId: string,
  projectId: string,
  deploymentId: string,
): string {
  return `deployment-env:v2:${workspaceId}:${projectId}:${deploymentId}`;
}

/**
 * AAD of a deployment's sealed build inputs (`deployments.build_env_sealed`).
 *
 * @param workspaceId - Owning workspace.
 * @param projectId - Owning project.
 * @param deploymentId - The deployment.
 * @returns `deployment-build:v2:<ws>:<prj>:<dep>`.
 */
export function deploymentBuildAadV2(
  workspaceId: string,
  projectId: string,
  deploymentId: string,
): string {
  return `deployment-build:v2:${workspaceId}:${projectId}:${deploymentId}`;
}

/**
 * AAD of a sealed instance secret, format 2.
 *
 * @param settingKey - `instance_settings.key`, e.g. `github_app`.
 * @param field - Field within the setting, e.g. `private_key`; `-` for a single value.
 * @returns `setting:v2:<key>:<field>`.
 */
export function instanceSecretAadV2(settingKey: string, field = "-"): string {
  return `setting:v2:${settingKey}:${field}`;
}

// -----------------------------------------------------------------------------
// DEK IDs and fingerprints
// -----------------------------------------------------------------------------

/**
 * ID of a project DEK: the first 8 hex characters of SHA-256 of the raw key.
 * Hashing a 256-bit random key reveals nothing about it.
 *
 * @param rawDek - The 32-byte DEK.
 * @returns The `kid` of values sealed under it.
 */
export async function dekId(rawDek: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", rawDek)).slice(0, 8);
}

/**
 * The project's fingerprint key: HKDF-SHA256(DEK, salt
 * `openrail/v2/fingerprint`, info `variable-fingerprint:<project_id>`),
 * imported for HMAC-SHA256.
 *
 * SECURITY: Fingerprints are shown to every reader of a project, viewers
 * included, and stored in D1. A plain hash of a short or guessable secret
 * could be brute-forced offline from either; a key only the Worker can
 * derive makes each guess need the Worker.
 *
 * @param rawDek - The project's 32-byte DEK.
 * @param projectId - The project.
 * @returns An HMAC key for {@link variableFingerprint}.
 */
export async function fingerprintKey(
  rawDek: Uint8Array<ArrayBuffer>,
  projectId: string,
): Promise<CryptoKey> {
  const raw = await hkdf(rawDek, "openrail/v2/fingerprint", `variable-fingerprint:${projectId}`);
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/**
 * A value's fingerprint: the first 8 hex characters of
 * HMAC-SHA256(fingerprint key, UTF-8 value). Enough to tell values apart at
 * a glance, too short to be a useful oracle even with the key.
 *
 * @param key - From {@link fingerprintKey}.
 * @param value - The raw (unresolved) value as stored.
 * @returns 8 lowercase hex characters.
 */
export async function variableFingerprint(key: CryptoKey, value: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value))).slice(0, 8);
}
