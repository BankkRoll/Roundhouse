/**
 * Typed endpoint functions and wire types for Settings → Domains & TLS (ADR 0009): the
 * install's TLS prerequisites, the ACME CA and contact, the Cloudflare DNS zone and the
 * control plane's certificates. The TLS mode itself is changed with
 * `deployApi.updateInstanceSettings`.
 *
 * Types come from the API's route contracts (`apps/api/src/contracts/tls.ts`), so a
 * contract change that breaks the dashboard fails typecheck.
 *
 * @module
 */
import type {
  BodyOf,
  Certificate,
  InstanceDomainSettings,
  putInstanceDomains,
} from "../../../../api/src/contracts";
import { request } from "./client";

export type { Certificate, InstanceDomainSettings };

/** `PUT /v1/instance/domains` body; omitted fields keep their value. */
export type PutInstanceDomainsBody = BodyOf<typeof putInstanceDomains>;

/** Domains & TLS endpoints. Instance admins only, from a browser session. */
export const tlsApi = {
  /**
   * Reads the domain and TLS settings, with whether `managed` mode may be selected.
   *
   * @param signal - Abort signal.
   * @returns The settings.
   */
  getSettings: (signal?: AbortSignal) =>
    request<InstanceDomainSettings>("GET", "/v1/instance/domains", { signal }),
  /**
   * Changes the ingress hostname, the ACME CA or contact, or the Cloudflare zone. Needs a
   * fresh session; a Cloudflare token the zone refuses is 422 `cloudflare_dns_invalid`.
   *
   * @param body - The fields to change; `cloudflare_dns: null` removes the zone.
   * @returns The settings afterwards.
   */
  putSettings: (body: PutInstanceDomainsBody) =>
    request<InstanceDomainSettings>("PUT", "/v1/instance/domains", { body }),
  /**
   * Lists the control plane's certificates, apps wildcard first.
   *
   * @param signal - Abort signal.
   * @returns The certificates.
   */
  listCertificates: (signal?: AbortSignal) =>
    request<{ certificates: Certificate[] }>("GET", "/v1/instance/certificates", { signal }),
};
