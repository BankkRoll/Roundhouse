/**
 * Control-plane certificates and ingress settings (ADR 0009), from
 * `CERTS_PROTOCOL_VERSION`. In `managed` TLS mode the control plane issues
 * every certificate and ships it to each ingress node: a small manifest in
 * `desired_state.certificates`, bodies in `cert_sync` with the private key
 * sealed to the node. In `acme` mode Caddy still issues on demand, and
 * `cert_status` reports the outcome. Mirrored by `go/certs.go`.
 *
 * @module
 */
import { z } from "zod";
import { SealedBoxSchema } from "./box";
import { ControlHeader, isShortLived, SHORT_LIVED_ISSUE } from "./control";
import {
  boundedString,
  CidrString,
  IdString,
  MAX_CERT_HOSTNAMES,
  MAX_CERT_IDS_PER_FRAME,
  MAX_CERT_PEM_BYTES,
  MAX_CERT_UPSERTS_PER_FRAME,
  MAX_CERTIFICATES_PER_NODE,
  MAX_INGRESS_SOURCES,
  MAX_MANAGED_HOSTS,
  MAX_MESSAGE_BYTES,
  RouteHostnameString,
  Sha256Hex,
  UnixMillis,
} from "./limits";

/** A certificate an ingress node must hold, in `desired_state.certificates`. */
export const CertificateRefSchema = z.object({
  id: IdString,
  /** Hex SHA-256 of `cert_pem`; a mismatch makes the agent send `cert_request`. */
  sha256: Sha256Hex,
  not_after: UnixMillis,
});

/** A certificate an ingress node must hold. */
export type CertificateRef = z.infer<typeof CertificateRefSchema>;

/** `desired_state.certificates`: distinct IDs. */
export const CertificateManifestSchema = z
  .array(CertificateRefSchema)
  .max(MAX_CERTIFICATES_PER_NODE)
  .refine((cs) => new Set(cs.map((c) => c.id)).size === cs.length, {
    message: "duplicate certificate",
  });

/** `desired_state.ingress`: node-level Caddy settings beyond routes. */
export const IngressSettingsSchema = z.object({
  /**
   * Where Caddy proxies `/.well-known/acme-challenge/*` for managed hosts,
   * with the `Host` header to send; `null` outside `managed` mode.
   */
  acme_challenge_upstream: z
    .object({
      url: z
        .string()
        .max(2048)
        .regex(/^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/, "expected an https URL"),
      host: z
        .string()
        .max(253)
        .regex(/^[a-z0-9.-]+$/, "expected a hostname"),
    })
    .nullable(),
  /**
   * `ingress_firewall: "cloudflare_only"`: sources admitted to 80/443, with a
   * final drop for the rest. `null` admits everyone.
   */
  allowed_sources: z.array(CidrString).min(1).max(MAX_INGRESS_SOURCES).nullable(),
  /** Hosts kept out of Caddy's own automation (`automatic_https.skip_certificates`). */
  managed_hosts: z.array(RouteHostnameString).max(MAX_MANAGED_HOSTS),
});

/** `desired_state.ingress`. */
export type IngressSettings = z.infer<typeof IngressSettingsSchema>;

/** One certificate body. */
export const CertUpsertSchema = z.object({
  id: IdString,
  hostnames: z.array(RouteHostnameString).min(1).max(MAX_CERT_HOSTNAMES),
  /** Leaf first, then intermediates. */
  cert_pem: boundedString(MAX_CERT_PEM_BYTES, 1).refine(
    (p) => p.startsWith("-----BEGIN CERTIFICATE-----"),
    { message: "expected a PEM certificate chain" },
  ),
  /** Hex SHA-256 of `cert_pem`, as in the manifest. */
  sha256: Sha256Hex,
  /** `SealedCertKeySchema`, AAD `certKeyAad(node, id, sha256)`. */
  key_sealed: SealedBoxSchema,
  not_after: UnixMillis,
});

/** One certificate body. */
export type CertUpsert = z.infer<typeof CertUpsertSchema>;

/**
 * Certificate bodies for an ingress node. Credential-bearing whenever it has
 * upserts (sealed private keys).
 */
export const CertSyncSchema = z
  .object({
    type: z.literal("cert_sync"),
    ...ControlHeader,
    upserts: z.array(CertUpsertSchema).max(MAX_CERT_UPSERTS_PER_FRAME),
    removes: z.array(IdString).max(MAX_CERT_IDS_PER_FRAME),
  })
  .refine(
    (m) =>
      new Set([...m.upserts.map((u) => u.id), ...m.removes]).size ===
      m.upserts.length + m.removes.length,
    {
      message: "a certificate appears twice",
    },
  )
  .refine((m) => m.upserts.length === 0 || isShortLived(m), SHORT_LIVED_ISSUE);

/** Certificate bodies for an ingress node. */
export type CertSync = z.infer<typeof CertSyncSchema>;

/** Certificates written to disk and loaded, answering `cert_sync`. */
export const CertAckSchema = z.object({
  type: z.literal("cert_ack"),
  ids: z.array(IdString).min(1).max(MAX_CERT_IDS_PER_FRAME),
});

/** Certificates written and loaded. */
export type CertAck = z.infer<typeof CertAckSchema>;

/** Manifest entries the agent lacks or holds with another digest; answered by `cert_sync`. */
export const CertRequestSchema = z.object({
  type: z.literal("cert_request"),
  ids: z.array(IdString).min(1).max(MAX_CERTIFICATES_PER_NODE),
});

/** Certificates the agent lacks. */
export type CertRequest = z.infer<typeof CertRequestSchema>;

/** On-demand issuance outcomes Caddy reports in `acme` mode. */
export const CERT_STATES = ["issued", "failed", "pending"] as const;

/** Caddy's on-demand issuance outcome for one hostname (`acme` mode). */
export const CertStatusSchema = z
  .object({
    type: z.literal("cert_status"),
    hostname: RouteHostnameString,
    state: z.enum(CERT_STATES),
    /** The issuing CA, e.g. `acme-v02.api.letsencrypt.org`. */
    issuer: boundedString(256).optional(),
    not_after: UnixMillis.optional(),
    /** From Caddy's `tls` logger. */
    error: boundedString(MAX_MESSAGE_BYTES, 1).optional(),
  })
  .refine((s) => (s.state === "failed") === (s.error !== undefined), {
    message: "exactly failed states carry an error",
    path: ["error"],
  });

/** Caddy's on-demand issuance outcome. */
export type CertStatus = z.infer<typeof CertStatusSchema>;
