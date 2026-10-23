/**
 * Data-service queries (ADR 0004): adding a database, a service's volume and the data
 * browser's schema and queries.
 *
 * Keys sit under the service's prefix, so forgetting a service drops them too. Data
 * browser results are held only while the component showing them is mounted
 * (`gcTime: 0`), as the API never stores them either.
 *
 * @module
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isApiError } from "../lib/api/client";
import {
  type CreateDatabaseBody,
  type DatabaseQueryBody,
  type DatabaseQueryOp,
  dataApi,
  type Volume,
} from "../lib/api/data-client";
import { invalidateProjectSummaries } from "./projects";
import { patchProjectService } from "./services";

/** Query keys of data services; prefixes of the service keys. */
export const dataKeys = {
  volume: (serviceId: string, environmentId: string) =>
    ["services", serviceId, "volume", environmentId] as const,
  schema: (serviceId: string, environmentId: string) =>
    ["services", serviceId, "database", "schema", environmentId] as const,
  browse: (serviceId: string, environmentId: string, op: DatabaseQueryOp) =>
    ["services", serviceId, "database", "browse", environmentId, op] as const,
};

/**
 * Adds a database service and puts it into the cached project.
 *
 * @param projectId - Project id.
 * @returns A mutation taking the create body.
 */
export function useCreateDatabase(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateDatabaseBody) => dataApi.createDatabase(projectId, body),
    onSuccess: (created) => {
      patchProjectService(queryClient, created.service);
      invalidateProjectSummaries(queryClient, projectId);
      for (const volume of created.volumes) {
        queryClient.setQueryData(dataKeys.volume(volume.service_id, volume.environment_id), volume);
      }
    },
  });
}

/**
 * A service's volume in an environment. A service without one answers 404, which is
 * cached as `null` rather than treated as an error.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @param enabled - Skip for services that can't have a volume.
 * @returns The volume query.
 */
export function useVolume(serviceId: string, environmentId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: dataKeys.volume(serviceId, environmentId ?? ""),
    queryFn: async ({ signal }): Promise<Volume | null> => {
      try {
        return await dataApi.getVolume(serviceId, environmentId!, signal);
      } catch (error) {
        if (isApiError(error, 404)) return null;
        throw error;
      }
    },
    enabled: enabled && Boolean(environmentId),
  });
}

function useVolumeMutation<T>(fn: (input: T) => Promise<Volume>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (volume) =>
      queryClient.setQueryData(dataKeys.volume(volume.service_id, volume.environment_id), volume),
  });
}

/**
 * Grows a volume.
 *
 * @returns A mutation taking the volume id and new size in MiB.
 */
export function useResizeVolume() {
  return useVolumeMutation(({ volumeId, sizeMb }: { volumeId: string; sizeMb: number }) =>
    dataApi.resizeVolume(volumeId, sizeMb),
  );
}

/**
 * Schedules a volume's data for removal.
 *
 * @returns A mutation taking the volume id.
 */
export function useDeleteVolume() {
  return useVolumeMutation((volumeId: string) => dataApi.deleteVolume(volumeId));
}

/**
 * Cancels a volume's pending deletion.
 *
 * @returns A mutation taking the volume id.
 */
export function useUndeleteVolume() {
  return useVolumeMutation((volumeId: string) => dataApi.undeleteVolume(volumeId));
}

/**
 * The database's namespaces for the browser's schema tree. Opening it is audited, so it
 * isn't refetched on focus.
 *
 * @param serviceId - Database service id.
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @param enabled - Skip without `data:read`.
 * @returns The schema query.
 */
export function useDatabaseSchema(
  serviceId: string,
  environmentId: string | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: dataKeys.schema(serviceId, environmentId ?? ""),
    queryFn: ({ signal }) => dataApi.getSchema(serviceId, environmentId!, signal),
    enabled: enabled && Boolean(environmentId),
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Runs data-browser operations. Results stay with the caller and are never cached.
 *
 * @param serviceId - Database service id.
 * @returns A mutation taking the query body.
 */
export function useDatabaseQuery(serviceId: string) {
  return useMutation({
    mutationFn: (body: DatabaseQueryBody) => dataApi.query(serviceId, body),
  });
}

/**
 * Runs a read-only browsing operation (a namespace's tables, a page of rows) as a query,
 * so the same page isn't fetched twice while it is shown. The previous page stays on
 * screen while the next one loads.
 *
 * @param serviceId - Database service id.
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @param op - The operation, or `null` to wait.
 * @returns The result query.
 */
export function useBrowseQuery(
  serviceId: string,
  environmentId: string | undefined,
  op: DatabaseQueryOp | null,
) {
  return useQuery({
    queryKey: dataKeys.browse(serviceId, environmentId ?? "", op ?? { type: "list_namespaces" }),
    queryFn: ({ signal }) =>
      dataApi.query(serviceId, { environment_id: environmentId!, mode: "read", op: op! }, signal),
    enabled: Boolean(environmentId) && op !== null,
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
}
