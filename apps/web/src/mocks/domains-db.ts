/**
 * Mock data shared by the domain handlers and the seed, kept free of imports from
 * `./db` so the seed can use it without an import cycle.
 *
 * @module
 */
import { DEFAULT_HSTS } from "@roundhouse/shared";
import type { Domain } from "../lib/api/deploy-types";
import type { Certificate, InstanceDomainSettings } from "../lib/api/tls-client";

/** Let's Encrypt's lifetime for a certificate. */
export const MOCK_CERTIFICATE_LIFETIME_MS = 90 * 86_400_000;

/**
 * Certificate state for a domain in a TLS status. An issued one is a Let's Encrypt
 * certificate issued at `issuedAt`.
 *
 * @param status - The domain's `tls_status`.
 * @param issuedAt - When an issued certificate was issued.
 * @returns The `tls` field, without per-node states.
 */
export function mockTls(status: Domain["tls_status"], issuedAt = Date.now()): Domain["tls"] {
  if (status !== "issued") {
    return {
      status,
      issuer: null,
      not_before: null,
      not_after: null,
      error: null,
      updated_at: status === "disabled" ? null : issuedAt,
      nodes: [],
    };
  }
  return {
    status,
    issuer: "Let's Encrypt R11",
    not_before: issuedAt,
    not_after: issuedAt + MOCK_CERTIFICATE_LIFETIME_MS,
    error: null,
    updated_at: issuedAt,
    nodes: [],
  };
}

/**
 * Lifecycle fields of a generated domain: verified at birth, nothing to create, the
 * default HSTS policy.
 *
 * @param tlsStatus - Its certificate status.
 * @param issuedAt - When an issued certificate was issued.
 * @returns Fresh fields to spread into a generated `Domain`.
 */
export function generatedDomainState(
  tlsStatus: Domain["tls_status"],
  issuedAt = Date.now(),
): Pick<
  Domain,
  | "status"
  | "apex"
  | "records"
  | "error"
  | "last_checked_at"
  | "next_check_at"
  | "verified_at"
  | "tls_status"
  | "wildcard"
  | "hsts"
  | "tls"
  | "routing_nodes"
> {
  return {
    status: "active",
    apex: false,
    records: [],
    error: null,
    last_checked_at: null,
    next_check_at: null,
    verified_at: null,
    tls_status: tlsStatus,
    wildcard: false,
    hsts: { ...DEFAULT_HSTS },
    tls: mockTls(tlsStatus, issuedAt),
    routing_nodes: [],
  };
}

/** The Domains & TLS settings as the mock stores them. */
export interface DbTls {
  ingress_hostname: string | null;
  acme: { directory_url: string; email: string | null; account_url: string | null };
  /** The DNS-01 zone; the token is kept to mirror the API but never returned. */
  cloudflare_dns: {
    zone_id: string;
    zone_name: string;
    api_token: string;
    updated_at: number;
  } | null;
  /**
   * Why `managed` mode can't be selected (the API derives these from its environment);
   * empty when it can. Tests fill it to see the refusal.
   */
  managed_problems: string[];
  certificates: Certificate[];
  /** How custom domains are served (ADR 0009). */
  custom_domains_mode: "direct" | "cloudflare_saas";
  /** The Cloudflare for SaaS zone; the token is kept to mirror the API but never returned. */
  saas:
    | (NonNullable<InstanceDomainSettings["custom_domains"]["saas"]> & { api_token: string })
    | null;
}

/**
 * Fresh Domains & TLS settings: Let's Encrypt, no zone, no certificates (the seed runs in
 * `acme` mode, where servers hold their own).
 *
 * @returns The settings.
 */
export function seedTls(): DbTls {
  return {
    ingress_hostname: null,
    acme: {
      directory_url: "https://acme-v02.api.letsencrypt.org/directory",
      email: null,
      account_url: null,
    },
    cloudflare_dns: null,
    managed_problems: [],
    certificates: [],
    custom_domains_mode: "direct",
    saas: null,
  };
}
