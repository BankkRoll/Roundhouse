/**
 * Typed endpoint functions and wire types for data services (ADR 0004): adding a
 * database, a service's volume (read, grow, delete, undelete, move to another node), the
 * read-only data browser (schema and queries), a service's published TCP port, and
 * database credential rotation.
 *
 * Types come from the API's route contracts (`apps/api/src/contracts/databases.ts` and
 * `data-browser.ts`), so a contract change that breaks the dashboard fails typecheck.
 *
 * @module
 */
import type {
  BodyOf,
  CreatedDatabase,
  CredentialRotation,
  createDatabase,
  DatabaseQueryResult,
  getDatabaseSchema,
  listCredentialRotations,
  listVolumeMigrations,
  MigrationTargets,
  putTcpProxy,
  ResponseOf,
  rotateDatabaseCredentials,
  runDatabaseQuery,
  TcpProxy,
  Volume,
  VolumeMigration,
} from "../../../../api/src/contracts";
import { request } from "./client";

export type {
  CreatedDatabase,
  CredentialRotation,
  DatabaseQueryResult,
  MigrationTargets,
  TcpProxy,
  Volume,
  VolumeMigration,
};

/** `POST /v1/projects/{projectId}/databases` body. */
export type CreateDatabaseBody = BodyOf<typeof createDatabase>;
/** `POST /v1/services/{serviceId}/database/query` body. */
export type DatabaseQueryBody = BodyOf<typeof runDatabaseQuery>;
/** One data-browser operation. */
export type DatabaseQueryOp = DatabaseQueryBody["op"];
/** `GET /v1/services/{serviceId}/database/schema` response. */
export type DatabaseSchema = ResponseOf<typeof getDatabaseSchema, 200>;
/** `GET /v1/volumes/{volumeId}/migrations` response. */
export type VolumeMigrationList = ResponseOf<typeof listVolumeMigrations, 200>;
/** `PUT /v1/services/{serviceId}/tcp-proxies` body. */
export type PutTcpProxyBody = BodyOf<typeof putTcpProxy>;
/** `POST /v1/services/{serviceId}/database/rotate-credentials` body. */
export type RotateCredentialsBody = BodyOf<typeof rotateDatabaseCredentials>;
/** `GET /v1/services/{serviceId}/database/credential-rotations` response. */
export type CredentialRotationList = ResponseOf<typeof listCredentialRotations, 200>;
/** A principal whose password a rotation changes. */
export type DatabasePrincipal = CredentialRotation["principals"][number];

const seg = encodeURIComponent;

