/**
 * Typed endpoint functions and wire types for Cloudflare Containers as a service
 * runtime (ADR 0011): the instance's Cloudflare account (Settings → Cloudflare) and a
 * service's runtime state and eligibility (Service → Settings → Runtime).
 *
 * Types come from the API's route contracts (`apps/api/src/contracts/cloudflare.ts`), so
 * a contract change that breaks the dashboard fails typecheck.
 *
 * @module
 */
import type {
  BodyOf,
  CloudflareSettings,
  CloudflareVerification,
  putInstanceCloudflare,
  ServiceCloudflareStatus,
} from "../../../../api/src/contracts";
import { request } from "./client";

/** `GET /v1/instance/cloudflare`: the account the provider deploys to, without the token. */
export type InstanceCloudflare = CloudflareSettings;

/** `PUT /v1/instance/cloudflare` body. The token is write-only. */
export type PutInstanceCloudflareBody = BodyOf<typeof putInstanceCloudflare>;

/** `POST /v1/instance/cloudflare/verify` response. */
export type { CloudflareVerification };

/** One check of the verification. */
export type CloudflareCheck = CloudflareVerification["checks"][number];

/** `GET /v1/services/{serviceId}/cloudflare` response. */
export type ServiceCloudflare = ServiceCloudflareStatus;

/** One failed eligibility rule, including `not_configured`. */
export type ProviderEligibility = ServiceCloudflare["eligibility"][number];

/** A service-environment's runtime Worker and container application. */
export type CloudflareRuntime = NonNullable<ServiceCloudflare["runtime"]>;

/** One rollout to Cloudflare. */
export type CloudflareDeployment = ServiceCloudflare["deployments"][number];

/** Cloudflare deployment statuses that are still moving towards `active` or `failed`. */
export const CLOUDFLARE_ROLLOUT_STATUSES: ReadonlySet<CloudflareDeployment["status"]> = new Set([
  "pushing",
  "uploading",
  "rolling_out",
  "warming",
  "routing",
]);

/** Most image storage Cloudflare's registry holds per account. */
export const CLOUDFLARE_IMAGE_STORAGE_LIMIT_BYTES = 50 * 1024 ** 3;

const seg = encodeURIComponent;

/** Cloudflare endpoints. */
export const cloudflareApi = {
  /**
   * Reads the instance's Cloudflare account. Instance admins only.
   *
   * @param signal - Abort signal.
   * @returns The account settings, without the token.
   */
  getInstance: (signal?: AbortSignal) =>
    request<InstanceCloudflare>("GET", "/v1/instance/cloudflare", { signal }),
  /**
   * Sets the account and token, validating the token first. Needs a fresh session; the
   * client asks for the password and retries.
   *
   * @param body - Account id and token.
   * @returns The settings afterwards.
   */
  putInstance: (body: PutInstanceCloudflareBody) =>
    request<InstanceCloudflare>("PUT", "/v1/instance/cloudflare", { body }),
  /**
   * Removes the account and its sealed token; 409 while any service runs on Cloudflare.
   *
   * @returns The settings afterwards.
   */
  deleteInstance: () => request<InstanceCloudflare>("DELETE", "/v1/instance/cloudflare"),
  /**
   * Re-checks the stored token's scopes and the apps zone.
   *
   * @returns Each check with its result.
   */
  verify: () => request<CloudflareVerification>("POST", "/v1/instance/cloudflare/verify"),
  /**
   * Reads a service's provider, eligibility and Cloudflare runtime in an environment.
   *
   * @param serviceId - Service id.
   * @param environmentId - Environment id.
   * @param signal - Abort signal.
   * @returns The runtime view.
   */
  getService: (serviceId: string, environmentId: string, signal?: AbortSignal) =>
    request<ServiceCloudflare>("GET", `/v1/services/${seg(serviceId)}/cloudflare`, {
      query: { environment_id: environmentId },
      signal,
    }),
};
