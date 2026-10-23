/**
 * API contract: every route of the deploy pipeline (Phase 1) and of the
 * security hardening (ADR 0014) as a `createRoute` definition (path, method,
 * params, body, responses, errors, security), plus the action, audit actions
 * and freshness requirement each one implies. No handlers live here.
 *
 * Register a handler with `router.openapi(route, handler)`, read the policy
 * with {@link policyOf}, and check it once the owning workspace (and project
 * and environment, for project actions) is known. Routes under a project,
 * service, deployment or build resolve that workspace from the row; callers
 * who can't see the project get 404, like workspace routes.
 *
 * Files per stream, re-exported here so imports don't change:
 * - `./contracts/policy`: `defineRoute`, `RoutePolicy`, `policyOf`;
 * - `./contracts/params`: shared path params and queries;
 * - `./contracts/variables`, `./contracts/keys` (api-secrets-crypto);
 * - `./contracts/access`, `./contracts/instance` (api-authz-rbac-github);
 * - `./contracts/auth` (api-auth).
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
import { type RouteConfig, z } from "@hono/zod-openapi";
import { SERVICE_KINDS } from "@roundhouse/shared";
import { ACCESS_ROUTES } from "./contracts/access";
import { AUTH_ROUTES } from "./contracts/auth";
import { INSTANCE_ROUTES } from "./contracts/instance";
import { KEY_ROUTES } from "./contracts/keys";
import {
  BuildParams,
  DeploymentParams,
  EnvironmentQuery,
  LogQuery,
  ProjectParams,
  ServiceParams,
} from "./contracts/params";
import { defineRoute, session } from "./contracts/policy";
import { VARIABLE_ROUTES, VARIABLE_SECURITY_ROUTES } from "./contracts/variables";
import {
  body,
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
  SERVICE_CONFIG_PARTS,
  ServiceConfigPatchSchema,
  ServiceConfigSchema,
  ServiceSchema,
  ServiceSlugField,
  ServiceSourceSchema,
  SlugField,
  sessionAuth,
  type VariableSchema,
  WorkspaceParams,
} from "./schemas";

export * from "./contracts/access";
export * from "./contracts/auth";
export * from "./contracts/instance";
export * from "./contracts/keys";
export * from "./contracts/params";
export * from "./contracts/policy";
export * from "./contracts/variables";

// -----------------------------------------------------------------------------
// Projects
// -----------------------------------------------------------------------------

/** Body of `POST /v1/workspaces/{workspaceId}/projects`. */
export const CreateProjectBody = z
  .object({
    name: NameField,
    /** Derived from `name` when omitted. */
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

/** Lists the live projects of a workspace. */
export const listProjects = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/workspaces/{workspaceId}/projects",
  tags: ["projects"],
  summary: "List projects",
  security: sessionAuth,
  request: { params: WorkspaceParams },
  responses: {
    200: json(z.object({ projects: z.array(ProjectSchema) })),
    ...errors(401, 403, 404),
  },
});

