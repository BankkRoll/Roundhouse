import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQueries,
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

/** A project's services and their newest deployments, for cards and sidebar dots. */
export interface ProjectSummary {
  project: ProjectDetail | undefined;
  production: Environment | undefined;
  /** Newest deployment per service id; `null` when the service was never deployed. */
  latest: Record<string, Deployment | null>;
  health: ProjectHealth;
  /** Newest deployment across all services. */
  lastDeploy: Deployment | null;
  /** Services whose newest deployment failed or crashed. */
  failing: number;
  isPending: boolean;
  isError: boolean;
}

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

/**
 * Summarises a project from real data: its detail, then the newest deployment of each
 * service in production. Requests are shared with every other component asking for the
 * same project, so the sidebar and home cards cost one set of requests.
 *
 * @param projectId - Project id.
 * @returns Detail, newest deployments, health and the last deploy.
 */
export function useProjectSummary(projectId: string): ProjectSummary {
  const project = useQuery({ ...projectQueryOptions(projectId), staleTime: 30_000 });
  const production = project.data ? pickEnvironment(project.data.environments) : undefined;
  const services = project.data?.services ?? [];
  const latestQueries = useQueries({
    queries: services.map((service) => ({
      ...latestDeploymentQueryOptions(service.id, production?.id ?? ""),
      enabled: Boolean(production),
      staleTime: 15_000,
    })),
  });
  const latest: Record<string, Deployment | null> = {};
  services.forEach((service, index) => {
    const data = latestQueries[index]?.data;
    if (data !== undefined) latest[service.id] = data;
  });
  const deployments = services.map((service) => latest[service.id]);
  const lastDeploy = deployments.reduce<Deployment | null>(
    (newest, deployment) =>
      deployment && (!newest || deployment.created_at > newest.created_at) ? deployment : newest,
    null,
  );
  return {
    project: project.data,
    production,
    latest,
    health: project.data ? projectHealth(deployments) : "unknown",
    lastDeploy,
    failing: deployments.filter((d) => d?.status === "failed" || d?.status === "crashed").length,
    isPending: project.isPending,
    isError: project.isError,
  };
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
    },
  });
}

function patchProjectList(
  queryClient: QueryClient,
  workspaceId: string,
  update: (projects: Project[]) => Project[],
) {
  queryClient.setQueryData<{ projects: Project[] }>(queryKeys.projects(workspaceId), (data) =>
    data ? { projects: update(data.projects) } : data,
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
        projects.map((entry) => (entry.id === project.id ? project : entry)),
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
