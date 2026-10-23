/**
 * Variable routes (ADR 0014 "Secrets"). Owned by the api-secrets-crypto
 * stream. There is deliberately no reveal route: secret values are
 * write-only for every caller, the CLI included.
 *
 * Writes check `variables:manage` with the environment in scope, so a
 * protected environment's rules apply; reads check `variables:read`, and
 * plain values are filled in only for callers who also hold
 * `variables:read_plain`.
 *
 * @module
 */
import type { z } from "@hono/zod-openapi";
import { body, errors, json, sessionAuth } from "../schemas";
import {
  ResolvedVariablesSchema,
  VariableListSchema,
  VariablesPutResultSchema,
  VariablesPutSchema,
} from "../schemas/variables";
import { EnvironmentQuery, ProjectParams, ServiceParams } from "./params";
import { defineRoute, session } from "./policy";

export { VariableListSchema };

/** A service's variables in an environment. Plain values only for `variables:read_plain`. */
export const listServiceVariables = defineRoute(session("variables:read"), {
  method: "get",
  path: "/v1/services/{serviceId}/variables",
  tags: ["variables"],
  summary: "List a service's variables",
  security: sessionAuth,
  request: { params: ServiceParams, query: EnvironmentQuery },
  responses: { 200: json(VariableListSchema), ...errors(400, 401, 403, 404) },
});

/**
 * Upserts and deletes a service's variables in one batch, then returns the
 * full list and the classifier's warnings. Each value's tier is decided by
 * `decideVariableTier(classifyVariable(key, value), …)`. Errors (400):
 * `invalid_reference`, `confirmation_required` (only when a key becomes
 * secret; `details` lists them), `public_prefix_secret_value`, `tier_locked`,
 * `value_required`, `build_arg_secret` (a plain `available_at_build`
 * variable whose resolution reaches a secret), `invalid_request` with
 * `reserved_name` details (an `available_at_build` name the builder
 * reserves, like `PATH` or `LD_PRELOAD`); 403 `environment_protected`
 * reasons come back as `forbidden`; 409 when an `expected_version` is stale.
 * Every value is re-sealed for its new version and fingerprinted.
 */
export const putServiceVariables = defineRoute(session("variables:manage", ["variables.updated"]), {
  method: "put",
  path: "/v1/services/{serviceId}/variables",
  tags: ["variables"],
  summary: "Set and delete a service's variables",
  security: sessionAuth,
  request: { params: ServiceParams, query: EnvironmentQuery, ...body(VariablesPutSchema) },
  responses: { 200: json(VariablesPutResultSchema), ...errors(400, 401, 403, 404, 409) },
});

/** A project environment's shared variables. */
export const listSharedVariables = defineRoute(session("variables:read"), {
  method: "get",
  path: "/v1/projects/{projectId}/variables",
  tags: ["variables"],
  summary: "List shared variables",
  security: sessionAuth,
  request: { params: ProjectParams, query: EnvironmentQuery },
  responses: { 200: json(VariableListSchema), ...errors(400, 401, 403, 404) },
});

/** Upserts and deletes shared variables; same semantics as {@link putServiceVariables}. */
export const putSharedVariables = defineRoute(session("variables:manage", ["variables.updated"]), {
  method: "put",
  path: "/v1/projects/{projectId}/variables",
  tags: ["variables"],
  summary: "Set and delete shared variables",
  security: sessionAuth,
  request: { params: ProjectParams, query: EnvironmentQuery, ...body(VariablesPutSchema) },
  responses: { 200: json(VariablesPutResultSchema), ...errors(400, 401, 403, 404, 409) },
});

/**
 * The service's environment as `roundhouse run` needs it: plain values
 * resolved (built-ins included), and the keys the CLI must take from a local
 * `.env` (every secret, and every plain variable whose resolution reaches a
 * secret; see `secretDerivedVariables`). Never returns a secret value.
 * Deployment built-ins (`ROUNDHOUSE_DEPLOYMENT_ID`, `ROUNDHOUSE_GIT_COMMIT_SHA`)
 * come from the service's live deployment and are absent without one.
 * Unknown references and cycles are a 400 `invalid_reference` with one
 * detail per problem. Audited with the key names.
 */
export const resolveServiceVariables = defineRoute(
  session("variables:read_plain", ["variables.resolved"]),
  {
    method: "get",
    path: "/v1/services/{serviceId}/variables/resolved",
    tags: ["variables"],
    summary: "Resolve a service's plain variables for local runs",
    security: sessionAuth,
    request: { params: ServiceParams, query: EnvironmentQuery },
    responses: { 200: json(ResolvedVariablesSchema), ...errors(400, 401, 403, 404) },
  },
);

/** Every variable route, by name. */
export const VARIABLE_ROUTES = {
  listServiceVariables,
  putServiceVariables,
  listSharedVariables,
  putSharedVariables,
  resolveServiceVariables,
} as const;

/** Response body of a variable list. */
export type VariableList = z.infer<typeof VariableListSchema>;
