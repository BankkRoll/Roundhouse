/**
 * Phase 1 API contract: every route of the deploy pipeline as a `createRoute`
 * definition (path, method, params, body, responses, errors, security), plus
 * the RBAC action and audit actions each one implies. No handlers live here.
 *
 * Register a handler with `router.openapi(route, handler)`, read the policy
 * with {@link policyOf}, and check it with `requireWorkspace(c, workspaceId,
 * policyOf(route).action)` once the owning workspace is known. Routes under a
 * project, service, deployment or build resolve that workspace from the row;
 * callers who aren't members get 404, like workspace routes.
 *
 * NOTE: routes without handlers are not registered yet, so they are absent
 * from `/v1/openapi.json`. A route appears in the document once its handler
 * is registered on a router mounted in `index.ts`.
 *
 * The dashboard imports types from here: {@link ResponseOf}, {@link BodyOf}
 * and {@link QueryOf} derive request and response shapes from a route, and
 * the resource types (`Project`, `Deployment`, …) are re-exported below.
 *
 * @module
 */
import { createRoute, type RouteConfig, z } from "@hono/zod-openapi";
import { type Action, type AuditAction, SERVICE_KINDS } from "@openrail/shared";
import {
  ApiTokenSchema,
  body,
  CreateApiTokenSchema,
  CreatedApiTokenSchema,
  CursorField,
  DeploymentDetailSchema,
  DeploymentSchema,
  DomainSchema,
  EnvironmentSchema,
  errors,
  GithubRepositorySchema,
  GithubStatusSchema,
  InstanceSettingsPatchSchema,
  InstanceSettingsSchema,
  json,
  LimitField,
  LogPageSchema,
  NameField,
  ProjectDetailSchema,
  ProjectSchema,
  ProjectSummarySchema,
  ResolvedVariablesSchema,
  RevealedVariablesSchema,
  SERVICE_CONFIG_PARTS,
  ServiceConfigPatchSchema,
  ServiceConfigSchema,
  ServiceSchema,
  ServiceSlugField,
  ServiceSourceSchema,
  SlugField,
  sessionAuth,
  sessionOnlyAuth,
  VariableSchema,
  VariablesPutSchema,
  VariablesRevealSchema,
  WorkspaceParams,
} from "./schemas";

// -----------------------------------------------------------------------------
// Policies
// -----------------------------------------------------------------------------

/** OpenAPI extension key carrying a route's {@link RoutePolicy}. */
export const POLICY_KEY = "x-openrail-policy";

/** How a route authenticates its caller. */
export type RouteAuth =
  /**
   * Better Auth session cookie or an API token (`Authorization: Bearer
   * tok_…`); RBAC applies, and a token is further limited to its workspace
   * and scopes.
   */
  | "session"
  /** Better Auth session cookie only; API tokens are refused with 403. */
  | "session_only"
  /** `X-Hub-Signature-256` over the raw body with the App's webhook secret. */
  | "github_signature";

/** Who may call a route and what it records. */
export interface RoutePolicy {
  auth: RouteAuth;
  /**
   * Checked with `can(role, action)` against the caller's role in the owning
   * workspace. `instance:manage` routes have no owning workspace: the caller
   * must hold the action in at least one workspace. `null` for routes that
   * authenticate by signature.
   */
  action: Action | null;
  /** Audit actions the handler records when it succeeds (some only in certain cases). */
  audit: readonly AuditAction[];
}

/**
 * `createRoute` plus a policy, stored under {@link POLICY_KEY} so it also
 * appears in the OpenAPI document.
 */
function defineRoute<P extends string, R extends Omit<RouteConfig, "path"> & { path: P }>(
  policy: RoutePolicy,
  config: R,
) {
  return createRoute({ ...config, [POLICY_KEY]: policy } as R & { [POLICY_KEY]: RoutePolicy });
}

/**
 * Reads the policy of a contract route.
 *
 * @param route - A route exported from this module.
 * @returns Its auth mode, RBAC action and audit actions.
 * @example
 * await requireWorkspace(c, project.workspaceId, policyOf(getProject).action!);
 */
export function policyOf(route: { [POLICY_KEY]: RoutePolicy }): RoutePolicy {
  return route[POLICY_KEY];
}

const session = (action: Action, audit: readonly AuditAction[] = []): RoutePolicy => ({
  auth: "session",
  action,
  audit,
});

const sessionOnly = (action: Action, audit: readonly AuditAction[] = []): RoutePolicy => ({
  auth: "session_only",
  action,
  audit,
});

// -----------------------------------------------------------------------------
// Params and query
// -----------------------------------------------------------------------------

/** `{projectId}` path param. */
export const ProjectParams = z.object({ projectId: z.string() });

