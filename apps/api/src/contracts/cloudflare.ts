/**
 * The Cloudflare Containers provider (ADR 0011, "Routes, RBAC, audit"):
 * - Settings → Cloudflare: the account and API token the provider runs
 *   with (instance admins, browser session only; writes need a fresh one;
 *   the token is write-only);
 * - a service's provider status in one environment: eligibility, runtime
 *   script, instances and Cloudflare deployments.
 *
 * The provider switch itself is a `config.patch` of `placement.provider`
 * (and `placement.cloudflare`) through a change set (ADR 0006).
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { CLOUDFLARE_ELIGIBILITY_RULES, SERVICE_PROVIDERS } from "@roundhouse/shared";
import { body, errors, json, Millis, sessionAuth, sessionOnlyAuth } from "../schemas";
import { EnvironmentQuery, ServiceParams } from "./params";
import { defineRoute, session, sessionOnly } from "./policy";

/** Rules an eligibility check reports: the shared ones plus the instance setting. */
export const PROVIDER_RULES = [...CLOUDFLARE_ELIGIBILITY_RULES, "not_configured"] as const;

/** Settings → Cloudflare. The token is never returned. */
export const CloudflareSettingsSchema = z
  .object({
    configured: z.boolean(),
    account_id: z.string().nullable(),
    /** `*.<subdomain>.workers.dev`, read from the account when the token was saved. */
    workers_subdomain: z.string().nullable(),
    /**
     * The operator confirmed the apps domain's wildcard record is proxied
     * (orange cloud); Worker routes only run on proxied hostnames.
     */
    apps_domain_proxied: z.boolean(),
    /** The zone Worker routes are created in; `null` when the apps domain isn't in the account. */
    apps_zone: z.string().nullable(),
    /** Last 4 characters of the token. */
    token_hint: z.string().nullable(),
    validated_at: Millis.nullable(),
    /**
     * Bytes of images in the managed registry, out of 50 GB per account;
     * `null` until Cloudflare exposes it through the API.
     */
    image_storage_bytes: z.number().int().nullable(),
  })
  .openapi("CloudflareSettings");

/** Body of `PUT /v1/instance/cloudflare`. */
export const PutCloudflareSettingsBody = z
  .object({
    account_id: z.string().regex(/^[a-f0-9]{32}$/, "expected a 32-character account ID"),
    /**
     * Workers Scripts Edit, Workers Routes Edit on the apps zone,
     * Containers Edit and Account Analytics Read. Write-only.
     */
    api_token: z.string().min(20).max(256),
    /** Defaults to the stored value, `false` the first time. */
    apps_domain_proxied: z.boolean().optional(),
  })
  .openapi("PutCloudflareSettings");

/** One check of `POST /v1/instance/cloudflare/verify`. */
export const CloudflareCheckSchema = z
  .object({
    name: z.string(),
    ok: z.boolean(),
    /** Cloudflare's error verbatim on failure. */
    message: z.string(),
  })
  .openapi("CloudflareCheck");

/** Result of `POST /v1/instance/cloudflare/verify`. */
export const CloudflareVerificationSchema = z
  .object({ ok: z.boolean(), checks: z.array(CloudflareCheckSchema) })
  .openapi("CloudflareVerification");

/** One failed eligibility rule. */
export const ProviderEligibilitySchema = z
  .object({ rule: z.enum(PROVIDER_RULES), message: z.string() })
  .openapi("ProviderEligibility");

/** A Cloudflare deployment as the status route lists it. */
export const CloudflareDeploymentSchema = z
  .object({
    id: z.string(),
    deployment_id: z.string(),
    status: z.enum([
      "pushing",
      "uploading",
      "rolling_out",
      "warming",
      "routing",
      "active",
      "removed",
      "failed",
    ]),
    image_ref: z.string(),
    image_digest: z.string().nullable(),
    instance_type: z.string(),
    max_instances: z.number().int(),
    /** Cloudflare's error, verbatim, when `failed`. */
    error: z.string().nullable(),
    created_at: Millis,
  })
  .openapi("CloudflareDeployment");

