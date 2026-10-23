/**
 * Mock data shared by the domain handlers and the seed, kept free of imports so the
 * seed can use it without an import cycle through `./db`.
 *
 * @module
 */
import type { Domain } from "../lib/api/deploy-types";

/**
 * Lifecycle fields of a generated domain: verified at birth, nothing to create.
 *
 * @returns Fresh fields to spread into a generated `Domain`.
 */
export function generatedDomainState(): Pick<
  Domain,
  "status" | "apex" | "records" | "error" | "last_checked_at" | "next_check_at" | "verified_at"
> {
  return {
    status: "active",
    apex: false,
    records: [],
    error: null,
    last_checked_at: null,
    next_check_at: null,
    verified_at: null,
  };
}
