/**
 * Mock data shared by the domain handlers and the seed, kept free of imports from
 * `./db` so the seed can use it without an import cycle.
 *
 * @module
 */
import { DEFAULT_HSTS } from "@roundhouse/shared";
import type { Domain } from "../lib/api/deploy-types";

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
