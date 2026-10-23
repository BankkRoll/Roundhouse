/**
 * Typed endpoint functions for the Phase 1 deploy pipeline: projects (and their
 * summaries), environments, services and their config versions, variables, deployments,
 * logs, domains, instance settings, the GitHub App and API tokens. Every call goes through {@link request}, like `api`.
 *
 * Request and response types come from the API's route contracts (see
 * `./deploy-types`), so a contract change that breaks the dashboard fails typecheck.
 *
 * @module
 */
import { request } from "./client";
import type {
  ApiToken,
  CreateApiTokenBody,
  CreateDeploymentBody,
  CreatedApiToken,
  CreatedService,
  CreateProjectBody,
  CreateServiceBody,
  Deployment,
  DeploymentDetail,
  DeploymentPage,
  Domain,
  Environment,
  GithubManifest,
  GithubManifestBody,
  GithubRepository,
  GithubStatus,
  InstanceSettings,
  InstanceSettingsPatch,
  LogPage,
  Project,
  ProjectDetail,
  ProjectSummary,
  ResolvedVariables,
  Service,
  ServiceConfig,
  UpdatedService,
  UpdateProjectBody,
  UpdateServiceBody,
  Variable,
  VariablesPutBody,
  VariablesPutResult,
} from "./deploy-types";

const seg = encodeURIComponent;

/** Cursor and page size for paged lists. */
export interface PageParams {
  cursor?: string | null;
  limit?: number;
}

/**
 * Phase 1 endpoints, one per route in `PHASE1_ROUTES` that the dashboard calls.
 *
 * @example
 * const { projects } = await deployApi.listProjects("ws_123");
 */