/** `{serviceId}` path param. */
export const ServiceParams = z.object({ serviceId: z.string() });

/** `{deploymentId}` path param. */
export const DeploymentParams = z.object({ deploymentId: z.string() });

/** `{buildId}` path param. */
export const BuildParams = z.object({ buildId: z.string() });

/** Selects the environment a per-environment resource belongs to. */
export const EnvironmentQuery = z.object({ environment_id: z.string() });

/** Log page size; larger than other lists because lines are small. */
const LogLimitField = z.coerce.number().int().min(1).max(1000).default(200);

/** Cursor pagination for log pages; see `LogPageSchema`. */
export const LogQuery = z.object({ cursor: CursorField, limit: LogLimitField });

// -----------------------------------------------------------------------------
// Projects
// -----------------------------------------------------------------------------

/** Body of `POST /v1/workspaces/{workspaceId}/projects`. */
export const CreateProjectBody = z
  .object({
    name: NameField,
    /** Derived from `name` when omitted; suffixed with -2, -3, … when taken. */
    slug: SlugField.optional(),
    description: z.string().trim().max(500).optional(),
  })
  .openapi("CreateProject");

/** Body of `PATCH /v1/projects/{projectId}`. */
export const UpdateProjectBody = z
  .object({
    name: NameField.optional(),
    slug: SlugField.optional(),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "nothing to update" })
  .openapi("UpdateProject");

/** Query of `GET /v1/workspaces/{workspaceId}/projects`. */
export const ListProjectsQuery = z.object({
  /** Only the live project with this exact slug: a list of one, or empty. */
  slug: SlugField.optional(),
});

/** Lists the live projects of a workspace, or finds one by slug. */
export const listProjects = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/workspaces/{workspaceId}/projects",
  tags: ["projects"],
  summary: "List projects",
  security: sessionAuth,
  request: { params: WorkspaceParams, query: ListProjectsQuery },
  responses: {
    200: json(z.object({ projects: z.array(ProjectSchema) })),
    ...errors(400, 401, 403, 404),
  },
});

/**
 * Creates a project with a `production` environment. A taken slug, requested
 * or derived, is suffixed with -2, -3, … rather than refused.
 */
export const createProject = defineRoute(session("projects:manage", ["project.created"]), {
  method: "post",
  path: "/v1/workspaces/{workspaceId}/projects",
  tags: ["projects"],
  summary: "Create a project",
  security: sessionAuth,
  request: { params: WorkspaceParams, ...body(CreateProjectBody) },
  responses: { 201: json(ProjectDetailSchema, "Created"), ...errors(400, 401, 403, 404, 409) },
});

/** A project with its environments and services. */
export const getProject = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/projects/{projectId}",
  tags: ["projects"],
  summary: "Get a project",
  security: sessionAuth,
  request: { params: ProjectParams },
  responses: { 200: json(ProjectDetailSchema), ...errors(401, 403, 404) },
});

/** Renames or re-describes a project. 409 when the new slug is taken. */
export const updateProject = defineRoute(session("projects:manage", ["project.updated"]), {
  method: "patch",
  path: "/v1/projects/{projectId}",
  tags: ["projects"],
  summary: "Update a project",
  security: sessionAuth,
  request: { params: ProjectParams, ...body(UpdateProjectBody) },
  responses: { 200: json(ProjectSchema), ...errors(400, 401, 403, 404, 409) },
});

/**
 * Soft-deletes a project and removes its workloads from every node; the
 * slug becomes free immediately.
 */
export const deleteProject = defineRoute(session("projects:manage", ["project.deleted"]), {
  method: "delete",
  path: "/v1/projects/{projectId}",
  tags: ["projects"],
  summary: "Delete a project",
  security: sessionAuth,
  request: { params: ProjectParams },
  responses: { 204: { description: "Deleted" }, ...errors(401, 403, 404) },
});

/** Query of `GET /v1/projects/{projectId}/summary`. */
export const ProjectSummaryQuery = z.object({
  /** Environment to summarise; the production environment when omitted. */
  environment_id: z.string().optional(),
});

/**
 * A project with each service's latest config version, first domain and
 * newest deployment in one environment, in a fixed number of queries
 * however many services there are.
 */
export const getProjectSummary = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/projects/{projectId}/summary",
  tags: ["projects"],
  summary: "Summarise a project",
  security: sessionAuth,
  request: { params: ProjectParams, query: ProjectSummaryQuery },
  responses: { 200: json(ProjectSummarySchema), ...errors(400, 401, 403, 404) },
});

