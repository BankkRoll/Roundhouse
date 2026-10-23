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

// -----------------------------------------------------------------------------
// Control-plane signing key rollover (ADR 0014 §13)
// -----------------------------------------------------------------------------

/**
 * Where a node stands in the signing-key rollover:
 * - `ready`: it pins the key it will be signed with (the successor while one
 *   is scheduled, else the current key);
 * - `pending`: a successor is scheduled and the agent can follow it, but
 *   hasn't been told yet (it learns it at its next connection);
 * - `upgrade_required`: a successor is scheduled and the agent predates
 *   rollover; it must be upgraded before the rollover completes;
 * - `rejoin_required`: it pins none of the keys still in use, so it can't
 *   verify frames until it re-joins;
 * - `unknown`: the node hasn't reported its keys yet.
 */
export const NODE_KEY_STATES = [
  "ready",
  "pending",
  "upgrade_required",
  "rejoin_required",
  "unknown",
] as const;

/** One node's signing keys. */
export const NodeSigningKeysSchema = z.object({
  id: z.string(),
  name: z.string(),
  workspace_id: z.string(),
  protocol_version: z.number().int(),
  connected: z.boolean(),
  /** Kids it pins, as last reported or announced; `null` when never known. */
  pinned_kids: z.array(z.string()).nullable(),
  state: z.enum(NODE_KEY_STATES),
});

/** Signing keys and rollover status. Never includes private key material. */
export const SigningKeyStatusSchema = z
  .object({
    /** The stored current key, which signs until a successor is due. */
    current: z.object({ kid: z.string(), public_key: z.string() }),
    /** Kid frames are signed with by default now (and handed to joining nodes). */
    signing_kid: z.string(),
    /** The scheduled successor, if any. */
    next: z
      .object({
        kid: z.string(),
        public_key: z.string(),
        not_before: Millis,
        scheduled_at: Millis,
        /** `not_before` has passed: agents pinning it are signed with it. */
        due: z.boolean(),
      })
      .nullable(),
    /** The key the latest completed rollover retired. */
    retired: z.object({ kid: z.string(), retired_at: Millis }).nullable(),
    nodes: z.array(NodeSigningKeysSchema),
  })
  .openapi("SigningKeyStatus");

/** Body of `POST /v1/instance/signing-keys/rotate`. */
export const ScheduleSigningKeyRolloverSchema = z
  .object({
    /** Hours until agents are signed with the new key. Defaults to 24. */
    delay_hours: z.number().int().min(1).max(720).optional(),
  })
  .openapi("ScheduleSigningKeyRollover");

/** Body of `POST /v1/instance/signing-keys/complete`. */
export const CompleteSigningKeyRolloverSchema = z
  .object({
    /**
     * Complete even though some nodes don't pin the new key yet. They will
     * need a re-join.
     */
    force: z.boolean().optional(),
  })
  .openapi("CompleteSigningKeyRollover");
