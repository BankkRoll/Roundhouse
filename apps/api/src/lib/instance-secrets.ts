/**
 * Sealing of install-wide secrets kept in `instance_settings` (the
 * control-plane signing key, the GitHub App's private key and secrets). The
 * one place that decides their format and AAD, so the key rotation workflow
 * and every caller agree (ADR 0014 "Crypto").
 *
 * Owned by the api-secrets-crypto stream; callers in other streams only use
 * these functions.
 *
 * @module
 */
import { z } from "zod";
import { type Sealed, seal, unseal } from "./crypto";

/** The Worker bindings that hold the master keyring. */
export interface KeyEnv {
  MASTER_KEY?: string;
  MASTER_KEYS_PREVIOUS?: string;
}

// Format 1 AADs, kept until every stored value is format 2.
const aadV1 = (settingKey: string, field?: string) =>
  field ? `setting:${settingKey}:${field}` : `setting:${settingKey}`;

function currentKey(keys: KeyEnv): string {
  if (!keys.MASTER_KEY) throw new Error("MASTER_KEY is not configured");
  return keys.MASTER_KEY.trim();
}

/**
 * Seals one instance secret.
 *
 * TODO(api-secrets-crypto): seal format 2 under the current KEK with
 * `instanceSecretAadV2(settingKey, field ?? "-")`.
 *
 * @param keys - The keyring bindings.
 * @param plaintext - The secret.
 * @param settingKey - `instance_settings.key` it is stored under.
 * @param field - Field of that setting, for settings holding several secrets.
 * @returns The sealed value to store.
 */
export function sealInstanceSecret(
  keys: KeyEnv,
  plaintext: string,
  settingKey: string,
  field?: string,
): Promise<Sealed> {
  return seal(currentKey(keys), plaintext, aadV1(settingKey, field));
}

/**
 * Unseals one instance secret, whichever format and key sealed it.
 *
 * TODO(api-secrets-crypto): read format 2 by `kid` from the keyring, and
 * format 1 under each key of the keyring in turn.
 *
 * @param keys - The keyring bindings.
 * @param sealed - The stored value.
 * @param settingKey - `instance_settings.key` it is stored under.
 * @param field - Field of that setting, as passed when sealing.
 * @returns The plaintext.
 * @throws When no key of the keyring opens it.
 */
export function unsealInstanceSecret(
  keys: KeyEnv,
  sealed: Sealed,
  settingKey: string,
  field?: string,
): Promise<string> {
  return unseal(currentKey(keys), sealed, aadV1(settingKey, field));
}

/** A stored ciphertext of either format, for parsing `instance_settings` values. */
export const SealedSchema = z.union([
  z.object({ v: z.literal(1), iv: z.string(), ct: z.string() }),
  z.object({
    v: z.literal(2),
    kid: z.string().regex(/^[a-f0-9]{8}$/),
    iv: z.string(),
    ct: z.string(),
  }),
]);
