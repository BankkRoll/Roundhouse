/**
 * Typed endpoint functions and wire types for custom domains (ADR 0009): add, read,
 * change the HSTS policy, check now and remove. Listing stays in
 * `deployApi.listDomains`.
 *
 * Types come from the API's route contracts (`apps/api/src/contracts/domains.ts`), so a
 * contract change that breaks the dashboard fails typecheck.
 *
 * @module
 */
import type { addDomain, BodyOf, Domain, updateDomain } from "../../../../api/src/contracts";
import { request } from "./client";

/** `POST /v1/services/{serviceId}/domains` body. */
export type AddDomainBody = BodyOf<typeof addDomain>;
/** `PATCH /v1/domains/{domainId}` body. */
export type UpdateDomainBody = BodyOf<typeof updateDomain>;
/** One DNS record a custom domain's owner must create. */
export type DnsRecord = Domain["records"][number];
/** A domain's HSTS policy. */
export type DomainHsts = Domain["hsts"];
/** The certificate serving a domain, with each node's state. */
export type DomainTls = Domain["tls"];
/** An ingress server of the domain's workspace, and whether it runs the service. */
export type DomainRoutingNode = Domain["routing_nodes"][number];

const seg = encodeURIComponent;

/** Custom-domain endpoints. */
export const domainsApi = {
  /**
   * Adds a custom hostname to a service in an environment; the API checks DNS once.
   *
   * @param serviceId - Service id.
   * @param body - Environment and hostname.
   * @returns The domain with the records to create.
   */
  add: (serviceId: string, body: AddDomainBody) =>
    request<Domain>("POST", `/v1/services/${seg(serviceId)}/domains`, { body }),
  /**
   * Reads one domain.
   *
   * @param domainId - Domain id.
   * @param signal - Abort signal.
   * @returns The domain.
   */
  get: (domainId: string, signal?: AbortSignal) =>
    request<Domain>("GET", `/v1/domains/${seg(domainId)}`, { signal }),
  /**
   * Changes a custom domain's HSTS policy. Turning `preload` on needs `confirm_preload`
   * set to the hostname; 422 `invalid_hsts` lists each rule broken in `details`.
   *
   * @param domainId - Domain id.
   * @param body - The policy, and the typed hostname when turning preload on.
   * @returns The domain with the new policy.
   */
  update: (domainId: string, body: UpdateDomainBody) =>
    request<Domain>("PATCH", `/v1/domains/${seg(domainId)}`, { body }),
  /**
   * Checks a domain's DNS now; resumes a failed one. 429 right after another check.
   *
   * @param domainId - Domain id.
   * @returns The domain after the check.
   */
  check: (domainId: string) => request<Domain>("POST", `/v1/domains/${seg(domainId)}/check`),
  /**
   * Removes a custom domain and its route.
   *
   * @param domainId - Domain id.
   */
  remove: (domainId: string) => request<void>("DELETE", `/v1/domains/${seg(domainId)}`),
};