/** Every live project of a workspace summarised in its production environment, by name. */
export const listProjectSummaries = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/workspaces/{workspaceId}/projects/summary",
  tags: ["projects"],
  summary: "Summarise every project",
  security: sessionAuth,
  request: { params: WorkspaceParams },
  responses: {
    200: json(z.object({ projects: z.array(ProjectSummarySchema) })),
    ...errors(401, 403, 404),
  },
});

// -----------------------------------------------------------------------------
// Environments
// -----------------------------------------------------------------------------

/** Body of `POST /v1/projects/{projectId}/environments`. */
export const CreateEnvironmentBody = z
  .object({
    name: NameField,
    /** Derived from `name` when omitted; suffixed with -2, -3, … when taken. */
    slug: SlugField.optional(),
    /** A project has exactly one `production` environment, created with it. */
    kind: z.enum(["staging", "preview"]),
    pr_number: z.number().int().positive().optional(),
    source_branch: z.string().min(1).max(255).optional(),
    /**
     * Copy the latest config of every service and every variable from this
     * environment. Without it, services start from defaults with no variables.
     */
    copy_from_environment_id: z.string().optional(),
  })
  .openapi("CreateEnvironment");

/** Lists a project's environments, production first. */
export const listEnvironments = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/projects/{projectId}/environments",
  tags: ["environments"],
  summary: "List environments",
  security: sessionAuth,
  request: { params: ProjectParams },
  responses: {
    200: json(z.object({ environments: z.array(EnvironmentSchema) })),
    ...errors(401, 403, 404),
  },
});

/** Creates an environment. Audited as a project update with `environment_id` in metadata. */
export const createEnvironment = defineRoute(session("projects:manage", ["project.updated"]), {
  method: "post",
  path: "/v1/projects/{projectId}/environments",
  tags: ["environments"],
  summary: "Create an environment",
  security: sessionAuth,
  request: { params: ProjectParams, ...body(CreateEnvironmentBody) },
  responses: { 201: json(EnvironmentSchema, "Created"), ...errors(400, 401, 403, 404, 409) },
});

// -----------------------------------------------------------------------------
// Services
// -----------------------------------------------------------------------------

/** Body of `POST /v1/projects/{projectId}/services`. */
export const CreateServiceBody = z
  .object({
    name: NameField,
    /**
     * Derived from `name` when omitted. Also the `${{slug.VAR}}` reference
     * namespace, so a taken slug or a reserved one (`shared`) is suffixed
     * with -2, -3, … rather than refused.
     */
    slug: ServiceSlugField.optional(),
    kind: z.enum(SERVICE_KINDS).default("app"),
    icon: z.string().max(64).optional(),
    source: ServiceSourceSchema,
    /**
     * Overrides applied on top of `defaultServiceConfig(source)` to create
     * config version 1 in every environment of the project.
     */
    config: ServiceConfigPatchSchema.omit({ source: true }).optional(),
  })
  .openapi("CreateService");

/** Response of `POST /v1/projects/{projectId}/services`. */
export const CreatedServiceSchema = z
  .object({ service: ServiceSchema, configs: z.array(ServiceConfigSchema) })
  .openapi("CreatedService");

/**
 * Body of `PATCH /v1/services/{serviceId}`: service metadata and/or a config
 * change for one environment. Any config part requires `environment_id`;
 * with `expected_version`, the change fails with 409 unless the latest
 * version still is that one, so concurrent editors don't overwrite each other.
 * A new `slug` that another service uses is a 409 (a rename is exact); a
 * reserved one is suffixed like on create.
 */
export const UpdateServiceBody = ServiceConfigPatchSchema.extend({
  environment_id: z.string().optional(),
  expected_version: z.number().int().positive().optional(),
  name: NameField.optional(),
  slug: ServiceSlugField.optional(),
  icon: z.string().max(64).nullable().optional(),
})
  .refine(
    (b) => b.environment_id !== undefined || SERVICE_CONFIG_PARTS.every((p) => b[p] === undefined),
    { message: "environment_id is required to change config", path: ["environment_id"] },
  )
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "nothing to update" })
  .openapi("UpdateService");

/** Response of `PATCH /v1/services/{serviceId}`. `config` is the new version, if one was made. */
export const UpdatedServiceSchema = z
  .object({ service: ServiceSchema, config: ServiceConfigSchema.nullable() })
  .openapi("UpdatedService");

/** Query of `GET /v1/services/{serviceId}/config`. */
export const ServiceConfigQuery = EnvironmentQuery.extend({
  /** A specific version; the latest when omitted. */
  version: z.coerce.number().int().positive().optional(),
});

/** Lists a project's live services. */
export const listServices = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/projects/{projectId}/services",
  tags: ["services"],
  summary: "List services",
  security: sessionAuth,
  request: { params: ProjectParams },
  responses: {
    200: json(z.object({ services: z.array(ServiceSchema) })),
    ...errors(401, 403, 404),
  },
});

