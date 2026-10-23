/**
 * Master key rotation schemas (ADR 0014 "Crypto"). Owned by the
 * api-secrets-crypto stream; re-exported from `../schemas`.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";

const Millis = z.number().int().openapi({ description: "Unix time in milliseconds" });

/** States of a rotation run. */
export const KEY_ROTATION_STATES = ["running", "completed", "failed"] as const;

/** Keyring and rotation status. Never includes key material. */
export const KeyStatusSchema = z
  .object({
    /** KEK id of `MASTER_KEY`. */
    current_kid: z.string(),
    /** KEK ids of `MASTER_KEYS_PREVIOUS`, in configured order. */
    previous_kids: z.array(z.string()),
    /** Rows still sealed under a key other than the current one, or in format 1. */
    remaining: z.object({
      project_keys: z.number().int().nonnegative(),
      instance_secrets: z.number().int().nonnegative(),
      v1_variables: z.number().int().nonnegative(),
      v1_deployments: z.number().int().nonnegative(),
      missing_fingerprints: z.number().int().nonnegative(),
    }),
    /** The latest rotation run, if any. */
    rotation: z
      .object({
        id: z.string(),
        state: z.enum(KEY_ROTATION_STATES),
        started_at: Millis,
        finished_at: Millis.nullable(),
        error: z.string().nullable(),
      })
      .nullable(),
    /** `true` when nothing references a previous key, so it can be removed. */
    previous_keys_removable: z.boolean(),
  })
  .openapi("KeyStatus");

/** Response of `POST /v1/instance/keys/rotate`. */
export const KeyRotationStartedSchema = z
  .object({ rotation_id: z.string() })
  .openapi("KeyRotationStarted");