/** A service's provider status in one environment. */
export const ServiceCloudflareStatusSchema = z
  .object({
    provider: z.enum(SERVICE_PROVIDERS),
    /** Whether `cloudflare_account` is set. */
    configured: z.boolean(),
    /** Rules the latest config fails for `cloudflare`; empty when eligible. */
    eligibility: z.array(ProviderEligibilitySchema),
    /** Non-fatal: e.g. a reference to a database's DATABASE_URL, unreachable from Cloudflare. */
    warnings: z.array(z.string()),
    runtime: z
      .object({
        script_name: z.string(),
        status: z.enum(["active", "disabled"]),
        generation: z.number().int(),
        application_id: z.string().nullable(),
        /** Hostnames with a Worker route to the script. */
        routes: z.array(z.string()),
        workers_dev_url: z.string().nullable(),
        /** From `instances-v2`; `null` when Cloudflare could not be asked. */
        instances: z.object({ total: z.number().int(), running: z.number().int() }).nullable(),
        /** When the minute tick deletes the script and application. */
        delete_after: Millis.nullable(),
      })
      .nullable(),
    deployments: z.array(CloudflareDeploymentSchema),
  })
  .openapi("ServiceCloudflareStatus");

/** The Cloudflare provider settings. */
export const getInstanceCloudflare = defineRoute(sessionOnly("instance:manage"), {
  method: "get",
  path: "/v1/instance/cloudflare",
  tags: ["instance"],
  summary: "Get Cloudflare provider settings",
  security: sessionOnlyAuth,
  responses: { 200: json(CloudflareSettingsSchema), ...errors(401, 403) },
});

/**
 * Connects a Cloudflare account. The token is checked first (it must list
 * scripts and container applications and read the `workers.dev`
 * subdomain; 422 `cloudflare_account_invalid` naming Cloudflare's error),
 * then stored sealed. Audited as `instance.settings_updated`, never with
 * the token.
 */
export const putInstanceCloudflare = defineRoute(
  sessionOnly("instance:manage", ["instance.settings_updated"], { reauth: true }),
  {
    method: "put",
    path: "/v1/instance/cloudflare",
    tags: ["instance"],
    summary: "Connect a Cloudflare account",
    security: sessionOnlyAuth,
    request: body(PutCloudflareSettingsBody),
    responses: { 200: json(CloudflareSettingsSchema), ...errors(400, 401, 403, 422) },
  },
);

/** Disconnects the account; 409 while any service runs on Cloudflare. */
export const deleteInstanceCloudflare = defineRoute(
  sessionOnly("instance:manage", ["instance.settings_updated"], { reauth: true }),
  {
    method: "delete",
    path: "/v1/instance/cloudflare",
    tags: ["instance"],
    summary: "Disconnect the Cloudflare account",
    security: sessionOnlyAuth,
    responses: { 200: json(CloudflareSettingsSchema), ...errors(401, 403, 409) },
  },
);

/** Re-checks the stored token's access, one check per API the provider uses. */
export const verifyInstanceCloudflare = defineRoute(sessionOnly("instance:manage"), {
  method: "post",
  path: "/v1/instance/cloudflare/verify",
  tags: ["instance"],
  summary: "Verify the Cloudflare account",
  security: sessionOnlyAuth,
  responses: { 200: json(CloudflareVerificationSchema), ...errors(401, 403, 409) },
});

/** A service's Cloudflare provider status in one environment. */
export const getServiceCloudflare = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/services/{serviceId}/cloudflare",
  tags: ["services"],
  summary: "Get a service's Cloudflare provider status",
  security: sessionAuth,
  request: { params: ServiceParams, query: EnvironmentQuery },
  responses: { 200: json(ServiceCloudflareStatusSchema), ...errors(400, 401, 403, 404) },
});

/** Every Cloudflare provider route, by name. */
export const CLOUDFLARE_ROUTES = {
  getInstanceCloudflare,
  putInstanceCloudflare,
  deleteInstanceCloudflare,
  verifyInstanceCloudflare,
  getServiceCloudflare,
} as const;

/** Settings → Cloudflare. */
export type CloudflareSettings = z.infer<typeof CloudflareSettingsSchema>;
/** A service's provider status. */
export type ServiceCloudflareStatus = z.infer<typeof ServiceCloudflareStatusSchema>;
/** Result of verifying the account. */
export type CloudflareVerification = z.infer<typeof CloudflareVerificationSchema>;
