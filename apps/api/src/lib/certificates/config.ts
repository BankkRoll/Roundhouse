/**
 * Sealing of control-plane certificate private keys (ADR 0009). Keys live in
 * `certificates.key_sealed`, sealed with `sealInstanceSecret` under the
 * setting key {@link CERTIFICATE_KEY_SETTING} and the certificate's ID as
 * field, which binds each key to its row.
 *
 * @module
 */
import type { Sealed } from "../crypto";
import { type KeyEnv, sealInstanceSecret, unsealInstanceSecret } from "../instance-secrets";

/** Setting key the certificate private keys are sealed under (field: the certificate ID). */
export const CERTIFICATE_KEY_SETTING = "certificate";

/**
 * Seals a certificate's private key.
 *
 * @param keys - The keyring bindings.
 * @param certificateId - The certificate; bound into the AAD.
 * @param pem - PKCS#8 PEM.
 * @returns The value for `certificates.key_sealed`.
 */
export function sealCertificateKey(keys: KeyEnv, certificateId: string, pem: string) {
  return sealInstanceSecret(keys, pem, CERTIFICATE_KEY_SETTING, certificateId);
}

/**
 * Opens `certificates.key_sealed` (or `pending_key_sealed`).
 *
 * @param keys - The keyring bindings.
 * @param certificateId - The certificate.
 * @param sealed - The stored value.
 * @returns The PKCS#8 PEM. Never store or log it.
 */
export function openCertificateKey(keys: KeyEnv, certificateId: string, sealed: Sealed) {
  return unsealInstanceSecret(keys, sealed, CERTIFICATE_KEY_SETTING, certificateId);
}
