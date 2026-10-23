import { CANCELLABLE_DEPLOYMENT_STATUSES } from "@roundhouse/shared";
import {
  type InfiniteData,
  type QueryClient,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { deployApi } from "../lib/api/deploy-client";
import type {
  CreateDeploymentBody,
  Deployment,
  DeploymentDetail,
  DeploymentEvent,
  DeploymentPage,
} from "../lib/api/deploy-types";
import { queryKeys } from "./keys";

/** Deployments fetched per page. */
export const DEPLOYMENTS_PAGE_SIZE = 20;

/** How often an in-flight deployment is refetched, in case realtime updates are missed. */
export const DEPLOYMENT_POLL_MS = 10_000;

/**
 * Whether a deployment may still change on its own (and is worth watching).
 *
 * @param deployment - A deployment.
 * @returns `true` while queued, building or deploying.
 */
export function isInFlight(deployment: Pick<Deployment, "status">): boolean {
  return CANCELLABLE_DEPLOYMENT_STATUSES.includes(deployment.status);
}

// -----------------------------------------------------------------------------
// Cache writers, shared by mutations and the realtime socket
// -----------------------------------------------------------------------------

/**
 * Writes a deployment into every cached place it appears: the service's paged list
 * (replacing it, or prepending it when new), the "newest deployment" summary, and its
 * own detail (keeping the events and placements already loaded).
 *
 * Copies already newer than `deployment` (by `updated_at`) are kept, so a late
 * realtime message cannot undo a fresher response.
 *
 * @param queryClient - Shared query client.
 * @param deployment - The deployment as the API last reported it.
 * @param options - `force` writes even over newer copies (undoing an optimistic update).
 */
export function upsertDeployment(
  queryClient: QueryClient,
  deployment: Deployment,
  options: { force?: boolean } = {},
): void {
  const { service_id: serviceId, environment_id: environmentId } = deployment;
  const newer = (cached: Deployment) => !options.force && cached.updated_at > deployment.updated_at;
  queryClient.setQueryData<InfiniteData<DeploymentPage, string | null>>(
    queryKeys.deployments(serviceId, environmentId),
    (data) => {
      if (!data) return data;
      let found = false;
      const pages = data.pages.map((page) => ({
        ...page,
        deployments: page.deployments.map((entry) => {
          if (entry.id !== deployment.id) return entry;
          found = true;
          return newer(entry) ? entry : deployment;
        }),
      }));
      if (!found && pages[0]) {
        pages[0] = { ...pages[0], deployments: [deployment, ...pages[0].deployments] };
      }
      return { ...data, pages };
    },
  );
  queryClient.setQueryData<Deployment | null>(
    queryKeys.latestDeployment(serviceId, environmentId),
    (latest) => {
      if (latest === undefined) return latest;
      if (!latest || latest.id === deployment.id || deployment.created_at >= latest.created_at) {
        return latest && latest.id === deployment.id && newer(latest) ? latest : deployment;
      }
      return latest;
    },
  );
  queryClient.setQueryData<DeploymentDetail>(queryKeys.deployment(deployment.id), (detail) =>
    detail && !newer(detail) ? { ...detail, ...deployment } : detail,
  );
}

/**
 * Appends a timeline event to a cached deployment detail, ignoring duplicates.
 *
 * @param queryClient - Shared query client.
 * @param event - The new event.
 */
export function appendDeploymentEvent(queryClient: QueryClient, event: DeploymentEvent): void {
  queryClient.setQueryData<DeploymentDetail>(queryKeys.deployment(event.deployment_id), (detail) =>
    detail && !detail.events.some((entry) => entry.id === event.id)
      ? {
          ...detail,
          events: [...detail.events, event].sort((a, b) => a.created_at - b.created_at),
        }
      : detail,
  );
}

// -----------------------------------------------------------------------------
// Queries
// -----------------------------------------------------------------------------

/**
 * Reads a service's deployments, newest first, with cursor paging.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @returns An infinite query; `fetchNextPage` loads older deployments.
 */
export function useDeployments(serviceId: string, environmentId: string | undefined) {
  return useInfiniteQuery({
    queryKey: queryKeys.deployments(serviceId, environmentId ?? ""),
    queryFn: ({ pageParam, signal }) =>
      deployApi.listDeployments(
        serviceId,
        environmentId ?? "",
        { cursor: pageParam, limit: DEPLOYMENTS_PAGE_SIZE },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    enabled: Boolean(environmentId),
    refetchInterval: (query) =>
      query.state.data?.pages[0]?.deployments.some(isInFlight) ? DEPLOYMENT_POLL_MS : false,
  });
}

/**
 * Query options for one deployment with its events and placements.
 *
 * @param deploymentId - Deployment id.
 * @returns Options for `useQuery`; polls while the deployment is in flight.
 */
export function deploymentQueryOptions(deploymentId: string) {
  return queryOptions({
    queryKey: queryKeys.deployment(deploymentId),
    queryFn: ({ signal }) => deployApi.getDeployment(deploymentId, signal),
    refetchInterval: (query) =>
      query.state.data && isInFlight(query.state.data) ? DEPLOYMENT_POLL_MS : false,
  });
}

/**
 * Reads one deployment with its timeline and replicas.
 *
 * @param deploymentId - Deployment id.
 * @returns The deployment query.
 */
export function useDeployment(deploymentId: string) {
  return useQuery(deploymentQueryOptions(deploymentId));
}

// -----------------------------------------------------------------------------
// Mutations
// -----------------------------------------------------------------------------

/** Variables of {@link useDeploy}. */
export interface DeployVariables {
  serviceId: string;
  environmentId: string;
  /** Git sources: the commit to build. Defaults to the branch head. */
  commitSha?: string;
}

/**
 * Deploys a service's latest config and adds the new deployment to the caches.
 *
 * @returns A mutation taking the service, environment and optional commit.
 */
export function useDeploy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ serviceId, environmentId, commitSha }: DeployVariables) => {
      const body: CreateDeploymentBody = commitSha ? { commit_sha: commitSha } : {};
      return deployApi.createDeployment(serviceId, environmentId, body);
    },
    onSuccess: (deployment) => upsertDeployment(queryClient, deployment),
  });
}

/**
 * Rolls back to an earlier deployment, which creates a new deployment.
 *
 * @returns A mutation taking the deployment to roll back to.
 */
export function useRollback() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deploymentId: string) => deployApi.rollbackDeployment(deploymentId),
    onSuccess: (deployment) => upsertDeployment(queryClient, deployment),
  });
}

/**
 * Cancels an in-flight deployment. The row flips to `cancelled` immediately and is
 * restored if the API refuses (for example because it finished in the meantime).
 *
 * @returns A mutation taking the deployment to cancel.
 */
export function useCancelDeployment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deployment: Deployment) => deployApi.cancelDeployment(deployment.id),
    onMutate: (deployment) => {
      upsertDeployment(queryClient, { ...deployment, status: "cancelled" }, { force: true });
      return { previous: deployment };
    },
    onError: (_error, _deployment, context) => {
      if (!context) return;
      upsertDeployment(queryClient, context.previous, { force: true });
      void queryClient.invalidateQueries({ queryKey: queryKeys.deployment(context.previous.id) });
    },
    onSuccess: (deployment) => upsertDeployment(queryClient, deployment),
  });
}
