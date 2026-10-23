/**
 * Sealing of install-wide secrets: the ones kept in `instance_settings` (the
 * control-plane signing key, the GitHub App's private key and secrets) and
 * the workspaces' cloud provider tokens. The one place that decides their
 * format and AAD, so the key rotation workflow and every caller agree (ADR
 * 0014 "Crypto"): format 2 under the current KEK with AAD
 * `setting:v2:<setting_key>:<field|->`; format 1 (`setting:<key>[:<field>]`)
 * stays readable under every key of the keyring until rotation re-wraps it.
 *
 * Callers in other streams only use these functions.
 *
 * @module
 */
import { z } from "zod";
import { type Sealed, type SealedV2, seal, unseal } from "./crypto";
import { instanceSecretAadV2, type KeyEnv } from "./keyring";

export type { KeyEnv } from "./keyring";

const aadV1 = (settingKey: string, field?: string) =>
  field ? `setting:${settingKey}:${field}` : `setting:${settingKey}`;

/**
 * The AAD an instance secret is sealed with.
 *
 * @param sealed - The stored value (its format picks the AAD form).
 * @param settingKey - `instance_settings.key` it is stored under.
 * @param field - Field of that setting, as passed when sealing.
 * @returns The AAD string.
 */
export function instanceSecretAad(
  sealed: Pick<Sealed, "v">,
  settingKey: string,
  field?: string,
): string {
  return sealed.v === 2 ? instanceSecretAadV2(settingKey, field ?? "-") : aadV1(settingKey, field);
}

/**
 * Seals one instance secret, format 2 under the current KEK.
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
): Promise<SealedV2> {
  return seal(keys, plaintext, instanceSecretAadV2(settingKey, field ?? "-"));
}

/**
 * Unseals one instance secret, whichever format and key sealed it: format 2
 * by `kid`, format 1 under each key of the keyring in turn.
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
  return unseal(keys, sealed, instanceSecretAad(sealed, settingKey, field));
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
