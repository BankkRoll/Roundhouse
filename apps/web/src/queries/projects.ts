import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { deployApi } from "../lib/api/deploy-client";
import type {
  CreateProjectBody,
  Deployment,
  Environment,
  Project,
  ProjectDetail,
  ProjectSummary,
  Service,
  UpdateProjectBody,
} from "../lib/api/deploy-types";
import { queryKeys } from "./keys";

/** How often project summaries (sidebar dots, home cards) refresh without a socket. */
export const PROJECT_SUMMARY_POLL_MS = 30_000;

/**
 * Query options for a workspace's projects.
 *
 * @param workspaceId - Workspace id.
 * @returns Options for `useQuery`.
 */
export function projectsQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: queryKeys.projects(workspaceId),
    queryFn: ({ signal }) => deployApi.listProjects(workspaceId, signal),
    select: (data) => data.projects,
  });
}

/**
 * Reads a workspace's projects, sorted by name.
 *
 * @param workspaceId - Workspace id.
 * @param enabled - Skip when the caller cannot read projects.
 * @returns The projects query.
 */
export function useProjects(workspaceId: string, enabled = true) {
  return useQuery({
    ...projectsQueryOptions(workspaceId),
    select: (data) => [...data.projects].sort((a, b) => a.name.localeCompare(b.name)),
    enabled,
  });
}

/**
 * Query options for one project with its environments and services.
 *
 * @param projectId - Project id.
 * @returns Options for `useQuery`.
 */
export function projectQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: queryKeys.project(projectId),
    queryFn: ({ signal }) => deployApi.getProject(projectId, signal),
  });
}

/**
 * Reads one project with its environments and services.
 *
 * @param projectId - Project id.
 * @returns The project query.
 */
export function useProject(projectId: string) {
  return useQuery(projectQueryOptions(projectId));
}

/**
 * Picks the environment to show: the one with `slug`, else production, else the first.
 *
 * @param environments - A project's environments.
 * @param slug - Slug from the URL, if any.
 * @returns The environment, or `undefined` when the project has none.
 */
export function pickEnvironment(
  environments: readonly Environment[],
  slug?: string,
): Environment | undefined {
  return (
    (slug ? environments.find((environment) => environment.slug === slug) : undefined) ??
    environments.find((environment) => environment.kind === "production") ??
    environments[0]
  );
}

/**
 * Query options for a service's newest deployment in an environment.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id.
 * @returns Options whose data is the newest deployment, or `null` before the first deploy.
 */
export function latestDeploymentQueryOptions(serviceId: string, environmentId: string) {
  return queryOptions({
    queryKey: queryKeys.latestDeployment(serviceId, environmentId),
    queryFn: async ({ signal }) => {
      const page = await deployApi.listDeployments(serviceId, environmentId, { limit: 1 }, signal);
      return page.deployments[0] ?? null;
    },
    refetchInterval: PROJECT_SUMMARY_POLL_MS,
    // PERF: One request per service; they already poll and get realtime updates, so a
    // burst on every window focus would add load without fresher data.
    refetchOnWindowFocus: false,
  });
}

/** Overall state of a project, from its services' newest deployments. */
export type ProjectHealth = "deploying" | "failing" | "healthy" | "idle" | "unknown";

/**
 * Derives a project's health from its services' newest deployments.
 *
 * @param latest - Newest deployment per service; `undefined` while loading.
 * @returns `deploying` when anything is in flight, `failing` when any newest deployment
 *   failed or crashed, `healthy` when all are active, `idle` when nothing is deployed.
 */
export function projectHealth(latest: readonly (Deployment | null | undefined)[]): ProjectHealth {
  if (latest.some((deployment) => deployment === undefined)) return "unknown";
  const statuses = latest.flatMap((deployment) => (deployment ? [deployment.status] : []));
  if (statuses.some((s) => s === "queued" || s === "building" || s === "deploying")) {
    return "deploying";
  }
  if (statuses.some((s) => s === "failed" || s === "crashed")) return "failing";
  if (statuses.length > 0 && statuses.every((s) => s === "active")) return "healthy";
  return "idle";
}

