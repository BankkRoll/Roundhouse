/**
 * Custom domain routes (ADR 0009, direct mode): add a hostname to a service
 * in an environment, read it with the DNS records to create, check it now,
 * and remove it. Listing lives with the Phase 1 routes (`listDomains`).
 *
 * Changes are `services:manage` checked against the target environment, so
 * a protected environment's `config` rule applies to its domains too.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { body, DomainSchema, errors, json, sessionAuth } from "../schemas";
import { ServiceParams } from "./params";
import { defineRoute, session } from "./policy";

/** `{domainId}` path param. */
export const DomainParams = z.object({ domainId: z.string() });

/** Body of `POST /v1/services/{serviceId}/domains`. */
export const AddDomainBody = z
  .object({
    environment_id: z.string(),
    /**
     * Normalised before validation: case, one trailing dot and
     * internationalised names (to punycode) are accepted.
     */
    hostname: z.string().min(1).max(300).openapi({ example: "shop.example.com" }),
  })
  .openapi("AddDomain");

/**
 * Adds a custom hostname and checks its DNS once. The response lists the
 * records to create; the domain is routed only once both the routing record
 * and the ownership TXT are seen. 409 `domain_taken` when another service
 * holds it; 422 `hostname_not_allowed` for wildcards, IPs, non-public names
 * and the install's own names.
 */
export const addDomain = defineRoute(
  session("services:manage", ["domain.added", "domain.verified"]),
  {
    method: "post",
    path: "/v1/services/{serviceId}/domains",
    tags: ["domains"],
    summary: "Add a custom domain",
    security: sessionAuth,
    request: { params: ServiceParams, ...body(AddDomainBody) },
    responses: { 201: json(DomainSchema, "Added"), ...errors(400, 401, 403, 404, 409, 422) },
  },
);

/** One domain with its DNS records and verification state. */
export const getDomain = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/domains/{domainId}",
  tags: ["domains"],
  summary: "Get a domain",
  security: sessionAuth,
  request: { params: DomainParams },
  responses: { 200: json(DomainSchema), ...errors(401, 403, 404) },
});

/**
 * Checks a custom domain's DNS now instead of waiting for the schedule, and
 * resumes a `failed` one with a fresh 72-hour window. 429 when it was
 * checked moments ago.
 */
export const recheckDomain = defineRoute(session("services:manage", ["domain.verified"]), {
  method: "post",
  path: "/v1/domains/{domainId}/check",
  tags: ["domains"],
  summary: "Check a domain now",
  security: sessionAuth,
  request: { params: DomainParams },
  responses: { 200: json(DomainSchema), ...errors(401, 403, 404, 409, 429) },
});

/**
 * Removes a custom domain and its route. Generated domains follow the
 * service's `networking.generated_domain` instead (409).
 */
export const removeDomain = defineRoute(session("services:manage", ["domain.removed"]), {
  method: "delete",
  path: "/v1/domains/{domainId}",
  tags: ["domains"],
  summary: "Remove a custom domain",
  security: sessionAuth,
  request: { params: DomainParams },
  responses: { 204: { description: "Removed" }, ...errors(401, 403, 404, 409) },
});

/** Every custom-domain route, by name. */
export const DOMAIN_ROUTES = { addDomain, getDomain, recheckDomain, removeDomain } as const;
