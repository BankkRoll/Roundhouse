/**
 * Master key rotation routes (ADR 0014 "Crypto"). Owned by the
 * api-secrets-crypto stream.
 *
 * @module
 */
import { errors, json, sessionAuth } from "../schemas";
import { KeyRotationStartedSchema, KeyStatusSchema } from "../schemas/keys";
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

/** Every key route, by name. */
export const KEY_ROUTES = { getKeyStatus, rotateKeys } as const;