/** Creates a service and its first config version in every environment. Does not deploy. */
export const createService = defineRoute(session("services:manage", ["service.created"]), {
  method: "post",
  path: "/v1/projects/{projectId}/services",
  tags: ["services"],
  summary: "Create a service",
  security: sessionAuth,
  request: { params: ProjectParams, ...body(CreateServiceBody) },
  responses: { 201: json(CreatedServiceSchema, "Created"), ...errors(400, 401, 403, 404, 409) },
});

/** A service's metadata. Config is per environment; see {@link getServiceConfig}. */
export const getService = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/services/{serviceId}",
  tags: ["services"],
  summary: "Get a service",
  security: sessionAuth,
  request: { params: ServiceParams },
  responses: { 200: json(ServiceSchema), ...errors(401, 403, 404) },
});

/**
 * Updates metadata and/or applies a new config version for one environment.
 * A config change takes effect on the next deployment.
 */
export const updateService = defineRoute(session("services:manage", ["service.updated"]), {
  method: "patch",
  path: "/v1/services/{serviceId}",
  tags: ["services"],
  summary: "Update a service or its config",
  security: sessionAuth,
  request: { params: ServiceParams, ...body(UpdateServiceBody) },
  responses: { 200: json(UpdatedServiceSchema), ...errors(400, 401, 403, 404, 409) },
});

/** Soft-deletes a service and removes its workloads from every node. */
export const deleteService = defineRoute(session("services:manage", ["service.deleted"]), {
  method: "delete",
  path: "/v1/services/{serviceId}",
  tags: ["services"],
  summary: "Delete a service",
  security: sessionAuth,
  request: { params: ServiceParams },
  responses: { 204: { description: "Deleted" }, ...errors(401, 403, 404) },
});

/** The latest (or a given) config version of a service in an environment. */
export const getServiceConfig = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/services/{serviceId}/config",
  tags: ["services"],
  summary: "Get a service's config in an environment",
  security: sessionAuth,
  request: { params: ServiceParams, query: ServiceConfigQuery },
  responses: { 200: json(ServiceConfigSchema), ...errors(400, 401, 403, 404) },
});

// -----------------------------------------------------------------------------
// Variables
// -----------------------------------------------------------------------------

/** A scope's variables, secrets masked. */
export const VariableListSchema = z
  .object({ variables: z.array(VariableSchema) })
  .openapi("VariableList");

/** A service's variables in an environment. */
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
 * Upserts and deletes a service's variables in one transaction, then returns
 * the full masked list. Reference syntax is checked here; unknown references
 * and cycles are reported at deploy time.
 */
export const putServiceVariables = defineRoute(session("variables:manage", ["variables.updated"]), {
  method: "put",
  path: "/v1/services/{serviceId}/variables",
  tags: ["variables"],
  summary: "Set and delete a service's variables",
  security: sessionAuth,
  request: { params: ServiceParams, query: EnvironmentQuery, ...body(VariablesPutSchema) },
  responses: { 200: json(VariableListSchema), ...errors(400, 401, 403, 404) },
});

/** Returns plaintext for the given keys. Audited with the keys, never the values. */
export const revealServiceVariables = defineRoute(
  session("variables:reveal", ["variables.revealed"]),
  {
    method: "post",
    path: "/v1/services/{serviceId}/variables/reveal",
    tags: ["variables"],
    summary: "Reveal a service's secret values",
    security: sessionAuth,
    request: { params: ServiceParams, query: EnvironmentQuery, ...body(VariablesRevealSchema) },
    responses: { 200: json(RevealedVariablesSchema), ...errors(400, 401, 403, 404) },
  },
);

/**
 * Resolves a service's environment the way a deployment does: built-ins,
 * then its own variables with every `${{…}}` substituted, through the same
 * `resolveVariables`. Deployment built-ins (`OPENRAIL_DEPLOYMENT_ID`,
 * `OPENRAIL_GIT_COMMIT_SHA`) come from the service's live deployment, and are
 * absent without one. Plaintext, secrets included, so it needs
 * `variables:reveal` and is audited with the keys. Unknown references and
 * cycles are a 400 `invalid_reference` with one detail per problem.
 */
export const resolveServiceVariables = defineRoute(
  session("variables:reveal", ["variables.resolved"]),
  {
    method: "post",
    path: "/v1/services/{serviceId}/variables/resolve",
    tags: ["variables"],
    summary: "Resolve a service's environment",
    security: sessionAuth,
    request: { params: ServiceParams, query: EnvironmentQuery },
    responses: { 200: json(ResolvedVariablesSchema), ...errors(400, 401, 403, 404) },
  },
);

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
  responses: { 200: json(VariableListSchema), ...errors(400, 401, 403, 404) },
});