/** Database, volume and data-browser endpoints. */
export const dataApi = {
  /**
   * Adds a database service through a change set applied at once.
   *
   * @param projectId - Project id.
   * @param body - Engine, version, volume size and environment.
   * @returns The service, its volumes, the variable keys created and any deployments.
   * @example
   * await dataApi.createDatabase("prj_1", { engine: "postgres", environment_id: "env_prod" });
   */
  createDatabase: (projectId: string, body: CreateDatabaseBody) =>
    request<CreatedDatabase>("POST", `/v1/projects/${seg(projectId)}/databases`, { body }),
  /**
   * Reads a service's volume in one environment.
   *
   * @param serviceId - Service id.
   * @param environmentId - Environment id.
   * @param signal - Abort signal.
   * @returns The volume; 404 when the service has none there.
   */
  getVolume: (serviceId: string, environmentId: string, signal?: AbortSignal) =>
    request<Volume>("GET", `/v1/services/${seg(serviceId)}/volume`, {
      query: { environment_id: environmentId },
      signal,
    }),
  /**
   * Grows a volume. Shrinking is refused (422 `volume_shrink_unsupported`).
   *
   * @param volumeId - Volume id.
   * @param sizeMb - New size in MiB.
   * @returns The volume.
   */
  resizeVolume: (volumeId: string, sizeMb: number) =>
    request<Volume>("PATCH", `/v1/volumes/${seg(volumeId)}`, { body: { size_mb: sizeMb } }),
  /**
   * Schedules a volume's data for removal after the 72-hour grace period.
   *
   * @param volumeId - Volume id.
   * @returns The volume, now `pending_deletion`.
   */
  deleteVolume: (volumeId: string) => request<Volume>("DELETE", `/v1/volumes/${seg(volumeId)}`),
  /**
   * Cancels a pending deletion.
   *
   * @param volumeId - Volume id.
   * @returns The volume.
   */
  undeleteVolume: (volumeId: string) =>
    request<Volume>("POST", `/v1/volumes/${seg(volumeId)}/undelete`),
  /**
   * Opens the data browser: the database's namespaces.
   *
   * @param serviceId - Database service id.
   * @param environmentId - Environment id.
   * @param signal - Abort signal.
   * @returns Engine, version and the namespace listing.
   */
  getSchema: (serviceId: string, environmentId: string, signal?: AbortSignal) =>
    request<DatabaseSchema>("GET", `/v1/services/${seg(serviceId)}/database/schema`, {
      query: { environment_id: environmentId },
      signal,
    }),
  /**
   * Runs one data-browser operation.
   *
   * @param serviceId - Database service id.
   * @param body - Environment, mode, operation and limits.
   * @param signal - Abort signal.
   * @returns The result; `ok: false` carries the engine's error.
   */
  query: (serviceId: string, body: DatabaseQueryBody, signal?: AbortSignal) =>
    request<DatabaseQueryResult>("POST", `/v1/services/${seg(serviceId)}/database/query`, {
      body,
      signal,
    }),
  /**
   * Lists the nodes a volume could move to, with why each ineligible one can't take it.
   *
   * @param volumeId - Volume id.
   * @param signal - Abort signal.
   * @returns The targets and the expected downtime.
   */
  migrationTargets: (volumeId: string, signal?: AbortSignal) =>
    request<MigrationTargets>("GET", `/v1/volumes/${seg(volumeId)}/migration-targets`, { signal }),
  /**
   * Starts moving a volume to another node. Needs a fresh session; the service is down
   * for the whole copy.
   *
   * @param volumeId - Volume id.
   * @param targetNodeId - The node to move it to.
   * @param confirm - The service's slug, typed by the user.
   * @returns The queued migration.
   */
  migrateVolume: (volumeId: string, targetNodeId: string, confirm: string) =>
    request<VolumeMigration>("POST", `/v1/volumes/${seg(volumeId)}/migrate`, {
      body: { target_node_id: targetNodeId, confirm },
    }),
  /**
   * Lists a volume's recent migrations, newest first.
   *
   * @param volumeId - Volume id.
   * @param signal - Abort signal.
   * @returns The migrations.
   */
  listMigrations: (volumeId: string, signal?: AbortSignal) =>
    request<VolumeMigrationList>("GET", `/v1/volumes/${seg(volumeId)}/migrations`, { signal }),
  /**
   * Reads one volume migration.
   *
   * @param migrationId - Migration id.
   * @param signal - Abort signal.
   * @returns The migration.
   */
  getMigration: (migrationId: string, signal?: AbortSignal) =>
    request<VolumeMigration>("GET", `/v1/volume-migrations/${seg(migrationId)}`, { signal }),
  /**
   * Reads a service's published TCP port in one environment.
   *
   * @param serviceId - Service id.
   * @param environmentId - Environment id.
   * @param signal - Abort signal.
   * @returns The proxy; 404 when the port isn't published.
   */
  getTcpProxy: (serviceId: string, environmentId: string, signal?: AbortSignal) =>
    request<TcpProxy>("GET", `/v1/services/${seg(serviceId)}/tcp-proxies`, {
      query: { environment_id: environmentId },
      signal,
    }),
  /**
   * Publishes a service's TCP port behind a source allowlist, or changes the allowlist.
   * Needs a fresh session.
   *
   * @param serviceId - Service id.
   * @param body - Environment, allowed sources and, for an open list, the acknowledgement.
   * @returns The proxy.
   */
  putTcpProxy: (serviceId: string, body: PutTcpProxyBody) =>
    request<TcpProxy>("PUT", `/v1/services/${seg(serviceId)}/tcp-proxies`, { body }),
  /**
   * Stops publishing a service's TCP port.
   *
   * @param serviceId - Service id.
   * @param environmentId - Environment id.
   */
  deleteTcpProxy: (serviceId: string, environmentId: string) =>
    request<void>("DELETE", `/v1/services/${seg(serviceId)}/tcp-proxies`, {
      query: { environment_id: environmentId },
    }),
  /**
   * Rotates a database's passwords and redeploys every service using them. Needs a fresh
   * session. Calling it again finishes an interrupted rotation.
   *
   * @param serviceId - Database service id.
   * @param body - Environment, principals and the typed slug.
   * @returns The rotation.
   */
  rotateCredentials: (serviceId: string, body: RotateCredentialsBody) =>
    request<CredentialRotation>(
      "POST",
      `/v1/services/${seg(serviceId)}/database/rotate-credentials`,
      { body },
    ),
  /**
   * Lists a database's recent credential rotations, newest first.
   *
   * @param serviceId - Database service id.
   * @param environmentId - Environment id.
   * @param signal - Abort signal.
   * @returns The rotations.
   */
  listCredentialRotations: (serviceId: string, environmentId: string, signal?: AbortSignal) =>
    request<CredentialRotationList>(
      "GET",
      `/v1/services/${seg(serviceId)}/database/credential-rotations`,
      { query: { environment_id: environmentId }, signal },
    ),
};
