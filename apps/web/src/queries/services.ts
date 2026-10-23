import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { deployApi } from "../lib/api/deploy-client";
import type {
  CreateServiceBody,
  ProjectDetail,
  Service,
  UpdateServiceBody,
} from "../lib/api/deploy-types";
import { queryKeys } from "./keys";
import { invalidateProjectSummaries } from "./projects";

/**
 * Writes one service into a cached project detail.
 *
 * @param queryClient - Shared query client.
 * @param service - The updated service.
 * @param options - `append` adds it when the project doesn't list it yet (a service this
 *   tab created). Realtime updates pass `false`, since the row may be a deleted service.
 */
export function patchProjectService(
  queryClient: QueryClient,
  service: Service,
  { append = true }: { append?: boolean } = {},
): void {
  queryClient.setQueryData<ProjectDetail>(queryKeys.project(service.project_id), (project) => {
    if (!project) return project;
    const known = project.services.some((entry) => entry.id === service.id);
    if (!known && !append) return project;
    return {
      ...project,
      services: known
        ? project.services.map((entry) => (entry.id === service.id ? service : entry))
        : [...project.services, service],
    };
  });
  if (append || queryClient.getQueryData(queryKeys.service(service.id))) {
    queryClient.setQueryData(queryKeys.service(service.id), service);
  }
}

/**
 * Query options for a service's metadata, seeded from the cached project when present.
 *
 * @param queryClient - Shared query client, read for the seed.
 * @param projectId - Owning project.
 * @param serviceId - Service id.
 * @returns Options for `useQuery`.
 */
export function serviceQueryOptions(
  queryClient: QueryClient,
  projectId: string,
  serviceId: string,
) {
  return queryOptions({
    queryKey: queryKeys.service(serviceId),
    queryFn: ({ signal }) => deployApi.getService(serviceId, signal),
    initialData: () =>
      queryClient
        .getQueryData<ProjectDetail>(queryKeys.project(projectId))
        ?.services.find((service) => service.id === serviceId),
    initialDataUpdatedAt: () =>
      queryClient.getQueryState(queryKeys.project(projectId))?.dataUpdatedAt,
  });
}

/**
 * Reads a service's metadata.
 *
 * @param projectId - Owning project, used to show cached data instantly.
 * @param serviceId - Service id.
 * @returns The service query.
 */
export function useService(projectId: string, serviceId: string) {
  const queryClient = useQueryClient();
  return useQuery(serviceQueryOptions(queryClient, projectId, serviceId));
}

/**
 * Query options for the latest config version of a service in an environment.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id.
 * @returns Options for `useQuery`.
 */
export function serviceConfigQueryOptions(serviceId: string, environmentId: string) {
  return queryOptions({
    queryKey: queryKeys.serviceConfig(serviceId, environmentId),
    queryFn: ({ signal }) =>
      deployApi.getServiceConfig(serviceId, environmentId, undefined, signal),
  });
}

/**
 * Reads the latest config version of a service.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @returns The config query.
 */
export function useServiceConfig(serviceId: string, environmentId: string | undefined) {
  return useQuery({
    ...serviceConfigQueryOptions(serviceId, environmentId ?? ""),
    enabled: Boolean(environmentId),
  });
}

/**
 * Creates a service (and its first config version) and adds it to the cached project.
 *
 * @param projectId - Project id.
 * @returns A mutation taking the create body.
 */
export function useCreateService(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateServiceBody) => deployApi.createService(projectId, body),
    onSuccess: ({ service, configs }) => {
      patchProjectService(queryClient, service);
      invalidateProjectSummaries(queryClient, projectId);
      for (const config of configs) {
        queryClient.setQueryData(
          queryKeys.serviceConfig(service.id, config.environment_id),
          config,
        );
      }
    },
  });
}

/**
 * Updates a service's metadata or writes a new config version. On success the new
 * version replaces the cached config, so every form shows what was saved.
 *
 * @param serviceId - Service id.
 * @returns A mutation taking the patch body.
 */
export function useUpdateService(serviceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateServiceBody) => deployApi.updateService(serviceId, body),
    onSuccess: ({ service, config }) => {
      patchProjectService(queryClient, service);
      invalidateProjectSummaries(queryClient, service.project_id);
      if (config) {
        queryClient.setQueryData(queryKeys.serviceConfig(serviceId, config.environment_id), config);
      }
    },
  });
}

/**
 * Deletes a service and removes it from the cached project.
 *
 * @param projectId - Owning project.
 * @returns A mutation taking the service id.
 */
export function useDeleteService(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (serviceId: string) => deployApi.deleteService(serviceId),
    onSuccess: (_, serviceId) => {
      queryClient.setQueryData<ProjectDetail>(queryKeys.project(projectId), (project) =>
        project
          ? { ...project, services: project.services.filter((entry) => entry.id !== serviceId) }
          : project,
      );
      invalidateProjectSummaries(queryClient, projectId);
    },
  });
}

/**
 * Drops every cached query of a deleted service. Call after navigating away.
 *
 * @param queryClient - Shared query client.
 * @param serviceId - The deleted service.
 */
export function forgetService(queryClient: QueryClient, serviceId: string): void {
  queryClient.removeQueries({ queryKey: queryKeys.service(serviceId) });
}

/**
 * Query options for a service's domains in an environment.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id.
 * @returns Options for `useQuery`.
 */
export function domainsQueryOptions(serviceId: string, environmentId: string) {
  return queryOptions({
    queryKey: queryKeys.domains(serviceId, environmentId),
    queryFn: ({ signal }) => deployApi.listDomains(serviceId, environmentId, signal),
    select: (data) => data.domains,
  });
}

/**
 * Reads a service's domains.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @returns The domains query.
 */
export function useDomains(serviceId: string, environmentId: string | undefined) {
  return useQuery({
    ...domainsQueryOptions(serviceId, environmentId ?? ""),
    enabled: Boolean(environmentId),
  });
}