/** Returns plaintext for the given shared keys. Audited. */
export const revealSharedVariables = defineRoute(
  session("variables:reveal", ["variables.revealed"]),
  {
    method: "post",
    path: "/v1/projects/{projectId}/variables/reveal",
    tags: ["variables"],
    summary: "Reveal shared secret values",
    security: sessionAuth,
    request: { params: ProjectParams, query: EnvironmentQuery, ...body(VariablesRevealSchema) },
    responses: { 200: json(RevealedVariablesSchema), ...errors(400, 401, 403, 404) },
  },
);

// -----------------------------------------------------------------------------
// Deployments and logs
// -----------------------------------------------------------------------------

/** Query of `GET /v1/services/{serviceId}/deployments`. */
export const DeploymentListQuery = EnvironmentQuery.extend({
  cursor: CursorField,
  limit: LimitField,
});

/** Body of `POST /v1/services/{serviceId}/deployments`. */
export const CreateDeploymentBody = z
  .object({
    /** Git sources only: the commit to build. Defaults to the branch head. */
    commit_sha: z
      .string()
      .regex(/^([a-f0-9]{40}|[a-f0-9]{64})$/, "expected a full commit sha")
      .optional(),
  })
  .openapi("CreateDeployment");

/** A page of deployments, newest first. */
export const DeploymentPageSchema = z
  .object({ deployments: z.array(DeploymentSchema), next_cursor: z.string().nullable() })
  .openapi("DeploymentPage");

/** A service's deployments in an environment, newest first. */
export const listDeployments = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/services/{serviceId}/deployments",
  tags: ["deployments"],
  summary: "List deployments",
  security: sessionAuth,
  request: { params: ServiceParams, query: DeploymentListQuery },
  responses: { 200: json(DeploymentPageSchema), ...errors(400, 401, 403, 404) },
});

/**
 * Deploys the latest config version. 409 when it has 0 replicas or the
 * environment has no config for the service. Build and scheduling failures
 * are not errors here: they surface later as a `failed` deployment.
 */
export const createDeployment = defineRoute(session("deployments:create", ["deployment.created"]), {
  method: "post",
  path: "/v1/services/{serviceId}/deployments",
  tags: ["deployments"],
  summary: "Deploy a service",
  security: sessionAuth,
  request: { params: ServiceParams, query: EnvironmentQuery, ...body(CreateDeploymentBody) },
  responses: { 201: json(DeploymentSchema, "Created"), ...errors(400, 401, 403, 404, 409) },
});

/** A deployment with its events and placements. */
export const getDeployment = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/deployments/{deploymentId}",
  tags: ["deployments"],
  summary: "Get a deployment",
  security: sessionAuth,
  request: { params: DeploymentParams },
  responses: { 200: json(DeploymentDetailSchema), ...errors(401, 403, 404) },
});

/**
 * Creates a new deployment from this one's image digest and config version,
 * skipping the build. Variables resolve as they are now, not as this
 * deployment had them (ADR 0003, "Rollback semantics"). 409 unless this
 * deployment's status is in `ROLLBACK_SOURCE_STATUSES`.
 */
export const rollbackDeployment = defineRoute(
  session("deployments:create", ["deployment.rolled_back"]),
  {
    method: "post",
    path: "/v1/deployments/{deploymentId}/rollback",
    tags: ["deployments"],
    summary: "Roll back to a deployment",
    security: sessionAuth,
    request: { params: DeploymentParams },
    responses: { 201: json(DeploymentSchema, "Created"), ...errors(401, 403, 404, 409) },
  },
);

/** Cancels a deployment. 409 unless its status is in `CANCELLABLE_DEPLOYMENT_STATUSES`. */
export const cancelDeployment = defineRoute(
  session("deployments:create", ["deployment.cancelled"]),
  {
    method: "post",
    path: "/v1/deployments/{deploymentId}/cancel",
    tags: ["deployments"],
    summary: "Cancel a deployment",
    security: sessionAuth,
    request: { params: DeploymentParams },
    responses: { 200: json(DeploymentSchema), ...errors(401, 403, 404, 409) },
  },
);

/** Runtime logs of a deployment's replicas, paged backwards from the newest. */
export const getDeploymentLogs = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/deployments/{deploymentId}/logs",
  tags: ["logs"],
  summary: "Get deployment logs",
  security: sessionAuth,
  request: { params: DeploymentParams, query: LogQuery },
  responses: { 200: json(LogPageSchema), ...errors(400, 401, 403, 404) },
});

