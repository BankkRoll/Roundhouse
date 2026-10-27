/**
 * Data-service queries (ADR 0004): adding a database, a service's volume and its moves
 * between nodes, the data browser's schema and queries, a service's published TCP port,
 * and credential rotations.
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
  type PutTcpProxyBody,
  type RotateCredentialsBody,
  type TcpProxy,
  type Volume,
  type VolumeMigration,
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
  migrationTargets: (volumeId: string) => ["volumes", volumeId, "migration-targets"] as const,
  migrations: (volumeId: string) => ["volumes", volumeId, "migrations"] as const,
  migration: (migrationId: string) => ["volume-migrations", migrationId] as const,
  tcpProxy: (serviceId: string, environmentId: string) =>
    ["services", serviceId, "tcp-proxy", environmentId] as const,
  rotations: (serviceId: string, environmentId: string) =>
    ["services", serviceId, "database", "credential-rotations", environmentId] as const,
};

/** How often a running volume move is re-read; its progress isn't pushed over the socket. */
export const MIGRATION_POLL_MS = 3_000;

/** How often a published port that isn't placed yet is re-read, so its endpoint appears. */
export const TCP_PROXY_POLL_MS = 10_000;

/**
 * Whether a volume move is still running.
 *
 * @param migration - A migration.
 * @returns `true` while it is queued or running.
 */
export function migrationInFlight(migration: Pick<VolumeMigration, "status">): boolean {
  return migration.status === "queued" || migration.status === "running";
}

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

/**
 * The nodes a volume could move to and the expected downtime. Read fresh each time the
 * move dialog opens, so eligibility reflects the nodes' state at that moment.
 *
 * @param volumeId - Volume id.
 * @param enabled - Skip until the dialog is open.
 * @returns The targets query.
 */
export function useMigrationTargets(volumeId: string, enabled: boolean) {
  return useQuery({
    queryKey: dataKeys.migrationTargets(volumeId),
    queryFn: ({ signal }) => dataApi.migrationTargets(volumeId, signal),
    enabled,
    staleTime: 0,
  });
}

/**
 * A volume's recent moves, newest first, polled while one is running.
 *
 * @param volumeId - Volume id, or `undefined` while the volume loads.
 * @returns The migrations query.
 */
export function useVolumeMigrations(volumeId: string | undefined) {
  return useQuery({
    queryKey: dataKeys.migrations(volumeId ?? ""),
    queryFn: ({ signal }) => dataApi.listMigrations(volumeId!, signal),
    enabled: Boolean(volumeId),
    refetchInterval: (query) =>
      query.state.data?.migrations.some(migrationInFlight) ? MIGRATION_POLL_MS : false,
  });
}

/**
 * One volume move, polled until it finishes. When it has finished, the volume and the
 * move history are refetched, since the volume's node and status changed with it.
 *
 * @param migrationId - Migration id, or `null` for none.
 * @returns The migration query.
 */
export function useVolumeMigration(migrationId: string | null) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: dataKeys.migration(migrationId ?? ""),
    queryFn: async ({ signal }) => {
      const migration = await dataApi.getMigration(migrationId!, signal);
      if (!migrationInFlight(migration)) {
        void queryClient.invalidateQueries({
          queryKey: dataKeys.volume(migration.service_id, migration.environment_id),
        });
        void queryClient.invalidateQueries({ queryKey: dataKeys.migrations(migration.volume_id) });
      }
      return migration;
    },
    enabled: migrationId !== null,
    refetchInterval: (query) =>
      query.state.data && !migrationInFlight(query.state.data) ? false : MIGRATION_POLL_MS,
  });
}

/** Input of {@link useMigrateVolume}. */
export interface MigrateVolumeInput {
  volume: Volume;
  targetNodeId: string;
  /** The service's slug, typed by the user. */
  confirm: string;
}

/**
 * Starts moving a volume to another node, then refreshes the volume (now `migrating`)
 * and its move history.
 *
 * @returns A mutation taking the volume, the target node and the typed slug.
 */
export function useMigrateVolume() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ volume, targetNodeId, confirm }: MigrateVolumeInput) =>
      dataApi.migrateVolume(volume.id, targetNodeId, confirm),
    onSuccess: (migration, { volume }) => {
      queryClient.setQueryData(dataKeys.migration(migration.id), migration);
      void queryClient.invalidateQueries({
        queryKey: dataKeys.volume(volume.service_id, volume.environment_id),
      });
      void queryClient.invalidateQueries({ queryKey: dataKeys.migrations(volume.id) });
    },
  });
}

/**
 * A service's published TCP port in an environment. A service without one answers 404,
 * which is cached as `null`. Polled while the port waits to be placed.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @returns The proxy query.
 */
export function useTcpProxy(serviceId: string, environmentId: string | undefined) {
  return useQuery({
    queryKey: dataKeys.tcpProxy(serviceId, environmentId ?? ""),
    queryFn: async ({ signal }): Promise<TcpProxy | null> => {
      try {
        return await dataApi.getTcpProxy(serviceId, environmentId!, signal);
      } catch (error) {
        if (isApiError(error, 404)) return null;
        throw error;
      }
    },
    enabled: Boolean(environmentId),
    refetchInterval: (query) =>
      query.state.data?.status === "pending" ? TCP_PROXY_POLL_MS : false,
  });
}

/**
 * Publishes a service's TCP port, or changes its allowlist, and caches the result.
 *
 * @param serviceId - Service id.
 * @returns A mutation taking the proxy body.
 */
export function usePutTcpProxy(serviceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PutTcpProxyBody) => dataApi.putTcpProxy(serviceId, body),
    onSuccess: (proxy) =>
      queryClient.setQueryData(dataKeys.tcpProxy(serviceId, proxy.environment_id), proxy),
  });
}

/**
 * Stops publishing a service's TCP port.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id.
 * @returns A mutation without input.
 */
export function useDeleteTcpProxy(serviceId: string, environmentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => dataApi.deleteTcpProxy(serviceId, environmentId),
    onSuccess: () => queryClient.setQueryData(dataKeys.tcpProxy(serviceId, environmentId), null),
  });
}

/**
 * A database's recent credential rotations, newest first.
 *
 * @param serviceId - Database service id.
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @returns The rotations query.
 */
export function useCredentialRotations(serviceId: string, environmentId: string | undefined) {
  return useQuery({
    queryKey: dataKeys.rotations(serviceId, environmentId ?? ""),
    queryFn: ({ signal }) => dataApi.listCredentialRotations(serviceId, environmentId!, signal),
    enabled: Boolean(environmentId),
  });
}

/**
 * Rotates a database's credentials, or finishes an interrupted rotation. The rotation
 * list is refetched whatever the outcome, since a failed call can still leave a
 * `running` rotation behind to finish.
 *
 * @param serviceId - Database service id.
 * @param environmentId - Environment id.
 * @returns A mutation taking the principals and the typed slug.
 */
export function useRotateCredentials(serviceId: string, environmentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<RotateCredentialsBody, "environment_id">) =>
      dataApi.rotateCredentials(serviceId, { ...body, environment_id: environmentId }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: dataKeys.rotations(serviceId, environmentId) }),
  });
}
