/**
 * How staged variable values are protected (ADR 0006, ADR 0014): sealed
 * under the project DEK with an AAD bound to the change set, the staged
 * change and the variable, and shown only as keyed fingerprints.
 *
 * Sealing, unsealing and fingerprinting are the existing helpers in
 * `../crypto`; this module only names the staged AAD.
 *
 * @module
 */
import type { VariableScope } from "@roundhouse/shared";
import { type Sealed, sealWith, unsealWith, valueFingerprint } from "../crypto";

/** Which staged value an AAD names. */
export interface StagedValueTarget {
  changeSetId: string;
  stagedChangeId: string;
  scope: VariableScope;
  /** Service ID or `new:<n>`; `null` for shared variables. */
  service: string | null;
  key: string;
}

/**
 * AAD of a staged variable value. Binding the change set, the staged change
 * and the variable means a sealed value can't be moved to another op, set or
 * key undetected.
 *
 * @param t - The staged value.
 * @returns The AAD string.
 */
export function stagedValueAad(t: StagedValueTarget): string {
  return `staged-variable:${t.changeSetId}:${t.stagedChangeId}:${t.scope}:${t.service ?? "-"}:${t.key}`;
}

/**
 * Seals a staged value under the project DEK.
 *
 * @param dek - The project DEK (`projectKey`).
 * @param t - Where the value is staged.
 * @param value - The plaintext.
 * @returns The ciphertext for `staged_changes.value_sealed`.
 */
export function sealStagedValue(dek: CryptoKey, t: StagedValueTarget, value: string) {
  return sealWith(dek, value, stagedValueAad(t));
}

/**
 * Opens a staged value. Only apply and edge derivation call this.
 *
 * @param dek - The project DEK.
 * @param t - Where the value is staged.
 * @param sealed - `staged_changes.value_sealed`.
 * @returns The plaintext; never return or log it.
 */
export function openStagedValue(dek: CryptoKey, t: StagedValueTarget, sealed: Sealed) {
  return unsealWith(dek, sealed, stagedValueAad(t));
}

/**
 * A value's fingerprint, exactly as `variables.fingerprint` stores it, so a
 * staged value and a stored one compare by fingerprint alone.
 *
 * @param dek - The project DEK.
 * @param value - Raw value.
 * @returns 8 lowercase hex characters.
 */
export function fingerprintOf(dek: CryptoKey, value: string): Promise<string> {
  return valueFingerprint(dek, value);
}