/** What cards, sidebar dots and stat cards draw for one project summary. */
export interface ProjectOverview {
  health: ProjectHealth;
  /** Newest deployment across all services, or `null` before the first. */
  lastDeploy: Deployment | null;
  /** The service of {@link ProjectOverview.lastDeploy}. */
  lastDeployService: Service | undefined;
  /** Services whose newest deployment failed or crashed. */
  failing: Service[];
}

/**
 * Derives health, the last deploy and failing services from a project summary.
 *
 * @param summary - A project summarised in one environment.
 * @returns The overview.
 * @example
 * const { health, lastDeploy } = describeProjectSummary(summary);
 */
export function describeProjectSummary(summary: ProjectSummary): ProjectOverview {
  const latest = summary.services.map((entry) => entry.latest_deployment);
  let lastDeploy: Deployment | null = null;
  let lastDeployService: Service | undefined;
  for (const entry of summary.services) {
    const deployment = entry.latest_deployment;
    if (deployment && (!lastDeploy || deployment.created_at > lastDeploy.created_at)) {
      lastDeploy = deployment;
      lastDeployService = entry.service;
    }
  }
  return {
    health: projectHealth(latest),
    lastDeploy,
    lastDeployService,
    failing: summary.services
      .filter(({ latest_deployment: d }) => d?.status === "failed" || d?.status === "crashed")
      .map((entry) => entry.service),
  };
}

/**
 * Query options for every project of a workspace, each summarised in production. One
 * request feeds the sidebar, the home cards and the stat row.
 *
 * @param workspaceId - Workspace id.
 * @returns Options whose data is the summaries, by name.
 */
export function projectSummariesQueryOptions(workspaceId: string) {
  return queryOptions({
    queryKey: queryKeys.projectSummaries(workspaceId),
    queryFn: ({ signal }) => deployApi.listProjectSummaries(workspaceId, signal),
    select: (data) => data.projects,
    refetchInterval: PROJECT_SUMMARY_POLL_MS,
    staleTime: 15_000,
  });
}

/**
 * Reads every project of a workspace summarised in production.
 *
 * @param workspaceId - Workspace id.
 * @param enabled - Skip when the caller cannot read projects.
 * @returns The summaries query, ordered by name.
 */
export function useProjectSummaries(workspaceId: string, enabled = true) {
  return useQuery({ ...projectSummariesQueryOptions(workspaceId), enabled });
}

/**
 * Query options for one project summarised in an environment.
 *
 * @param projectId - Project id.
 * @param environmentId - Environment to summarise.
 * @returns Options for `useQuery`.
 */
export function projectSummaryQueryOptions(projectId: string, environmentId: string) {
  return queryOptions({
    queryKey: queryKeys.projectSummary(projectId, environmentId),
    queryFn: ({ signal }) => deployApi.getProjectSummary(projectId, environmentId, signal),
    refetchInterval: PROJECT_SUMMARY_POLL_MS,
    staleTime: 15_000,
  });
}

/**
 * Reads one project summarised in an environment: every service's latest config version,
 * source, first domain and newest deployment, in a single request.
 *
 * @param projectId - Project id.
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @returns The summary query.
 */
export function useProjectSummary(projectId: string, environmentId: string | undefined) {
  return useQuery({
    ...projectSummaryQueryOptions(projectId, environmentId ?? ""),
    enabled: Boolean(environmentId),
  });
}

function isSummaryListKey(key: readonly unknown[]): boolean {
  return key[0] === "workspaces" && key[2] === "projects" && key[3] === "summary";
}

/**
 * Writes a deployment into every cached project summary that shows its service in its
 * environment, unless the cached copy is newer. A deployment of a service no summary
 * knows yet (one created moments ago) makes those summaries refetch instead.
 *
 * @param queryClient - Shared query client.
 * @param deployment - The deployment as the API last reported it.
 * @param options - `force` writes even over newer copies (undoing an optimistic update).
 */