/** Logs of a build, paged backwards from the newest. */
export const getBuildLogs = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/builds/{buildId}/logs",
  tags: ["logs"],
  summary: "Get build logs",
  security: sessionAuth,
  request: { params: BuildParams, query: LogQuery },
  responses: { 200: json(LogPageSchema), ...errors(400, 401, 403, 404) },
});

// -----------------------------------------------------------------------------
// Domains
// -----------------------------------------------------------------------------

/** A service's domains, in every environment unless `environment_id` is given. */
export const listDomains = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/services/{serviceId}/domains",
  tags: ["domains"],
  summary: "List a service's domains",
  security: sessionAuth,
  request: { params: ServiceParams, query: EnvironmentQuery.partial() },
  responses: {
    200: json(z.object({ domains: z.array(DomainSchema) })),
    ...errors(401, 403, 404),
  },
});

// -----------------------------------------------------------------------------
// Instance settings
// -----------------------------------------------------------------------------

/** Install-wide ingress settings. Owners only. */
export const getInstanceSettings = defineRoute(sessionOnly("instance:manage"), {
  method: "get",
  path: "/v1/instance/settings",
  tags: ["instance"],
  summary: "Get instance settings",
  security: sessionOnlyAuth,
  responses: { 200: json(InstanceSettingsSchema), ...errors(401, 403) },
});

/**
 * Changes instance settings. An ingress change (`apps_domain`, `tls_mode`)
 * pushes new desired state to every node; existing generated domains keep
 * their hostnames when `apps_domain` changes, new ones use the new domain.
 * `log_retention_days` applies from the next hourly retention run.
 *
 * Instances have no audit log of their own, so the change is recorded as
 * `instance.settings_updated` in every workspace the caller owns: everyone
 * who can see that workspace's log sees who changed the install under it.
 */
export const updateInstanceSettings = defineRoute(
  sessionOnly("instance:manage", ["instance.settings_updated"]),
  {
    method: "patch",
    path: "/v1/instance/settings",
    tags: ["instance"],
    summary: "Update instance settings",
    security: sessionOnlyAuth,
    request: body(InstanceSettingsPatchSchema),
    responses: { 200: json(InstanceSettingsSchema), ...errors(400, 401, 403) },
  },
);

// -----------------------------------------------------------------------------
// GitHub App
// -----------------------------------------------------------------------------

/** Query of the GitHub routes that act for a workspace. */
export const GithubWorkspaceQuery = z.object({ workspace_id: z.string() });

/** Body of `POST /v1/github/manifest`. */
export const GithubManifestBody = z
  .object({
    /** Workspace that will own installations made right after creation. */
    workspace_id: z.string(),
    /** Create the App under this organization instead of the user's account. */
    organization: z
      .string()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "expected a GitHub organization login")
      .optional(),
  })
  .openapi("GithubManifestRequest");

/**
 * What the dashboard needs to start the manifest flow: it POSTs a form with
 * `manifest` (JSON-encoded) to `post_url`, which already carries `state`.
 */
export const GithubManifestSchema = z
  .object({
    manifest: z.record(z.string(), z.unknown()),
    /** Single-use, expires after 10 minutes; checked by the callback. */
    state: z.string(),
    post_url: z.string(),
  })
  .openapi("GithubManifest");

/**
 * Query of `GET /v1/github/callback`. `state` is ours in every case. GitHub
 * sends `code` alone after the App is created (manifest flow), and
 * `installation_id` + `setup_action` + `code` after it is installed: the
 * App requests user authorization during installation, so that `code` is an
 * OAuth code for the user who installed it.
 */
export const GithubCallbackQuery = z.object({
  state: z.string().min(1).max(512),
  code: z.string().min(1).max(200).optional(),
  installation_id: z.coerce.number().int().positive().optional(),
  setup_action: z.enum(["install", "update", "request"]).optional(),
});

/** Whether a GitHub App exists and which installations the workspace can use. */
export const getGithubStatus = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/github/status",
  tags: ["github"],
  summary: "GitHub App status",
  security: sessionAuth,
  request: { query: GithubWorkspaceQuery },
  responses: { 200: json(GithubStatusSchema), ...errors(400, 401, 403, 404) },
});

/** Starts creating the instance's GitHub App. 409 when one already exists. */
export const createGithubManifest = defineRoute(sessionOnly("instance:manage"), {
  method: "post",
  path: "/v1/github/manifest",
  tags: ["github"],
  summary: "Start creating the GitHub App",
  security: sessionOnlyAuth,
  request: body(GithubManifestBody),
  responses: { 200: json(GithubManifestSchema), ...errors(400, 401, 403, 409) },
});