/** Creates a project with a `production` environment. 409 when the slug is taken. */
export const createProject = defineRoute(session("projects:create", ["project.created"]), {
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

// -----------------------------------------------------------------------------
// Environments
// -----------------------------------------------------------------------------

/** Body of `POST /v1/projects/{projectId}/environments`. */
export const CreateEnvironmentBody = z
  .object({
    name: NameField,
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
    /** Derived from `name` when omitted. Also the `${{slug.VAR}}` reference namespace. */
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
 * skipping the build. 409 unless this deployment's status is in
 * `ROLLBACK_SOURCE_STATUSES`.
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

/** Install-wide ingress settings. Instance admins only. */
export const getInstanceSettings = defineRoute(session("instance:manage"), {
  method: "get",
  path: "/v1/instance/settings",
  tags: ["instance"],
  summary: "Get instance settings",
  security: sessionAuth,
  responses: { 200: json(InstanceSettingsSchema), ...errors(401, 403) },
});

/**
 * Changes ingress settings and pushes new desired state to every node.
 * Existing generated domains keep their hostnames when `apps_domain` changes;
 * new ones use the new domain.
 */
export const updateInstanceSettings = defineRoute(
  session("instance:manage", ["instance.settings_updated"], { reauth: true }),
  {
    method: "patch",
    path: "/v1/instance/settings",
    tags: ["instance"],
    summary: "Update instance settings",
    security: sessionAuth,
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
 * Query of `GET /v1/github/callback`. GitHub sends `code` after the App is
 * created (manifest flow) and `installation_id` + `setup_action` after it is
 * installed; `state` is ours in both.
 */
export const GithubCallbackQuery = z.object({
  state: z.string().min(1).max(200),
  code: z.string().min(1).max(200).optional(),
  installation_id: z.coerce.number().int().positive().optional(),
  setup_action: z.enum(["install", "update", "request"]).optional(),
});

/** Whether a GitHub App exists and which installations the workspace has claimed. */
export const getGithubStatus = defineRoute(session("workspace:read"), {
  method: "get",
  path: "/v1/github/status",
  tags: ["github"],
  summary: "GitHub App status",
  security: sessionAuth,
  request: { query: GithubWorkspaceQuery },
  responses: { 200: json(GithubStatusSchema), ...errors(400, 401, 403, 404) },
});

/**
 * Starts creating the instance's GitHub App. 409 when one already exists.
 * The manifest sets `request_oauth_on_install`, so installing the App also
 * returns a user-to-server `code` that proves who installed it.
 */
export const createGithubManifest = defineRoute(session("instance:manage", [], { reauth: true }), {
  method: "post",
  path: "/v1/github/manifest",
  tags: ["github"],
  summary: "Start creating the GitHub App",
  security: sessionAuth,
  request: body(GithubManifestBody),
  responses: { 200: json(GithubManifestSchema), ...errors(400, 401, 403, 409) },
});

/**
 * GitHub redirects the browser here. For the manifest flow (`code`, state
 * purpose `github-manifest`), exchanges it for the App's credentials and
 * stores them sealed (needs `instance:manage`). For an installation
 * (`installation_id` + `code`, state purpose `github-claim`), consumes the
 * single-use claim, exchanges `code` for a user token, and claims the
 * installation for the claim's workspace only when that GitHub user
 * administers the installation's account (the account itself, or an org
 * admin); otherwise records `github.installation_rejected`. Needs
 * `github:manage` in the claim's workspace, and the signed-in user must be
 * the one who started the claim. Redirects to the dashboard.
 */
export const githubCallback = defineRoute(
  session("github:manage", [
    "github.app_created",
    "github.installation_added",
    "github.installation_rejected",
  ]),
  {
    method: "get",
    path: "/v1/github/callback",
    tags: ["github"],
    summary: "GitHub App setup callback",
    security: sessionAuth,
    request: { query: GithubCallbackQuery },
    responses: {
      302: { description: "Redirect to the dashboard" },
      ...errors(400, 401, 403),
    },
  },
);

/**
 * Repositories the workspace's installations can read, for picking a service
 * source. With `project_id`, needs `services:manage` on that project;
 * without, `github:manage`.
 */
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
      /** Project the repository is for; decides which access check applies. */
      project_id: z.string().optional(),
    }),
  },
  responses: {
    200: json(z.object({ repositories: z.array(GithubRepositorySchema) })),
    ...errors(400, 401, 403, 404),
  },
});

/** Body of `POST /v1/github/claims`. */
export const StartGithubClaimBody = z
  .object({ workspace_id: z.string() })
  .openapi("StartGithubClaim");

/**
 * Starts claiming an installation for a workspace: creates a single-use
 * `github_claim_states` row (10 minutes) and returns the App's install URL
 * with a signed `state` (purpose `github-claim`) naming it. 409 without an App.
 */
export const startGithubClaim = defineRoute(session("github:manage"), {
  method: "post",
  path: "/v1/github/claims",
  tags: ["github"],
  summary: "Start installing the GitHub App for a workspace",
  security: sessionAuth,
  request: body(StartGithubClaimBody),
  responses: {
    200: json(z.object({ install_url: z.string() }).openapi("GithubClaimStarted")),
    ...errors(400, 401, 403, 404, 409),
  },
});

/**
 * Releases an installation from the workspace. Services that use it keep
 * their config but can't mint tokens until it's claimed again.
 */
export const releaseGithubInstallation = defineRoute(
  session("github:manage", ["github.installation_released"], { reauth: true }),
  {
    method: "delete",
    path: "/v1/github/installations/{installationId}",
    tags: ["github"],
    summary: "Release a GitHub installation",
    security: sessionAuth,
    request: { params: z.object({ installationId: z.string() }), query: GithubWorkspaceQuery },
    responses: { 204: { description: "Released" }, ...errors(401, 403, 404) },
  },
);

/** Headers GitHub sends with every webhook delivery. */
export const GithubWebhookHeaders = z.object({
  "x-github-event": z.string(),
  "x-github-delivery": z.string(),
  "x-hub-signature-256": z.string().regex(/^sha256=[a-f0-9]{64}$/),
});

/**
 * Receives GitHub webhooks. The body is deliberately not declared: the
 * handler must verify `X-Hub-Signature-256` over the raw bytes, in constant
 * time, before parsing anything, then dedupe on both `X-GitHub-Delivery` and
 * the SHA-256 of the body (`github_deliveries.body_hash`), since the
 * delivery header isn't covered by the signature. Handles `installation` (records it) and
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

/**
 * Upgrades to a WebSocket held by the project's `ProjectRoom` Durable Object.
 * Messages are documented as `RealtimeServerMessageSchema` (server → browser)
 * and `RealtimeClientMessageSchema` (browser → server), JSON text frames.
 */
export const projectRealtime = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/projects/{projectId}/realtime",
  tags: ["realtime"],
  summary: "Project realtime socket",
  security: sessionAuth,
  request: { params: ProjectParams },
  responses: {
    101: { description: "Switching Protocols" },
    ...errors(401, 403, 404, 426),
  },
});

// -----------------------------------------------------------------------------
// Index and derived types
// -----------------------------------------------------------------------------

/**
 * Every Phase 1 route, by name, as the API serves it. The reveal routes are
 * gone (ADR 0014): secret values are write-only.
 */
export const PHASE1_ROUTES = {
  listProjects,
  createProject,
  getProject,
  updateProject,
  deleteProject,
  listEnvironments,
  createEnvironment,
  listServices,
  createService,
  getService,
  updateService,
  deleteService,
  getServiceConfig,
  ...VARIABLE_ROUTES,
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
} as const;

/**
 * ADR 0014 routes, by name. Each security stream registers handlers for its
 * own and then moves them into the served set checked by
 * `test/contracts.test.ts`.
 */
export const SECURITY_ROUTES = {
  ...ACCESS_ROUTES,
  ...AUTH_ROUTES,
  ...INSTANCE_ROUTES,
  ...KEY_ROUTES,
  ...VARIABLE_SECURITY_ROUTES,
  startGithubClaim,
  releaseGithubInstallation,
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
/** A variable as listed: metadata always, plain values only when readable, secrets never. */
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

export type {
  RealtimeClientMessage,
  RealtimeServerMessage,
} from "./schemas";
