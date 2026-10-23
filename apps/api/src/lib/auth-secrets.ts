/**
 * Better Auth's secrets, derived from the master keyring with key format 2
 * (ADR 0014 "Crypto", purpose `auth-secret`).
 *
 * - The **current** key's subkey signs session cookies and encrypts new
 *   two-factor material, so rotating `MASTER_KEY` signs everyone out, as the
 *   ADR's runbook says.
 * - Every key of the keyring contributes a versioned secret, so two-factor
 *   secrets and backup codes encrypted before a rotation stay readable while
 *   the old key is in `MASTER_KEYS_PREVIOUS`, until `KeyRotationWorkflow`
 *   re-encrypts them (`rewrapTwoFactorBatch`).
 *
 * Better Auth tags each ciphertext `$ba$<version>$…`; the version is the
 * key's `kid` read as a number, so a ciphertext names its master key the way
 * a format 2 sealed value does.
 *
 * @module
 */
import { toBase64 } from "@roundhouse/protocol";
import { deriveKeyV2, type KeyEnv, keyringOf, type MasterKey } from "./keyring";

/** One versioned Better Auth secret. */
export interface AuthSecret {
  /** {@link authSecretVersion} of the master key it was derived from. */
  version: number;
  /** Base64 of the 32-byte `auth-secret` subkey. */
  value: string;
}

/**
 * Better Auth's `SecretConfig`: what `symmetricEncrypt`/`symmetricDecrypt`
 * take to encrypt under the current version and decrypt under any.
 */
export interface AuthSecretConfig {
  keys: Map<number, string>;
  currentVersion: number;
}

/** Everything Better Auth needs from the keyring. */
export interface AuthSecrets {
  /** Current key first, then `MASTER_KEYS_PREVIOUS` in order; Better Auth's `secrets` option. */
  secrets: AuthSecret[];
  /** The same secrets as a `SecretConfig`. */
  config: AuthSecretConfig;
}

/**
 * The Better Auth secret version of a master key.
 *
 * @param kid - The key's `kid` (8 hex characters).
 * @returns The kid as an unsigned 32-bit integer.
 * @example
 * authSecretVersion("c67798f0"); // 3329726704
 */
export function authSecretVersion(kid: string): number {
  return Number.parseInt(kid, 16);
}

async function secretOf(key: MasterKey): Promise<AuthSecret> {
  return {
    version: authSecretVersion(key.kid),
    value: toBase64(new Uint8Array(await deriveKeyV2(key, "auth-secret"))),
  };
}

// PERF: Better Auth is constructed per request; HKDF per key per request is
// wasted work since the bindings don't change within an isolate.
const cache = new Map<string, Promise<AuthSecrets>>();

/**
 * Derives Better Auth's secrets from the keyring.
 *
 * @param keys - The keyring bindings (or `MASTER_KEY` alone).
 * @returns The versioned secrets and the matching `SecretConfig`.
 * @throws {Error} When `MASTER_KEY` is missing or a key is invalid.
 */
export async function authSecretsFor(keys: KeyEnv): Promise<AuthSecrets> {
  const ring = await keyringOf(keys);
  const id = [ring.current, ...ring.previous].map((k) => k.kid).join(",");
  let entry = cache.get(id);
  if (!entry) {
    if (cache.size >= 8) cache.clear();
    entry = (async () => {
      const secrets = await Promise.all([ring.current, ...ring.previous].map(secretOf));
      return {
        secrets,
        config: {
          keys: new Map(secrets.map((s) => [s.version, s.value])),
          currentVersion: secrets[0]!.version,
        },
      };
    })();
    cache.set(id, entry);
    entry.catch(() => cache.delete(id));
  }
  return entry;
}