/**
 * GitHub redirects the browser here.
 *
 * - With `code` alone: exchanges it for the App's credentials and stores them
 *   sealed (needs `instance:manage`).
 * - With `installation_id`: records the installation for the workspace bound
 *   to `state` (needs `projects:manage` there). The installation ID comes
 *   from the browser, so the handler requires proof that this user can
 *   access it: it exchanges `code` for a user-to-server token, checks that
 *   `GET /user/installations` lists the installation, and revokes the token.
 *   A missing code, a mismatch or a reused `state` is refused and recorded
 *   as `github.installation_rejected`.
 *
 * Redirects to the dashboard.
 */
export const githubCallback = defineRoute(
  sessionOnly("projects:manage", [
    "github.app_created",
    "github.installation_added",
    "github.installation_rejected",
  ]),
  {
    method: "get",
    path: "/v1/github/callback",
    tags: ["github"],
    summary: "GitHub App setup callback",
    security: sessionOnlyAuth,
    request: { query: GithubCallbackQuery },
    responses: {
      302: { description: "Redirect to the dashboard" },
      ...errors(400, 401, 403),
    },
  },
);

/** Repositories the workspace's installations can read, for picking a service source. */
export const listGithubRepositories = defineRoute(session("services:manage"), {
  method: "get",
  path: "/v1/github/repositories",
  tags: ["github"],
  summary: "List repositories",
  security: sessionAuth,
  request: {
    query: GithubWorkspaceQuery.extend({
      /** Limit to one installation (`ghi_…`). */
      installation_id: z.string().optional(),
    }),
  },
  responses: {
    200: json(z.object({ repositories: z.array(GithubRepositorySchema) })),
    ...errors(400, 401, 403, 404),
  },
});

/** Headers GitHub sends with every webhook delivery. */
export const GithubWebhookHeaders = z.object({
  "x-github-event": z.string(),
  "x-github-delivery": z.string(),
  "x-hub-signature-256": z.string().regex(/^sha256=[a-f0-9]{64}$/),
});

/**
 * Receives GitHub webhooks. The body is deliberately not declared: the
 * handler must verify `X-Hub-Signature-256` over the raw bytes, in constant
 * time, before parsing anything. Handles `installation` (records it) and
 * `push` (deploys services tracking the branch). Called without a browser
 * Origin, so the same-origin guard lets it through.
 */
export const githubWebhook = defineRoute(
  {
    auth: "github_signature",
    action: null,
    audit: ["github.installation_added", "deployment.created"],
  },
  {
    method: "post",
    path: "/v1/webhooks/github",
    tags: ["github"],
    summary: "GitHub webhook receiver",
    request: { headers: GithubWebhookHeaders },
    responses: {
      202: { description: "Accepted" },
      ...errors(400, 401),
    },
  },
);

// -----------------------------------------------------------------------------
// Realtime
// -----------------------------------------------------------------------------

/** Query of `GET /v1/projects/{projectId}/realtime`. */
export const ProjectRealtimeQuery = z.object({
  /**
   * `cli` for a terminal client: it gets every message but isn't shown in
   * presence. Sockets opened with an API token are never shown either.
   */
  client: z.enum(["web", "cli"]).default("web"),
});

/**
 * Upgrades to a WebSocket held by the project's `ProjectRoom` Durable Object.
 * Messages are documented as `RealtimeServerMessageSchema` (server → browser)
 * and `RealtimeClientMessageSchema` (browser → server), JSON text frames.
 *
 * A browser can't read the status of a refused upgrade, so a missing or
 * expired session, a lost membership and an unknown project are reported by
 * accepting the socket and closing it at once with `REALTIME_CLOSE_CODES`
 * 4401, 4403 or 4404 (from `@openrail/shared`). The session (or token) and
 * membership are re-checked every minute while connected, and the socket is
 * closed the same way when either lapses. Only a non-upgrade request (426)
 * and a cross-origin browser upgrade (403) are refused over HTTP.
 */
export const projectRealtime = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/projects/{projectId}/realtime",
  tags: ["realtime"],
  summary: "Project realtime socket",
  security: sessionAuth,
  request: { params: ProjectParams, query: ProjectRealtimeQuery },
  responses: {
    101: { description: "Switching Protocols" },
    ...errors(403, 426),
  },
});

// -----------------------------------------------------------------------------
// API tokens
// -----------------------------------------------------------------------------

/** `{workspaceId}` and `{tokenId}` path params. */
export const ApiTokenParams = WorkspaceParams.extend({ tokenId: z.string() });

/** A workspace's API tokens, newest first, revoked and expired ones included. */
export const listApiTokens = defineRoute(session("tokens:manage"), {
  method: "get",
  path: "/v1/workspaces/{workspaceId}/tokens",
  tags: ["tokens"],
  summary: "List API tokens",
  security: sessionAuth,
  request: { params: WorkspaceParams },
  responses: {
    200: json(z.object({ tokens: z.array(ApiTokenSchema) })),
    ...errors(401, 403, 404),
  },
});

