/**
 * Variable request/response schemas (ADR 0014 "Secrets"). Owned by the
 * api-secrets-crypto stream; re-exported from `../schemas`.
 *
 * Secret values are write-only: no schema here has a field that could carry
 * one back to a client.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import {
  ENV_KEY_RE,
  MAX_ENV_KEY_BYTES,
  MAX_ENV_VALUE_BYTES,
  utf8ByteLength,
} from "@roundhouse/protocol";
import { CLASSIFICATION_WARNING_CODES, VARIABLE_TIERS } from "@roundhouse/shared";

const Millis = z.number().int().openapi({ description: "Unix time in milliseconds" });

/** Environment variable or build arg name. */
export const VariableKeyField = z
  .string()
  .min(1)
  .max(MAX_ENV_KEY_BYTES)
  .regex(ENV_KEY_RE, "expected a name like DATABASE_URL")
  .openapi({ example: "DATABASE_URL" });

/** Plain-text variable value as written by a user; may contain `${{…}}` references. */
export const VariableValueField = z
  .string()
  .refine((v) => utf8ByteLength(v) <= MAX_ENV_VALUE_BYTES && !v.includes("\0"), {
    message: `must be at most ${MAX_ENV_VALUE_BYTES} bytes and contain no NUL`,
  });

/** Storage tier of a variable. */
export const VariableTierSchema = z.enum(VARIABLE_TIERS).openapi("VariableTier");

/** A classifier warning attached to one key. */
export const VariableWarningSchema = z
  .object({
    key: z.string(),
    code: z.enum(CLASSIFICATION_WARNING_CODES),
    message: z.string(),
  })
  .openapi("VariableWarning");

/**
 * A variable as listed. `value` is the plain value, and only when the caller
 * holds `variables:read_plain`; it is always `null` for secrets.
 */
export const VariableSchema = z
  .object({
    key: z.string(),
    tier: VariableTierSchema,
    /** The classifier fixed the tier (public prefix or recognised credential). */
    locked: z.boolean(),
    /** Plain value; `null` for secrets and for callers who may not read plain values. */
    value: z.string().nullable(),
    /**
     * First 8 hex of HMAC-SHA256 under the project's fingerprint key, so
     * equal values can be spotted without revealing either. `null` until
     * backfilled for values written before ADR 0014.
     */
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{8}$/)
      .nullable(),
    available_at_build: z.boolean(),
    mount_as_file: z.boolean(),
    /**
     * A preview placeholder (ADR 0007): the base environment's value was a
     * secret or derived from one, so this preview got an empty value.
     */
    withheld: z.boolean(),
    version: z.number().int().positive(),
    updated_at: Millis,
    /** User who last wrote it; `null` for system writes and older rows. */
    updated_by: z.string().nullable(),
  })
  .openapi("Variable");

/** A scope's variables. */
export const VariableListSchema = z
  .object({ variables: z.array(VariableSchema) })
  .openapi("VariableList");

/** One upsert in a {@link VariablesPutSchema}. */
export const VariableSetEntrySchema = z
  .object({
    key: VariableKeyField,
    /**
     * New value. Omit to change only flags of an existing variable; a tier
     * change from `secret` to `plain` always needs a value (`value_required`).
     */
    value: VariableValueField.optional(),
    /** Omit for the classifier's default (an existing secret stays secret). */
    tier: VariableTierSchema.optional(),
    /**
     * Also deliver to builds: plain values as build args, secrets as BuildKit
     * secrets. Omit to keep the current flag (`false` for new variables).
     * Refused for names the builder reserves, and for plain values that
     * reference a secret.
     */
    available_at_build: z.boolean().optional(),
    /** Omit to keep the current flag (`false` for new variables). */
    mount_as_file: z.boolean().optional(),
    /** Fail with 409 unless the stored version still is this one. */
    expected_version: z.number().int().positive().optional(),
  })
  .openapi("VariableSetEntry");

/**
 * Bulk change to the variables of one scope in one environment.
 *
 * Writes that leave a variable `secret` when it wasn't before need
 * `confirm_write_only: true` (400 `confirmation_required` lists the keys).
 * A public-prefix variable whose value looks like a credential needs its key
 * in `acknowledge_public` (400 `public_prefix_secret_value`).
 */
export const VariablesPutSchema = z
  .object({
    set: z.array(VariableSetEntrySchema).max(256).default([]),
    /** Removed; unknown keys are ignored. */
    delete: z.array(VariableKeyField).max(256).default([]),
    /** The caller confirmed these values can never be read back. */
    confirm_write_only: z.boolean().default(false),
    /** Public variables the caller confirmed may ship to browsers despite looking secret. */
    acknowledge_public: z.array(VariableKeyField).max(256).default([]),
  })
  .refine(
    (b) => {
      const keys = [...b.set.map((s) => s.key), ...b.delete];
      return new Set(keys).size === keys.length;
    },
    { message: "each key may appear once across set and delete" },
  )
  .openapi("VariablesPut");

/** Response of a variables write: the full list and the classifier's warnings. */
export const VariablesPutResultSchema = z
  .object({
    variables: z.array(VariableSchema),
    warnings: z.array(VariableWarningSchema),
  })
  .openapi("VariablesPutResult");

/**
 * What `roundhouse run` gets from the server: resolved plain values, and
 * the keys it must supply itself (secrets, and plain variables whose
 * resolution reaches a secret). Never carries a secret value.
 */
export const ResolvedVariablesSchema = z
  .object({
    /** Resolved plain environment, built-ins included. */
    variables: z.record(z.string(), z.string()),
    /** Keys whose values must come from the local `.env` file. */
    local_keys: z.array(z.string()),
  })
  .openapi("ResolvedVariables");