export function patchSummaryDeployment(
  queryClient: QueryClient,
  deployment: Deployment,
  options: { force?: boolean } = {},
): void {
  let unknownService = false;
  const patch = (summary: ProjectSummary): ProjectSummary => {
    if (summary.id !== deployment.project_id) return summary;
    if (summary.environment?.id !== deployment.environment_id) return summary;
    const index = summary.services.findIndex((entry) => entry.service.id === deployment.service_id);
    const entry = summary.services[index];
    if (!entry) {
      unknownService = true;
      return summary;
    }
    const current = entry.latest_deployment;
    const replace =
      !current ||
      (current.id === deployment.id
        ? options.force || current.updated_at <= deployment.updated_at
        : deployment.created_at >= current.created_at);
    if (!replace) return summary;
    const services = [...summary.services];
    services[index] = { ...entry, latest_deployment: deployment };
    return { ...summary, services };
  };
  queryClient.setQueriesData<ProjectSummary>(
    { queryKey: queryKeys.projectSummaryAll(deployment.project_id) },
    (data) => (data ? patch(data) : data),
  );
  queryClient.setQueriesData<{ projects: ProjectSummary[] }>(
    { predicate: (query) => isSummaryListKey(query.queryKey) },
    (data) => (data ? { projects: data.projects.map(patch) } : data),
  );
  if (unknownService) invalidateProjectSummaries(queryClient, deployment.project_id);
}

/**
 * Marks a project's summaries, and every cached workspace summary list, stale so open
 * views refetch them. Used when services are added, changed or removed.
 *
 * @param queryClient - Shared query client.
 * @param projectId - The project that changed.
 */
export function invalidateProjectSummaries(queryClient: QueryClient, projectId: string): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.projectSummaryAll(projectId) });
  void queryClient.invalidateQueries({ predicate: (query) => isSummaryListKey(query.queryKey) });
}

/**
 * Creates a project and adds it to the cached list.
 *
 * @param workspaceId - Workspace id.
 * @returns A mutation taking the project name and description.
 */
export function useCreateProject(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectBody) => deployApi.createProject(workspaceId, body),
    onSuccess: (project) => {
      queryClient.setQueryData(queryKeys.project(project.id), project);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects(workspaceId),
        exact: true,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectSummaries(workspaceId) });
    },
  });
}

function patchProjectList(
  queryClient: QueryClient,
  workspaceId: string,
  update: <T extends Project>(projects: T[]) => T[],
) {
  queryClient.setQueryData<{ projects: Project[] }>(queryKeys.projects(workspaceId), (data) =>
    data ? { projects: update(data.projects) } : data,
  );
  queryClient.setQueryData<{ projects: ProjectSummary[] }>(
    queryKeys.projectSummaries(workspaceId),
    (data) => (data ? { projects: update(data.projects) } : data),
  );
}

/**
 * Renames or re-describes a project, updating cached copies in place.
 *
 * @param workspaceId - Owning workspace.
 * @param projectId - Project id.
 * @returns A mutation taking the fields to change.
 */
export function useUpdateProject(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProjectBody) => deployApi.updateProject(projectId, body),
    onSuccess: (project) => {
      queryClient.setQueryData<ProjectDetail>(queryKeys.project(projectId), (detail) =>
        detail ? { ...detail, ...project } : detail,
      );
      patchProjectList(queryClient, workspaceId, (projects) =>
        projects.map((entry) => (entry.id === project.id ? { ...entry, ...project } : entry)),
      );
      queryClient.setQueriesData<ProjectSummary>(
        { queryKey: queryKeys.projectSummaryAll(projectId) },
        (summary) => (summary ? { ...summary, ...project } : summary),
      );
    },
  });
}

/**
 * Deletes a project. The caller navigates away first, then calls {@link forgetProject}.
 *
 * @param workspaceId - Owning workspace.
 * @returns A mutation taking the project id.
 */
export function useDeleteProject(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => deployApi.deleteProject(projectId),
    onSuccess: (_, projectId) =>
      patchProjectList(queryClient, workspaceId, (projects) =>
        projects.filter((entry) => entry.id !== projectId),
      ),
  });
}

/**
 * Drops a deleted project's cached detail.
 *
 * @param queryClient - Shared query client.
 * @param projectId - The deleted project.
 */
export function forgetProject(queryClient: QueryClient, projectId: string): void {
  queryClient.removeQueries({ queryKey: queryKeys.project(projectId) });
}
