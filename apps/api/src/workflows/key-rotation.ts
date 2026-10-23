/**
 * `KeyRotationWorkflow`: moves every sealed value to the current master key
 * and to format 2 (ADR 0014 "Crypto", "Rotation"). One instance per
 * rotation; the instance ID is the `krot_…` rotation ID.
 *
 * Steps, each idempotent and batched (100 rows per step):
 * 1. `rewrap-dek`: every `project_keys` row whose `kek_kid` isn't the current
 *    KEK id: unseal with the KEK its `kid` names (v1 rows: try each key's
 *    v1 KEK), re-seal under the current KEK with the v2 AAD, set `kek_kid`
 *    and `dek_id`. Compare-and-swap on the old `dek_sealed`.
 * 2. `rewrap-instance`: the sealed instance secrets (GitHub App key and
 *    secrets, control-plane signing key), same way.
 * 3. `reseal-variables`: rows with `value_sealed.v = 1`: unseal with the v1
 *    AAD, re-seal v2 with `variableAadV2` (same `version`), and fill
 *    `fingerprint`.
 * 4. `reseal-deployments`: `env_sealed` and `build_env_sealed` with `v = 1`.
 * 5. `finish`: write `key_rotation` state `completed` and audit
 *    `instance.key_rotation_completed`; on a non-retryable error, `failed`
 *    and `instance.key_rotation_failed`.
 *
 * Owned by the api-secrets-crypto stream; this is the contract.
 *
 * @module
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../env";

/** Parameters of one rotation run. */
export interface KeyRotationParams {
  /** `krot_…`; also the workflow instance ID. */
  rotationId: string;
  /** User who started it, for the audit records. */
  startedBy: string;
}

/** Runs one master key rotation. */
export class KeyRotationWorkflow extends WorkflowEntrypoint<Env, KeyRotationParams> {
  override async run(event: Readonly<WorkflowEvent<KeyRotationParams>>, step: WorkflowStep) {
    // TODO(api-secrets-crypto): implement the steps above.
    await step.do("finish", async () => ({ rotationId: event.payload.rotationId }));
  }
}
