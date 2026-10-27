/**
 * Registry storage (ADR 0005, "Registry over the mesh"): where builds are kept. Unset,
 * each workspace's builder keeps them on its disk and other servers pull through it over
 * the mesh; with a bucket, builders write to it and every other server reads it with a
 * read-only key. Both secrets are write-only.
 *
 * @module
 */
import type { RegistryStorage } from "../../../../api/src/contracts";
import { request } from "./client";

export type { RegistryStorage };

/** `PUT /v1/instance/registry-storage` body; omitted secrets keep the stored ones. */
export interface RegistryStorageBody {
  endpoint: string;
  bucket: string;
  region?: string;
  access_key_id: string;
  secret_access_key?: string;
  readonly_access_key_id: string;
  readonly_secret_access_key?: string;
}

/** The registry storage routes. */
export const registryApi = {
  get: (signal?: AbortSignal) =>
    request<RegistryStorage>("GET", "/v1/instance/registry-storage", { signal }),
  put: (body: RegistryStorageBody) =>
    request<RegistryStorage>("PUT", "/v1/instance/registry-storage", { body }),
  /** Back to each builder's disk. */
  remove: () => request<RegistryStorage>("DELETE", "/v1/instance/registry-storage"),
};
