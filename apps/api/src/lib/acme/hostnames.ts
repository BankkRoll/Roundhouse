/**
 * Validation of the DNS identifiers that go into ACME orders and CSRs.
 *
 * @module
 */

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Lowercases, validates and de-duplicates hostnames for an order or CSR,
 * keeping the first occurrence's position.
 *
 * Names must be ASCII (IDNs in their `xn--` form), at most 253 characters,
 * with at least two labels; a wildcard is allowed only as the whole leftmost
 * label (`*.example.com`).
 *
 * @param hostnames - The requested names.
 * @returns The normalised, unique names.
 * @throws {Error} When the list is empty or a name is invalid.
 * @example
 * normalizeHostnames(["Example.com", "*.example.com", "example.com"]);
 * // ["example.com", "*.example.com"]
 */
export function normalizeHostnames(hostnames: readonly string[]): string[] {
  if (hostnames.length === 0) throw new Error("at least one hostname is required");
  const out: string[] = [];
  for (const raw of hostnames) {
    const name = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!isValidHostname(name)) throw new Error(`invalid hostname: ${JSON.stringify(raw)}`);
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Whether `name` (already lowercase) is a valid ACME DNS identifier.
 *
 * @param name - The candidate.
 * @returns `true` when valid.
 */
export function isValidHostname(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false;
  const labels = name.split(".");
  if (labels.length < 2) return false;
  return labels.every((label, i) => (i === 0 && label === "*") || LABEL.test(label));
}
