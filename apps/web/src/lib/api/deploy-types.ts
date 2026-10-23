/**
 * Wire types for the Phase 1 deploy pipeline routes, derived from the API's own route
 * definitions (`apps/api/src/contracts.ts`) so the dashboard cannot drift from them.
 *
 * Type-only: nothing from the API source reaches the bundle.
 *
 * @module
 */
import type {
  BodyOf,
  cancelDeployment,
  createDeployment,
  createGithubManifest,
  createProject,
  createService,
  DeploymentDetail,
  getGithubStatus,
  LogPage,
  listDeployments,
  listGithubRepositories,
  putServiceVariables,
  QueryOf,
  RealtimeClientMessage,
  RealtimeServerMessage,
  ResponseOf,
  ServiceConfig,
  updateInstanceSettings,
  updateProject,
  updateService,
} from "../../../../api/src/contracts";

export type {
  Deployment,
  DeploymentDetail,
  Domain,
  Environment,
  GithubStatus,
  InstanceSettings,
  LogPage,
  Project,
  ProjectDetail,
  RealtimeClientMessage,
  RealtimeServerMessage,
  Service,
  ServiceConfig,
  Variable,
} from "../../../../api/src/contracts";

/** `POST /v1/workspaces/{workspaceId}/projects` body. */
export type CreateProjectBody = BodyOf<typeof createProject>;
/** `PATCH /v1/projects/{projectId}` body. */
export type UpdateProjectBody = BodyOf<typeof updateProject>;
/** `POST /v1/projects/{projectId}/services` body. */
export type CreateServiceBody = BodyOf<typeof createService>;
/** `POST /v1/projects/{projectId}/services` response: the service and its first configs. */
export type CreatedService = ResponseOf<typeof createService, 201>;
/** `PATCH /v1/services/{serviceId}` body: metadata and/or a config change. */
export type UpdateServiceBody = BodyOf<typeof updateService>;
/** `PATCH /v1/services/{serviceId}` response. */
export type UpdatedService = ResponseOf<typeof updateService, 200>;
/** `PUT …/variables` body. */
export type VariablesPutBody = BodyOf<typeof putServiceVariables>;
/** `PUT …/variables` response: the list and the classifier warnings. */
export type VariablesPutResult = ResponseOf<typeof putServiceVariables, 200>;
/** `POST /v1/services/{serviceId}/deployments` body. */
export type CreateDeploymentBody = BodyOf<typeof createDeployment>;
/** A page of deployments, newest first. */
export type DeploymentPage = ResponseOf<typeof listDeployments, 200>;
/** `PATCH /v1/instance/settings` body. */
export type InstanceSettingsPatch = BodyOf<typeof updateInstanceSettings>;
/** `POST /v1/github/manifest` body. */
export type GithubManifestBody = BodyOf<typeof createGithubManifest>;
/** What the dashboard needs to start the GitHub App manifest flow. */
export type GithubManifest = ResponseOf<typeof createGithubManifest, 200>;
/** A repository a GitHub App installation can read. */
export type GithubRepository = ResponseOf<
  typeof listGithubRepositories,
  200
>["repositories"][number];
/** A GitHub App installation visible to a workspace. */
export type GithubInstallation = ResponseOf<typeof getGithubStatus, 200>["installations"][number];
/** Query of `GET /v1/github/repositories`. */
export type GithubRepositoriesQuery = QueryOf<typeof listGithubRepositories>;
/** `POST /v1/deployments/{id}/cancel` response. */
export type CancelledDeployment = ResponseOf<typeof cancelDeployment, 200>;

/** One entry of a deployment's timeline. */
export type DeploymentEvent = DeploymentDetail["events"][number];
/** Where one replica runs. */
export type Placement = DeploymentDetail["placements"][number];
/** The build of a git deployment. */
export type Build = NonNullable<DeploymentDetail["build"]>;
/** One stored log line. */
export type LogEntry = LogPage["lines"][number];
/** Where a service's code comes from. */
export type ServiceSource = ServiceConfig["source"];
/** Health probe settings. */
export type HealthcheckConfig = NonNullable<ServiceConfig["healthcheck"]>;
/** A log stream a browser can subscribe to. */
export type RealtimeTopic = RealtimeClientMessage["topic"];
/** Someone looking at a project right now. */
export type PresenceUser = Extract<RealtimeServerMessage, { type: "presence" }>["users"][number];
/** Log lines pushed over the realtime socket. */
export type RealtimeLogLines = Extract<RealtimeServerMessage, { type: "log.lines" }>;