/**
 * Creates an API token and returns its secret, once; only a SHA-256 hash is
 * stored. Every scope must be granted by the caller's role; a token creating
 * a token (it needs the `tokens:manage` scope) can only grant scopes it holds.
 */
export const createApiToken = defineRoute(session("tokens:manage", ["token.created"]), {
  method: "post",
  path: "/v1/workspaces/{workspaceId}/tokens",
  tags: ["tokens"],
  summary: "Create an API token",
  security: sessionAuth,
  request: { params: WorkspaceParams, ...body(CreateApiTokenSchema) },
  responses: { 201: json(CreatedApiTokenSchema, "Created"), ...errors(400, 401, 403, 404) },
});

/** Revokes a token at once. Revoking a revoked token is a no-op. */
export const revokeApiToken = defineRoute(session("tokens:manage", ["token.revoked"]), {
  method: "delete",
  path: "/v1/workspaces/{workspaceId}/tokens/{tokenId}",
  tags: ["tokens"],
  summary: "Revoke an API token",
  security: sessionAuth,
  request: { params: ApiTokenParams },
  responses: { 204: { description: "Revoked" }, ...errors(401, 403, 404) },
});

// -----------------------------------------------------------------------------
// Index and derived types
// -----------------------------------------------------------------------------

/** Every Phase 1 route, by name. */
export const PHASE1_ROUTES = {
  listProjects,
  createProject,
  getProject,
  updateProject,
  deleteProject,
  getProjectSummary,
  listProjectSummaries,
  listEnvironments,
  createEnvironment,
  listServices,
  createService,
  getService,
  updateService,
  deleteService,
  getServiceConfig,
  listServiceVariables,
  putServiceVariables,
  revealServiceVariables,
  resolveServiceVariables,
  listSharedVariables,
  putSharedVariables,
  revealSharedVariables,
  listDeployments,
  createDeployment,
  getDeployment,
  rollbackDeployment,
  cancelDeployment,
  getDeploymentLogs,
  getBuildLogs,
  listDomains,
  getInstanceSettings,
  updateInstanceSettings,
  getGithubStatus,
  createGithubManifest,
  githubCallback,
  listGithubRepositories,
  githubWebhook,
  projectRealtime,
  listApiTokens,
  createApiToken,
  revokeApiToken,
} as const;

type JsonSchemaOf<T> = T extends { content: { "application/json": { schema: infer S } } }
  ? S
  : never;

/**
 * Response body of a route for a status code.
 *
 * @example
 * type Page = ResponseOf<typeof listDeployments, 200>; // { deployments: …; next_cursor: … }
 */
export type ResponseOf<R extends RouteConfig, S extends keyof R["responses"]> =
  JsonSchemaOf<R["responses"][S]> extends z.ZodType
    ? z.output<JsonSchemaOf<R["responses"][S]>>
    : never;

/** JSON request body a client sends to a route (input type, before defaults). */
export type BodyOf<R extends RouteConfig> = R["request"] extends {
  body: { content: { "application/json": { schema: infer S } } };
}
  ? S extends z.ZodType
    ? z.input<S>
    : never
  : never;

/** Query string a client sends to a route (input type, before coercion and defaults). */
export type QueryOf<R extends RouteConfig> = R["request"] extends { query: infer Q }
  ? Q extends z.ZodType
    ? z.input<Q>
    : never
  : never;

/** A project. */
export type Project = z.infer<typeof ProjectSchema>;
/** A project with its environments and services. */
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;
/** An environment. */
export type Environment = z.infer<typeof EnvironmentSchema>;
/** A service. */
export type Service = z.infer<typeof ServiceSchema>;
/** One config version of a service. */
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
/** A variable as listed (secrets masked). */
export type Variable = z.infer<typeof VariableSchema>;
/** A deployment. */
export type Deployment = z.infer<typeof DeploymentSchema>;
/** A deployment with events and placements. */
export type DeploymentDetail = z.infer<typeof DeploymentDetailSchema>;
/** A page of log lines. */
export type LogPage = z.infer<typeof LogPageSchema>;
/** A domain. */
export type Domain = z.infer<typeof DomainSchema>;
/** Instance settings. */
export type InstanceSettings = z.infer<typeof InstanceSettingsSchema>;
/** GitHub App status. */
export type GithubStatus = z.infer<typeof GithubStatusSchema>;
/** A project summarised in one environment. */
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
/** An API token as listed (never its secret). */
export type ApiToken = z.infer<typeof ApiTokenSchema>;

export type {
  RealtimeClientMessage,
  RealtimeServerMessage,
} from "./schemas";
