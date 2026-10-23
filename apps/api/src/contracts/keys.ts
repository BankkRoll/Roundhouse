/**
 * Master key rotation routes (ADR 0014 "Crypto") and control-plane
 * signing-key rollover routes (ADR 0014 §13). Owned by the
 * api-secrets-crypto stream.
 *
 * @module
 */
import { body, errors, json, sessionAuth } from "../schemas";
import {
  CompleteSigningKeyRolloverSchema,
  KeyRotationStartedSchema,
  KeyStatusSchema,
  ScheduleSigningKeyRolloverSchema,
  SigningKeyStatusSchema,
} from "../schemas/keys";
import { defineRoute, session } from "./policy";

/** Keyring and rotation status. */
export const getKeyStatus = defineRoute(session("instance:manage"), {
  method: "get",
  path: "/v1/instance/keys",
  tags: ["instance"],
  summary: "Get key status",
  security: sessionAuth,
  responses: { 200: json(KeyStatusSchema), ...errors(401, 403) },
});

/**
 * Starts the `KeyRotationWorkflow`: re-wraps every project DEK and instance
 * secret under the current KEK and re-seals format 1 values to format 2.
 * 409 while a rotation is running.
 */
export const rotateKeys = defineRoute(
  session("instance:manage", ["instance.key_rotation_started"], { reauth: true }),
  {
    method: "post",
    path: "/v1/instance/keys/rotate",
    tags: ["instance"],
    summary: "Rotate to the current master key",
    security: sessionAuth,
    responses: { 202: json(KeyRotationStartedSchema, "Started"), ...errors(401, 403, 409) },
  },
);

/** Signing keys, the scheduled rollover and each node's pinned kids. */
export const getSigningKeyStatus = defineRoute(session("instance:manage"), {
  method: "get",
  path: "/v1/instance/signing-keys",
  tags: ["instance"],
  summary: "Get signing key status",
  security: sessionAuth,
  responses: { 200: json(SigningKeyStatusSchema), ...errors(401, 403) },
});

/**
 * Generates a successor signing key, announces it to connected agents and
 * schedules the switch (`not_before`, 24 hours by default). 409 while one
 * is scheduled.
 */
export const scheduleSigningKeyRollover = defineRoute(
  session("instance:manage", ["key.rollover_scheduled"], { reauth: true }),
  {
    method: "post",
    path: "/v1/instance/signing-keys/rotate",
    tags: ["instance"],
    summary: "Schedule a signing key rollover",
    security: sessionAuth,
    request: body(ScheduleSigningKeyRolloverSchema),
    responses: { 200: json(SigningKeyStatusSchema), ...errors(400, 401, 403, 409) },
  },
);

/**
 * Promotes the successor once `not_before` has passed and deletes the old
 * private key. 409 while nodes still don't pin the successor, unless
 * `force`, or before `not_before`.
 */
export const completeSigningKeyRollover = defineRoute(
  session("instance:manage", ["key.rollover_completed"], { reauth: true }),
  {
    method: "post",
    path: "/v1/instance/signing-keys/complete",
    tags: ["instance"],
    summary: "Complete a signing key rollover",
    security: sessionAuth,
    request: body(CompleteSigningKeyRolloverSchema),
    responses: { 200: json(SigningKeyStatusSchema), ...errors(400, 401, 403, 404, 409) },
  },
);

/** Withdraws a scheduled successor before its `not_before`. */
export const cancelSigningKeyRollover = defineRoute(
  session("instance:manage", ["key.rollover_cancelled"], { reauth: true }),
  {
    method: "delete",
    path: "/v1/instance/signing-keys/next",
    tags: ["instance"],
    summary: "Cancel a signing key rollover",
    security: sessionAuth,
    responses: { 200: json(SigningKeyStatusSchema), ...errors(401, 403, 404, 409) },
  },
);

/** Every key route, by name. */
export const KEY_ROUTES = {
  getKeyStatus,
  rotateKeys,
  getSigningKeyStatus,
  scheduleSigningKeyRollover,
  completeSigningKeyRollover,
  cancelSigningKeyRollover,
} as const;
