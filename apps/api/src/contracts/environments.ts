/**
 * Environment lifecycle routes (ADR 0007, "Environment lifecycle"): the
 * diff between two environments, promoting one into another as a change
 * set, and deleting an environment. Creating and cloning stay on
 * `POST /v1/projects/{projectId}/environments` (`createEnvironment`).
 *
 * Deviations from the ADR's table:
 * - Deleting needs a fresh session (`reauth`) and `?confirm=<slug>`, the
 *   dashboard's "type the slug"; deleting a protected environment also needs
 *   `access:manage`, which manages protection.
 * - The diff names the environments it compared, for clients that keep it.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { body, errors, json, sessionAuth } from "../schemas";
import { ChangeSetSchema } from "./changes";
import { EnvironmentParams, ProjectParams } from "./params";
import { defineRoute, session } from "./policy";

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

/** Query of the diff. */
export const EnvironmentDiffQuery = z.object({
  base: z.string().min(1),
  target: z.string().min(1),
});

/** How one variable compares; never its value. */
export const VariableComparisonSchema = z
  .object({
    key: z.string(),
    change: z.enum(["added", "removed", "changed", "same"]),
    /** Secret on either side. Secrets are compared by fingerprint only. */
    secret: z.boolean(),
  })
  .openapi("VariableComparison");

/** One service in an environment diff. */
export const ServiceComparisonSchema = z
  .object({
    service_id: z.string(),
    slug: z.string(),
    presence: z.enum(["both", "only_base", "only_target"]),
    /** JSON pointers into the config; generated domains and node selectors are left out. */
    config: z.array(z.object({ path: z.string(), before: z.unknown(), after: z.unknown() })),
    /** Database credentials are left out: they differ per environment by design. */
    variables: z.array(VariableComparisonSchema),
    /** Images of the active deployments, by digest. */
    image: z.object({ base: z.string().nullable(), target: z.string().nullable() }),
  })
  .openapi("ServiceComparison");

/** What differs between two environments; changed services first. */
export const EnvironmentDiffSchema = z
  .object({
    base_environment_id: z.string(),
    target_environment_id: z.string(),
    services: z.array(ServiceComparisonSchema),
    shared_variables: z.array(VariableComparisonSchema),
  })
  .openapi("EnvironmentDiff");

/** Body of `POST /v1/environments/{environmentId}/promote`. */
export const PromoteEnvironmentBody = z
  .object({
    from_environment_id: z.string().min(1),
    services: z.union([z.literal("all"), z.array(z.string()).min(1).max(100)]).default("all"),
    include: z
      .object({
        config: z.boolean().default(true),
        /** `non_secret` leaves secret variables as they are in the target. */
        variables: z.enum(["none", "non_secret", "all"]).default("non_secret"),
        /** Deploy the source's active image, by digest, without a rebuild. */
        image: z.boolean().default(true),
      })
      .default({ config: true, variables: "non_secret", image: true }),
  })
  .openapi("PromoteEnvironment");

/** Query of the delete route. */
export const DeleteEnvironmentQuery = z.object({
  /** The environment's slug, typed to confirm. */
  confirm: z.string().min(1),
});

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

/** What differs between two environments of a project. Secrets are compared by fingerprint. */
export const diffEnvironments = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/projects/{projectId}/environments/diff",
  tags: ["environments"],
  summary: "Compare two environments",
  security: sessionAuth,
  request: { params: ProjectParams, query: EnvironmentDiffQuery },
  responses: { 200: json(EnvironmentDiffSchema), ...errors(400, 401, 403, 404) },
});

/**
 * Proposes promoting one environment into another: a change set in the
 * target (`source: "promote"`) with config patches, variable writes and
 * `deployment.promote` ops. Never applied by this call; a protected target
 * needs its approval as usual. 409 when nothing differs.
 */
export const promoteEnvironment = defineRoute(
  session("environments:manage", ["environment.promote_proposed", "change_set.created"]),
  {
    method: "post",
    path: "/v1/environments/{environmentId}/promote",
    tags: ["environments"],
    summary: "Propose a promotion",
    security: sessionAuth,
    request: { params: EnvironmentParams, ...body(PromoteEnvironmentBody) },
    responses: { 201: json(ChangeSetSchema, "Created"), ...errors(400, 401, 403, 404, 409) },
  },
);

/**
 * Deletes an environment: its deployments stop, its volumes are scheduled
 * for deletion (72 h grace), its domains go, and a linked preview closes.
 * Production can never be deleted.
 */
export const deleteEnvironment = defineRoute(
  session("environments:manage", ["environment.deleted"], { reauth: true }),
  {
    method: "delete",
    path: "/v1/environments/{environmentId}",
    tags: ["environments"],
    summary: "Delete an environment",
    security: sessionAuth,
    request: { params: EnvironmentParams, query: DeleteEnvironmentQuery },
    responses: { 204: { description: "Deleted" }, ...errors(400, 401, 403, 404, 409) },
  },
);

/** Every environment lifecycle route, for the contract tests. */
export const ENVIRONMENT_ROUTES = {
  diffEnvironments,
  promoteEnvironment,
  deleteEnvironment,
} as const;

/** An environment diff. */
export type EnvironmentDiff = z.infer<typeof EnvironmentDiffSchema>;
