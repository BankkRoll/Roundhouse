/**
 * Control-plane TLS (ADR 0009): certificates the control plane issues in the
 * `managed` TLS mode, the ACME challenges it is answering, which ingress
 * nodes hold which certificate, and the per-node certificate reports agents
 * send in the `acme` mode.
 *
 * @module
 */
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { id, json, timestamp, timestamps } from "./columns";
import { domains } from "./deployments";
import { nodes } from "./nodes";
import type { SealedValue } from "./projects";

/**
 * What a certificate covers:
 * - `apps_wildcard`: `*.<apps_domain>`, every generated hostname at once (DNS-01);
 * - `generated`: one generated hostname, when the apps domain's DNS isn't
 *   writable and the wildcard can't be issued;
 * - `custom`: one custom domain (HTTP-01, or DNS-01 delegation for a wildcard).
 */
export const CERTIFICATE_KINDS = ["apps_wildcard", "generated", "custom"] as const;

/** A certificate kind; see {@link CERTIFICATE_KINDS}. */
export type CertificateKind = (typeof CERTIFICATE_KINDS)[number];

/**
 * - `pending`: never issued; an order is running or waits for a retry.
 * - `issued`: `chain_pem` and `key_sealed` are current.
 * - `renewing`: still serving the issued chain while a renewal order runs.
 * - `failed`: the last order failed and nothing valid is held; retried later.
 */
export const CERTIFICATE_STATUSES = ["pending", "issued", "renewing", "failed"] as const;

/** A certificate status; see {@link CERTIFICATE_STATUSES}. */
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

/** ACME challenge types the control plane answers. */
export const ACME_CHALLENGE_TYPES = ["http-01", "dns-01"] as const;

/** An ACME challenge type; see {@link ACME_CHALLENGE_TYPES}. */
export type AcmeChallengeType = (typeof ACME_CHALLENGE_TYPES)[number];

/** A certificate the control plane issues and ships to ingress nodes. */
export const certificates = sqliteTable(
  "certificates",
  {
    id: id(),
    /** Names on the certificate, first one the CN; at most one is a wildcard. */
    hostnames: json<string[]>("hostnames").notNull(),
    kind: text("kind").$type<CertificateKind>().notNull(),
    challenge: text("challenge").$type<AcmeChallengeType>().notNull(),
    /** The domain it serves; `null` for the apps wildcard. Removing the domain removes it. */
    domainId: text("domain_id").references(() => domains.id, { onDelete: "cascade" }),
    status: text("status").$type<CertificateStatus>().notNull().default("pending"),
    /** The PKCS#8 PEM private key, sealed under the KEK with AAD `certificate:v2:<id>`. */
    keySealed: json<SealedValue>("key_sealed"),
    /**
     * The key of the order being finalized, sealed the same way. Kept apart
     * so a renewal never touches the key still serving, and so a retried
     * finalize reuses the key its CSR named.
     */
    pendingKeySealed: json<SealedValue>("pending_key_sealed"),
    /** Leaf first, then intermediates, exactly as shipped in `cert_sync`. */
    chainPem: text("chain_pem"),
    /** Hex SHA-256 of `chain_pem`, as in the nodes' manifests. */
    sha256: text("sha256"),
    issuer: text("issuer"),
    notBefore: timestamp("not_before"),
    notAfter: timestamp("not_after"),
    /** When the renewal starts: inside the CA's ARI window, else at two thirds of the lifetime. */
    renewAfter: timestamp("renew_after"),
    /** RFC 9773 certificate ID of the current chain, sent as `replaces` on renewal. */
    ariCertId: text("ari_cert_id"),
    /** The order the latest attempt placed. */
    orderUrl: text("order_url"),
    /** Why the latest attempt failed, in words safe to show the domain's owner. */
    error: text("error"),
    /** Orders placed; also numbers the workflow instances (`<id>-<attempt>`). */
    attempts: integer("attempts").notNull().default(0),
    /** Orders failed in a row; spaces out the retries. */
    failures: integer("failures").notNull().default(0),
    /**
     * When the minute tick starts the next order: a retry, the renewal
     * (`renew_after`), or, while an order runs, the end of its lease, after
     * which a stalled order is started again.
     */
    nextAttemptAt: timestamp("next_attempt_at"),
    ...timestamps,
  },
  (t) => [
    index("certificates_domain_idx").on(t.domainId),
    index("certificates_next_attempt_idx").on(t.nextAttemptAt),
    index("certificates_renew_after_idx").on(t.renewAfter),
  ],
);

/**
 * A challenge the control plane is answering: HTTP-01 key authorizations
 * served at `GET /v1/acme/http-01/{token}`, and DNS-01 TXT records it wrote
 * through the Cloudflare DNS API and must delete.
 */
export const acmeChallenges = sqliteTable(
  "acme_challenges",
  {
    token: text("token").primaryKey(),
    /** HTTP-01: the response body. DNS-01: the TXT value. */
    keyAuthorization: text("key_authorization").notNull(),
    certificateId: text("certificate_id")
      .notNull()
      .references(() => certificates.id, { onDelete: "cascade" }),
    type: text("type").$type<AcmeChallengeType>().notNull(),
    /** DNS-01: where the TXT record was written, and its Cloudflare record ID. */
    dnsName: text("dns_name"),
    dnsRecordId: text("dns_record_id"),
    expiresAt: timestamp("expires_at").notNull(),
    ...timestamps,
  },
  (t) => [
    index("acme_challenges_certificate_idx").on(t.certificateId),
    index("acme_challenges_expires_idx").on(t.expiresAt),
  ],
);

/** Which chain of a certificate an ingress node was sent, and whether it confirmed loading it. */
export const certificateDeployments = sqliteTable(
  "certificate_deployments",
  {
    certificateId: text("certificate_id")
      .notNull()
      .references(() => certificates.id, { onDelete: "cascade" }),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    /** Digest of the chain last sent; an ack confirms this one. */
    sha256: text("sha256").notNull(),
    sentAt: timestamp("sent_at").notNull(),
    ackedAt: timestamp("acked_at"),
  },
  (t) => [
    primaryKey({ columns: [t.certificateId, t.nodeId] }),
    index("certificate_deployments_node_idx").on(t.nodeId),
  ],
);

/** On-demand issuance states agents report in `cert_status`. */
export const DOMAIN_TLS_REPORT_STATES = ["issued", "failed", "pending"] as const;

/** A reported state; see {@link DOMAIN_TLS_REPORT_STATES}. */
export type DomainTlsReportState = (typeof DOMAIN_TLS_REPORT_STATES)[number];

/**
 * The latest `cert_status` one node sent for one domain (`acme` mode, where
 * each node's Caddy issues its own certificate). A domain's `tls_*` columns
 * summarise the reports of the nodes that serve it.
 */
export const domainTlsReports = sqliteTable(
  "domain_tls_reports",
  {
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    state: text("state").$type<DomainTlsReportState>().notNull(),
    issuer: text("issuer"),
    notAfter: timestamp("not_after"),
    error: text("error"),
    reportedAt: timestamp("reported_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.domainId, t.nodeId] })],
);