export const deployApi = {
  // ---------------------------------------------------------------------------
  // Projects and environments
  // ---------------------------------------------------------------------------

  /**
   * Lists a workspace's live projects.
   *
   * @param workspaceId - Workspace id.
   * @param signal - Abort signal.
   * @returns The projects envelope.
   */
  listProjects: (workspaceId: string, signal?: AbortSignal) =>
    request<{ projects: Project[] }>("GET", `/v1/workspaces/${seg(workspaceId)}/projects`, {
      signal,
    }),
  /**
   * Finds a live project by its exact slug.
   *
   * @param workspaceId - Workspace id.
   * @param slug - Project slug.
   * @param signal - Abort signal.
   * @returns A list of the one match, or an empty list.
   */
  findProjectBySlug: (workspaceId: string, slug: string, signal?: AbortSignal) =>
    request<{ projects: Project[] }>("GET", `/v1/workspaces/${seg(workspaceId)}/projects`, {
      query: { slug },
      signal,
    }),
  /**
   * Summarises every live project of a workspace in its production environment, by name:
   * each service's latest config version, first domain and newest deployment.
   *
   * @param workspaceId - Workspace id.
   * @param signal - Abort signal.
   * @returns The summaries envelope.
   */
  listProjectSummaries: (workspaceId: string, signal?: AbortSignal) =>
    request<{ projects: ProjectSummary[] }>(
      "GET",
      `/v1/workspaces/${seg(workspaceId)}/projects/summary`,
      { signal },
    ),
  /**
   * Summarises one project in an environment.
   *
   * @param projectId - Project id.
   * @param environmentId - Environment to summarise; production when omitted.
   * @param signal - Abort signal.
   * @returns The project with every service's state in that environment.
   */
  getProjectSummary: (projectId: string, environmentId?: string, signal?: AbortSignal) =>
    request<ProjectSummary>("GET", `/v1/projects/${seg(projectId)}/summary`, {
      query: { environment_id: environmentId },
      signal,
    }),
  /**
   * Creates a project with a `production` environment. A taken slug is suffixed (-2, -3, …).
   *
   * @param workspaceId - Workspace id.
   * @param body - Name and optional slug and description.
   * @returns The project with its environments and (no) services.
   */
  createProject: (workspaceId: string, body: CreateProjectBody) =>
    request<ProjectDetail>("POST", `/v1/workspaces/${seg(workspaceId)}/projects`, { body }),
  /**
   * Reads a project with its environments and services.
   *
   * @param projectId - Project id.
   * @param signal - Abort signal.
   * @returns The project detail.
   */
  getProject: (projectId: string, signal?: AbortSignal) =>
    request<ProjectDetail>("GET", `/v1/projects/${seg(projectId)}`, { signal }),
  /**
   * Renames or re-describes a project.
   *
   * @param projectId - Project id.
   * @param body - Fields to change.
   * @returns The updated project.
   */
  updateProject: (projectId: string, body: UpdateProjectBody) =>
    request<Project>("PATCH", `/v1/projects/${seg(projectId)}`, { body }),
  /**
   * Deletes a project and removes its workloads from every node.
   *
   * @param projectId - Project id.
   * @returns Resolves on 204.
   */
  deleteProject: (projectId: string) => request<void>("DELETE", `/v1/projects/${seg(projectId)}`),
  /**
   * Lists a project's environments, production first.
   *
   * @param projectId - Project id.
   * @param signal - Abort signal.
   * @returns The environments envelope.
   */
  listEnvironments: (projectId: string, signal?: AbortSignal) =>
    request<{ environments: Environment[] }>("GET", `/v1/projects/${seg(projectId)}/environments`, {
      signal,
    }),

  // ---------------------------------------------------------------------------
  // Services and config versions
  // ---------------------------------------------------------------------------

  /**
   * Creates a service and its first config version in every environment. Does not deploy.
   *
   * @param projectId - Project id.
   * @param body - Name, source and config overrides.
   * @returns The service and its configs.
   */
  createService: (projectId: string, body: CreateServiceBody) =>
    request<CreatedService>("POST", `/v1/projects/${seg(projectId)}/services`, { body }),
  /**
   * Reads a service's metadata.
   *
   * @param serviceId - Service id.
   * @param signal - Abort signal.
   * @returns The service.
   */
  getService: (serviceId: string, signal?: AbortSignal) =>
    request<Service>("GET", `/v1/services/${seg(serviceId)}`, { signal }),
  /**
   * Changes metadata and/or writes a new config version for one environment.
   *
   * @param serviceId - Service id.
   * @param body - Metadata and config parts; config parts need `environment_id`.
   * @returns The service and the new config version, if one was made.
   */
  updateService: (serviceId: string, body: UpdateServiceBody) =>
    request<UpdatedService>("PATCH", `/v1/services/${seg(serviceId)}`, { body }),
  /**
   * Deletes a service and removes its workloads.
   *
   * @param serviceId - Service id.
   * @returns Resolves on 204.
   */
  deleteService: (serviceId: string) => request<void>("DELETE", `/v1/services/${seg(serviceId)}`),
  /**
   * Reads the latest (or a given) config version of a service in an environment.
   *
   * @param serviceId - Service id.
   * @param environmentId - Environment id.
   * @param version - A specific version; the latest when omitted.
   * @param signal - Abort signal.
   * @returns The config version.
   */
  getServiceConfig: (
    serviceId: string,
    environmentId: string,
    version?: number,
    signal?: AbortSignal,
  ) =>
    request<ServiceConfig>("GET", `/v1/services/${seg(serviceId)}/config`, {
      query: { environment_id: environmentId, version },
      signal,
    }),

  // ---------------------------------------------------------------------------
  // Variables
  // ---------------------------------------------------------------------------

  /**
   * Lists a service's variables in an environment, secrets masked.
   *
   * @param serviceId - Service id.
   * @param environmentId - Environment id.
   * @param signal - Abort signal.
   * @returns The variables envelope.
   */
  listServiceVariables: (serviceId: string, environmentId: string, signal?: AbortSignal) =>
    request<{ variables: Variable[] }>("GET", `/v1/services/${seg(serviceId)}/variables`, {
      query: { environment_id: environmentId },
      signal,
    }),
  /**
   * Sets and deletes a service's variables in one transaction.
   *
   * @param serviceId - Service id.
   * @param environmentId - Environment id.
   * @param body - Variables to set and keys to delete.
   * @returns The full masked list afterwards.
   */
  putServiceVariables: (serviceId: string, environmentId: string, body: VariablesPutBody) =>
    request<VariablesPutResult>("PUT", `/v1/services/${seg(serviceId)}/variables`, {
      query: { environment_id: environmentId },
      body,
    }),
  /**
   * Resolves a service's plain environment as a deployment would get it (built-ins
   * included). Secret values never leave the API: every secret, and every plain variable
   * whose resolution reaches one, is listed in `local_keys` instead. Needs
   * `variables:read_plain`; the API audits every call with the key names.
   *
   * @param serviceId - Service id.
   * @param environmentId - Environment id.
   * @param signal - Abort signal.
   * @returns Resolved plain values and the keys that must be supplied locally.
   */
  resolveServiceVariables: (serviceId: string, environmentId: string, signal?: AbortSignal) =>
    request<ResolvedVariables>("GET", `/v1/services/${seg(serviceId)}/variables/resolved`, {
      query: { environment_id: environmentId },
      signal,
    }),
  /**
   * Lists a project environment's shared variables, secrets masked.
   *
   * @param projectId - Project id.
   * @param environmentId - Environment id.
   * @param signal - Abort signal.
   * @returns The variables envelope.
   */
  listSharedVariables: (projectId: string, environmentId: string, signal?: AbortSignal) =>
    request<{ variables: Variable[] }>("GET", `/v1/projects/${seg(projectId)}/variables`, {
      query: { environment_id: environmentId },
      signal,
    }),

  // ---------------------------------------------------------------------------
  // Deployments, builds and logs
  // ---------------------------------------------------------------------------

  /**
   * Lists a service's deployments in an environment, newest first.
   *
   * @param serviceId - Service id.
   * @param environmentId - Environment id.
   * @param page - Cursor and page size.
   * @param signal - Abort signal.
   * @returns A page of deployments.
   */
  listDeployments: (
    serviceId: string,
    environmentId: string,
    page: PageParams = {},
    signal?: AbortSignal,
  ) =>
    request<DeploymentPage>("GET", `/v1/services/${seg(serviceId)}/deployments`, {
      query: { environment_id: environmentId, cursor: page.cursor, limit: page.limit },
      signal,
    }),
  /**
   * Deploys the latest config version.
   *
   * @param serviceId - Service id.
   * @param environmentId - Environment id.
   * @param body - Optional commit to build (git sources).
   * @returns The new deployment.
   */
  createDeployment: (serviceId: string, environmentId: string, body: CreateDeploymentBody = {}) =>
    request<Deployment>("POST", `/v1/services/${seg(serviceId)}/deployments`, {
      query: { environment_id: environmentId },
      body,
    }),
  /**
   * Reads a deployment with its events and placements.
   *
   * @param deploymentId - Deployment id.
   * @param signal - Abort signal.
   * @returns The deployment detail.
   */
  getDeployment: (deploymentId: string, signal?: AbortSignal) =>
    request<DeploymentDetail>("GET", `/v1/deployments/${seg(deploymentId)}`, { signal }),
  /**
   * Creates a deployment from an earlier one's image and config, skipping the build.
   *
   * @param deploymentId - The deployment to roll back to.
   * @returns The new deployment.
   */
  rollbackDeployment: (deploymentId: string) =>
    request<Deployment>("POST", `/v1/deployments/${seg(deploymentId)}/rollback`),
  /**
   * Cancels a queued, building or deploying deployment.
   *
   * @param deploymentId - Deployment id.
   * @returns The cancelled deployment.
   */
  cancelDeployment: (deploymentId: string) =>
    request<Deployment>("POST", `/v1/deployments/${seg(deploymentId)}/cancel`),
  /**
   * Reads one page of a deployment's runtime logs, newest page first.
   *
   * @param deploymentId - Deployment id.
   * @param page - Cursor from the previous page and page size (1-1000).
   * @param signal - Abort signal.
   * @returns Lines in chronological order and the cursor to older ones.
   */
  getDeploymentLogs: (deploymentId: string, page: PageParams = {}, signal?: AbortSignal) =>
    request<LogPage>("GET", `/v1/deployments/${seg(deploymentId)}/logs`, {
      query: { cursor: page.cursor, limit: page.limit },
      signal,
    }),
  /**
   * Reads one page of a build's logs, newest page first.
   *
   * @param buildId - Build id.
   * @param page - Cursor from the previous page and page size (1-1000).
   * @param signal - Abort signal.
   * @returns Lines in chronological order and the cursor to older ones.
   */
  getBuildLogs: (buildId: string, page: PageParams = {}, signal?: AbortSignal) =>
    request<LogPage>("GET", `/v1/builds/${seg(buildId)}/logs`, {
      query: { cursor: page.cursor, limit: page.limit },
      signal,
    }),

  // ---------------------------------------------------------------------------
  // Domains
  // ---------------------------------------------------------------------------

  /**
   * Lists a service's domains in an environment.
   *
   * @param serviceId - Service id.
   * @param environmentId - Environment id.
   * @param signal - Abort signal.
   * @returns The domains envelope.
   */
  listDomains: (serviceId: string, environmentId: string, signal?: AbortSignal) =>
    request<{ domains: Domain[] }>("GET", `/v1/services/${seg(serviceId)}/domains`, {
      query: { environment_id: environmentId },
      signal,
    }),

  // ---------------------------------------------------------------------------
  // Instance settings and GitHub
  // ---------------------------------------------------------------------------

  /**
   * Reads install-wide settings (ingress, log retention). Owners only.
   *
   * @param signal - Abort signal.
   * @returns The settings.
   */
  getInstanceSettings: (signal?: AbortSignal) =>
    request<InstanceSettings>("GET", "/v1/instance/settings", { signal }),
  /**
   * Changes install-wide settings. The API records the change in every workspace the
   * caller owns.
   *
   * @param body - Apps domain, TLS mode and/or log retention in days.
   * @returns The settings afterwards.
   */
  updateInstanceSettings: (body: InstanceSettingsPatch) =>
    request<InstanceSettings>("PATCH", "/v1/instance/settings", { body }),
  /**
   * Reads whether a GitHub App exists and where it is installed.
   *
   * @param workspaceId - Workspace whose installations to list.
   * @param signal - Abort signal.
   * @returns The App status.
   */
  getGithubStatus: (workspaceId: string, signal?: AbortSignal) =>
    request<GithubStatus>("GET", "/v1/github/status", {
      query: { workspace_id: workspaceId },
      signal,
    }),
  /**
   * Starts the GitHub App manifest flow. 409 when an App already exists.
   *
   * @param body - Owning workspace and optional organization.
   * @returns The manifest, single-use state and the GitHub URL to post them to.
   */
  createGithubManifest: (body: GithubManifestBody) =>
    request<GithubManifest>("POST", "/v1/github/manifest", { body }),
  /**
   * Lists repositories the workspace's installations can read.
   *
   * @param workspaceId - Workspace id.
   * @param installationId - Limit to one installation (`ghi_…`).
   * @param signal - Abort signal.
   * @returns The repositories envelope.
   */
  listGithubRepositories: (workspaceId: string, installationId?: string, signal?: AbortSignal) =>
    request<{ repositories: GithubRepository[] }>("GET", "/v1/github/repositories", {
      query: { workspace_id: workspaceId, installation_id: installationId },
      signal,
    }),

  // ---------------------------------------------------------------------------
  // API tokens
  // ---------------------------------------------------------------------------

  /**
   * Lists a workspace's API tokens, newest first, revoked and expired ones included.
   *
   * @param workspaceId - Workspace id.
   * @param signal - Abort signal.
   * @returns The tokens envelope; never any secret.
   */
  listApiTokens: (workspaceId: string, signal?: AbortSignal) =>
    request<{ tokens: ApiToken[] }>("GET", `/v1/workspaces/${seg(workspaceId)}/tokens`, {
      signal,
    }),
  /**
   * Creates an API token. Every scope must be granted by the caller's role (else 403).
   *
   * @param workspaceId - Workspace id.
   * @param body - Name, scopes and lifetime in days (`null` never expires).
   * @returns The token and its secret, which is never shown again.
   */
  createApiToken: (workspaceId: string, body: CreateApiTokenBody) =>
    request<CreatedApiToken>("POST", `/v1/workspaces/${seg(workspaceId)}/tokens`, { body }),
  /**
   * Revokes a token at once. Revoking a revoked token is a no-op.
   *
   * @param workspaceId - Workspace id.
   * @param tokenId - Token id.
   * @returns Resolves on 204.
   */
  revokeApiToken: (workspaceId: string, tokenId: string) =>
    request<void>("DELETE", `/v1/workspaces/${seg(workspaceId)}/tokens/${seg(tokenId)}`),
};
