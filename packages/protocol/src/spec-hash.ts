/**
 * Canonical JSON and the workload spec hash. Go's `CanonicalJSON` and
 * `SpecHash` implement the same rules; `fixtures/spec-hash.json` holds cases
 * both test suites must reproduce exactly.
 *
 * Canonical form:
 * - object members sorted by key, comparing UTF-16 code units;
 * - members whose value is `null` or `undefined` omitted;
 * - arrays keep their order;
 * - numbers must be safe integers and print in decimal;
 * - strings escape only `"`, `\` and U+0000–U+001F (as `\u00xx`, lowercase);
 *   everything else, including U+2028/U+2029, is literal UTF-8;
 * - no whitespace.
 *
 * Integers only, and escaping fixed by hand, because JavaScript's and Go's
 * JSON encoders disagree on floats, HTML characters, and line separators.
 *
 * @module
 */
import type { WorkloadSpec } from "./workload";

/**
 * Fields left out of the hash: they are applied without recreating the
 * container (routes via Caddy, drain on the next switch, the rollout order
 * and stop grace of the next replacement, nftables for
 * `publish_allowed_cidrs` and `mesh_ip`, upstream DNS for `upstreams`), or
 * rotate often (short-lived registry credentials, and `env_sealed`, which is
 * re-sealed for every frame; the environment it carries is fixed per
 * workload ID). `mounts`, `private_dns` and `ports[].publish` are hashed:
 * they change the container.
 */
export const SPEC_HASH_EXCLUDED_FIELDS = [
  "spec_hash",
  "routes",
  "registry_auth",
  "drain_s",
  "env_sealed",
  "rollout",
  "stop_grace_s",
  "publish_allowed_cidrs",
  "mesh_ip",
  "upstreams",
] as const;

const encoder = new TextEncoder();

function escapeString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    const code = value.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Serialises a JSON-compatible value in canonical form (see the module docs).
 *
 * @param value - Plain data: objects, arrays, strings, safe integers, booleans, null.
 * @returns The canonical JSON text.
 * @throws When the value contains a non-integer number or a non-plain value.
 * @example
 * canonicalJson({ b: 1, a: [true, null], c: null }); // '{"a":[true,null],"b":1}'
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return escapeString(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new TypeError(`non-integer number ${value}`);
      return Object.is(value, -0) ? "0" : String(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
      }
      const members = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined)
        .sort(([a], [b]) => compareCodeUnits(a, b))
        .map(([k, v]) => `${escapeString(k)}:${canonicalJson(v)}`);
      return `{${members.join(",")}}`;
    }
    default:
      throw new TypeError(`cannot canonicalise ${typeof value}`);
  }
}

/**
 * Returns the canonical text a spec hash is computed over: the spec without
 * {@link SPEC_HASH_EXCLUDED_FIELDS}.
 *
 * @param spec - Workload spec; `spec_hash` may be absent or stale.
 * @returns Canonical JSON of the hashed fields.
 */
export function specHashInput(spec: Omit<WorkloadSpec, "spec_hash"> | WorkloadSpec): string {
  const copy: Record<string, unknown> = { ...spec };
  for (const field of SPEC_HASH_EXCLUDED_FIELDS) delete copy[field];
  return canonicalJson(copy);
}

/**
 * Computes a workload's `spec_hash`: lowercase hex SHA-256 of
 * {@link specHashInput}. Go's `SpecHash` returns the same value.
 *
 * @param spec - Workload spec; any existing `spec_hash` is ignored.
 * @returns 64 lowercase hex characters.
 * @example
 * const spec_hash = await computeSpecHash(specWithoutHash);
 */
export async function computeSpecHash(
  spec: Omit<WorkloadSpec, "spec_hash"> | WorkloadSpec,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(specHashInput(spec)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
