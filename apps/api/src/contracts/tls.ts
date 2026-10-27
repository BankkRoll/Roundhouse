/**
 * Settings → Domains & TLS (ADR 0009): the install's TLS prerequisites, the
 * ACME CA and contact, the DNS-01 zone (a Cloudflare token, write-only), the
 * hostname customers CNAME to, and the control plane's certificates.
 * Instance admins only, from a browser session; changes need a fresh one.
 * The TLS mode itself is still set with `PATCH /v1/instance/settings`.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import {
  body,
  errors,
  HostnameField,
  json,
  Millis,
  sessionOnlyAuth,
  TlsModeSchema,
} from "../schemas";
import { defineRoute, sessionOnly } from "./policy";

/**
 * Mirrors of `CERTIFICATE_KINDS` and `CERTIFICATE_STATUSES` in
 * `@roundhouse/db`, which the dashboard can't import; `routes/tls.ts`
 * fails the build if they drift apart.
 */
export const CERTIFICATE_KIND_VALUES = ["apps_wildcard", "generated", "custom"] as const;
/** See {@link CERTIFICATE_KIND_VALUES}. */
export const CERTIFICATE_STATUS_VALUES = ["pending", "issued", "renewing", "failed"] as const;

/** The install's custom-domain and certificate settings. */
export const InstanceDomainSettingsSchema = z
  .object({
    tls_mode: TlsModeSchema,
    apps_domain: z.string().nullable(),
    /**
     * The name customers CNAME their domains to, kept by the operator as
     * A/AAAA records of the ingress servers. Without it they CNAME to the
     * service's generated hostname.
     */
    ingress_hostname: z.string().nullable(),
    /** Servers that take HTTP traffic, across workspaces. */
    ingress_nodes: z.number().int(),
    acme: z.object({
      /** Let's Encrypt production unless changed. */
      directory_url: z.string(),
      /** Contact address given to the CA; optional. */
      email: z.string().nullable(),
      /** Set once the first order registered the account. */
      account_url: z.string().nullable(),
    }),
    /** The DNS-01 zone; the token is never returned. */
    cloudflare_dns: z
      .object({ zone_id: z.string(), zone_name: z.string(), updated_at: Millis })
      .nullable(),
    managed: z.object({
      /** Whether `tls_mode` may be set to `managed`. */
      available: z.boolean(),
      /** Why not, in words. */
      problems: z.array(z.string()),
      /**
       * The apps wildcard can be issued: the apps domain is inside the
       * Cloudflare zone. Without it each generated hostname gets its own
       * certificate, under Let's Encrypt's 50 per registered domain a week.
       */
      apps_wildcard: z.boolean(),
      /** Wildcard custom domains can be added (managed mode with DNS-01). */
      wildcard_domains: z.boolean(),
    }),
  })
  .openapi("InstanceDomainSettings");

/** Body of `PUT /v1/instance/domains`; omitted fields keep their value. */
export const PutInstanceDomainsBody = z
  .object({
    ingress_hostname: HostnameField.nullable().optional(),
    acme_directory_url: z
      .string()
      .max(2048)
      .regex(/^https:\/\/[^\s]+$/, "expected an https URL")
      .optional(),
    acme_email: z.string().email().max(254).nullable().optional(),
    /** `null` removes the zone and its token. */
    cloudflare_dns: z
      .object({
        zone_id: z.string().regex(/^[a-f0-9]{32}$/, "expected a 32-character zone ID"),
        /** Zone → DNS → Edit and Zone → Zone → Read on that zone. */
        api_token: z.string().min(20).max(256),
      })
      .nullable()
      .optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: "nothing to update" })
  .openapi("PutInstanceDomains");

/** A certificate the control plane issued (or is issuing). */
export const CertificateSchema = z
  .object({
    id: z.string(),
    /** `apps_wildcard`, `generated` (one generated hostname) or `custom`. */
    kind: z.enum(CERTIFICATE_KIND_VALUES),
    hostnames: z.array(z.string()),
    challenge: z.enum(["http-01", "dns-01"]),
    /** The domain it serves; `null` for the apps wildcard. */
    domain_id: z.string().nullable(),
    status: z.enum(CERTIFICATE_STATUS_VALUES),
    issuer: z.string().nullable(),
    not_before: Millis.nullable(),
    not_after: Millis.nullable(),
    /** When renewal starts: inside the CA's ARI window, else with a third of the lifetime left. */
    renew_after: Millis.nullable(),
    /** Why the latest attempt failed; an issued certificate keeps serving meanwhile. */
    error: z.string().nullable(),
    /** Failed attempts in a row. */
    failures: z.number().int(),
    /** Next order: a retry, the renewal, or the end of a running attempt's lease. */
    next_attempt_at: Millis.nullable(),
    /** Ingress servers that confirmed loading the current chain, of those sent it. */
    nodes: z.object({ acked: z.number().int(), sent: z.number().int() }),
    updated_at: Millis,
  })
  .openapi("Certificate");

/** The Domains & TLS settings. */
export const getInstanceDomains = defineRoute(sessionOnly("instance:manage"), {
  method: "get",
  path: "/v1/instance/domains",
  tags: ["instance"],
  summary: "Get domain and TLS settings",
  security: sessionOnlyAuth,
  responses: { 200: json(InstanceDomainSettingsSchema), ...errors(401, 403) },
});

/**
 * Changes the Domains & TLS settings. A Cloudflare token is checked against
 * the zone first (422 `cloudflare_dns_invalid`) and stored sealed. A new CA
 * directory starts a new account at the next order. Audited as
 * `instance.settings_updated`, never with a token.
 */
export const putInstanceDomains = defineRoute(
  sessionOnly("instance:manage", ["instance.settings_updated"], { reauth: true }),
  {
    method: "put",
    path: "/v1/instance/domains",
    tags: ["instance"],
    summary: "Update domain and TLS settings",
    security: sessionOnlyAuth,
    request: body(PutInstanceDomainsBody),
    responses: { 200: json(InstanceDomainSettingsSchema), ...errors(400, 401, 403, 422) },
  },
);

/** Every control-plane certificate, apps wildcard first, then by first hostname. */
export const listCertificates = defineRoute(sessionOnly("instance:manage"), {
  method: "get",
  path: "/v1/instance/certificates",
  tags: ["instance"],
  summary: "List certificates",
  security: sessionOnlyAuth,
  responses: {
    200: json(z.object({ certificates: z.array(CertificateSchema) })),
    ...errors(401, 403),
  },
});

/** Every Domains & TLS route, by name. */
export const TLS_ROUTES = { getInstanceDomains, putInstanceDomains, listCertificates } as const;

/** The Domains & TLS settings. */
export type InstanceDomainSettings = z.infer<typeof InstanceDomainSettingsSchema>;
/** A control-plane certificate. */
export type Certificate = z.infer<typeof CertificateSchema>;
