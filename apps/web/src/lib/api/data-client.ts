/**
 * Typed endpoint functions and wire types for data services (ADR 0004): adding a
 * database, a service's volume (read, grow, delete, undelete) and the read-only data
 * browser (schema and queries).
 *
 * Types come from the API's route contracts (`apps/api/src/contracts/databases.ts` and
 * `data-browser.ts`), so a contract change that breaks the dashboard fails typecheck.
 *
 * @module
 */
import type {
  BodyOf,
  CreatedDatabase,
  createDatabase,
  DatabaseQueryResult,
  getDatabaseSchema,
  ResponseOf,
  runDatabaseQuery,
  Volume,
} from "../../../../api/src/contracts";
import { request } from "./client";

export type { CreatedDatabase, DatabaseQueryResult, Volume };

/** `POST /v1/projects/{projectId}/databases` body. */
export type CreateDatabaseBody = BodyOf<typeof createDatabase>;
/** `POST /v1/services/{serviceId}/database/query` body. */
export type DatabaseQueryBody = BodyOf<typeof runDatabaseQuery>;
/** One data-browser operation. */
export type DatabaseQueryOp = DatabaseQueryBody["op"];
/** `GET /v1/services/{serviceId}/database/schema` response. */
export type DatabaseSchema = ResponseOf<typeof getDatabaseSchema, 200>;

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
};
