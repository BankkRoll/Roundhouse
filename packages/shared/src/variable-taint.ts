/**
 * Secret taint: which plain variables would carry a secret once resolved.
 *
 * A plain value such as `postgres://app:${{db.PASSWORD}}@db` holds no
 * secret itself, but its resolved form does. Anything that hands resolved
 * plain values to a client (the CLI's `run`, build args) must treat such a
 * variable as secret. See ADR 0014, "A value derived from a secret is a
 * secret".
 *
 * @module
 */
import { parseReferences, SHARED_NAMESPACE } from "./variables";

/** Raw values and secret keys of one environment. */
export interface TaintInput {
  /** Raw values of every service's variables, by service slug. */
  services: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Raw values of the environment's shared variables. */
  shared: Readonly<Record<string, string>>;
  /** Keys stored with tier `secret`, by service slug. */
  secretServiceKeys: Readonly<Record<string, readonly string[]>>;
  /** Shared keys stored with tier `secret`. */
  secretSharedKeys: readonly string[];
}

/** Plain variables whose resolution reaches a secret. */
export interface TaintResult {
  /** Tainted plain keys by service slug; services with none are omitted. */
  services: Record<string, string[]>;
  /** Tainted plain shared keys. */
  shared: string[];
}

/**
 * Finds every plain variable that references a secret, directly or through
 * other variables. References to built-ins, unknown variables and cycles do
 * not taint (resolution reports those separately). Runs in O(total size of
 * the values).
 *
 * @param input - The environment's raw values and secret keys.
 * @returns Tainted plain keys, sorted.
 * @example
 * secretDerivedVariables({
 *   services: { api: { URL: "pg://u:${{db.PASSWORD}}@db" }, db: { PASSWORD: "x" } },
 *   shared: {},
 *   secretServiceKeys: { db: ["PASSWORD"] },
 *   secretSharedKeys: [],
 * });
 * // { services: { api: ["URL"] }, shared: [] }
 */
export function secretDerivedVariables(input: TaintInput): TaintResult {
  const secret = new Set<string>();
  for (const [slug, keys] of Object.entries(input.secretServiceKeys)) {
    for (const k of keys) secret.add(`${slug}.${k}`);
  }
  for (const k of input.secretSharedKeys) secret.add(`${SHARED_NAMESPACE}.${k}`);

  const raw = (ns: string, name: string): string | undefined => {
    if (ns === SHARED_NAMESPACE) {
      return Object.hasOwn(input.shared, name) ? input.shared[name] : undefined;
    }
    const vars = input.services[ns];
    return vars && Object.hasOwn(vars, name) ? vars[name] : undefined;
  };

  const memo = new Map<string, boolean>();
  const onStack = new Set<string>();
  const tainted = (ns: string, name: string): boolean => {
    const id = `${ns}.${name}`;
    if (secret.has(id)) return true;
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const value = raw(ns, name);
    if (value === undefined || onStack.has(id)) return false;
    onStack.add(id);
    let result = false;
    for (const ref of parseReferences(value).references) {
      if (tainted(ref.namespace ?? ns, ref.name)) {
        result = true;
        break;
      }
    }
    onStack.delete(id);
    memo.set(id, result);
    return result;
  };

  const out: TaintResult = { services: {}, shared: [] };
  for (const [slug, vars] of Object.entries(input.services)) {
    const keys = Object.keys(vars)
      .filter((k) => !secret.has(`${slug}.${k}`) && tainted(slug, k))
      .sort();
    if (keys.length) out.services[slug] = keys;
  }
  out.shared = Object.keys(input.shared)
    .filter((k) => !secret.has(`${SHARED_NAMESPACE}.${k}`) && tainted(SHARED_NAMESPACE, k))
    .sort();
  return out;
}
