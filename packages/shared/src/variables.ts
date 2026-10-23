/**
 * Variable references: parsing `${{…}}` in values, resolving a service's
 * environment at deploy time, and the service dependency graph references
 * imply (drawn as edges on the project canvas).
 *
 * Syntax, inside any variable value:
 * - `${{api.DATABASE_URL}}`: variable `DATABASE_URL` of the service with slug `api`,
 *   or one of its built-ins (`${{db.ROUNDHOUSE_PRIVATE_DOMAIN}}`);
 * - `${{shared.REGION}}`: shared variable `REGION` of the environment;
 * - `${{PORT}}`: a variable of the same service (or of `shared`, inside a
 *   shared value), falling back to the service's built-ins;
 * - `$${{` writes a literal `${{`.
 *
 * Whitespace inside the braces is ignored. Everything here is pure; the API
 * decrypts values before calling in and encrypts nothing.
 *
 * @module
 */

/** Variables the control plane injects into every service. */
export const BUILTIN_VARIABLES = [
  "PORT",
  "ROUNDHOUSE_PUBLIC_DOMAIN",
  "ROUNDHOUSE_PRIVATE_DOMAIN",
  "ROUNDHOUSE_ENVIRONMENT",
  "ROUNDHOUSE_GIT_COMMIT_SHA",
  "ROUNDHOUSE_SERVICE_NAME",
  "ROUNDHOUSE_DEPLOYMENT_ID",
] as const;

/** A built-in variable name; see {@link BUILTIN_VARIABLES}. */
export type BuiltinVariable = (typeof BUILTIN_VARIABLES)[number];

/** Reference namespace for shared variables. Services may not use it as a slug. */
export const SHARED_NAMESPACE = "shared";

/** Longest resolved value, in UTF-8 bytes. Matches the protocol's env value limit. */
export const MAX_RESOLVED_VALUE_BYTES = 32 * 1024;

/** Valid variable name: a POSIX-portable environment variable name. */
export const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const REFERENCE_BODY_RE = /^(?:([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.)?([A-Za-z_][A-Za-z0-9_]*)$/;

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

/** One `${{…}}` reference found in a value. */
export interface VariableReference {
  /** Service slug or `shared`; `null` for an unqualified `${{NAME}}`. */
  namespace: string | null;
  name: string;
  /** Offset of `$` in the value, in UTF-16 code units. */
  start: number;
  /** Offset just past the closing `}}`. */
  end: number;
}

/** A piece of a parsed value: literal text, or a reference to substitute. */
export type ValueSegment =
  | { type: "text"; text: string }
  | { type: "reference"; reference: VariableReference };

/** Codes of every error parsing or resolving can report. */
export type VariableErrorCode =
  | "malformed_reference"
  | "unclosed_reference"
  | "unknown_service"
  | "unknown_variable"
  | "cycle"
  | "value_too_large";

/** A syntax error in a value, with the offending span. */
export interface ReferenceSyntaxError {
  code: "malformed_reference" | "unclosed_reference";
  message: string;
  start: number;
  end: number;
}

/** Result of {@link parseReferences}. */
export interface ParsedValue {
  /** Text and references in order. Escapes are already unescaped in text. */
  segments: ValueSegment[];
  /** Just the references, in order. */
  references: VariableReference[];
  /** Syntax errors; malformed tokens are kept as literal text in `segments`. */
  errors: ReferenceSyntaxError[];
}

/**
 * Splits a value into literal text and references.
 *
 * @param value - A raw variable value.
 * @returns Segments, references and syntax errors with their positions.
 * @example
 * parseReferences("postgres://${{db.HOST}}:5432").references;
 * // [{ namespace: "db", name: "HOST", start: 11, end: 23 }]
 */
export function parseReferences(value: string): ParsedValue {
  const segments: ValueSegment[] = [];
  const references: VariableReference[] = [];
  const errors: ReferenceSyntaxError[] = [];
  let text = "";
  const flush = () => {
    if (text) segments.push({ type: "text", text });
    text = "";
  };

  let i = 0;
  while (i < value.length) {
    if (value.startsWith("$${{", i)) {
      text += "${{";
      i += 4;
      continue;
    }
    if (!value.startsWith("${{", i)) {
      text += value[i];
      i++;
      continue;
    }
    const close = value.indexOf("}}", i + 3);
    if (close === -1) {
      errors.push({
        code: "unclosed_reference",
        message: "Reference is missing its closing }}",
        start: i,
        end: value.length,
      });
      text += value.slice(i);
      break;
    }
    const end = close + 2;
    const match = REFERENCE_BODY_RE.exec(value.slice(i + 3, close).trim());
    if (!match) {
      errors.push({
        code: "malformed_reference",
        message: `Invalid reference ${value.slice(i, end)}; expected \${{service.NAME}}, \${{shared.NAME}} or \${{NAME}}`,
        start: i,
        end,
      });
      text += value.slice(i, end);
    } else {
      flush();
      const reference: VariableReference = {
        namespace: match[1] ?? null,
        name: match[2]!,
        start: i,
        end,
      };
      segments.push({ type: "reference", reference });
      references.push(reference);
    }
    i = end;
  }
  flush();
  return { segments, references, errors };
}

// -----------------------------------------------------------------------------
// Resolution
// -----------------------------------------------------------------------------

/** Everything needed to build one service's environment. */
export interface ResolveVariablesInput {
  /** Slug of the service whose environment is being built. */
  service: string;
  /** Decrypted, unresolved variables of every service in the environment, by slug. */
  services: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Decrypted, unresolved shared variables of the environment. */
  shared: Readonly<Record<string, string>>;
  /** Built-in values of every service, by slug. Used verbatim, never parsed. */
  builtins: Readonly<Record<string, Readonly<Partial<Record<BuiltinVariable, string>>>>>;
}

/** Where in which value a resolution error was found. */
export interface VariableError {
  code: VariableErrorCode;
  message: string;
  /** The variable whose value contains the problem. */
  variable: { namespace: string; name: string };
  /** Span of the offending reference within that value, when there is one. */
  start?: number;
  end?: number;
  /** For `cycle`: the variables involved, as `namespace.NAME`, ending where it started. */
  cycle?: string[];
}

/** Result of {@link resolveVariables}. */
export type ResolveVariablesResult =
  | { ok: true; env: Record<string, string> }
  | { ok: false; errors: VariableError[] };

const utf8Length = (s: string): number => {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
};

/**
 * Builds the final environment of one service: its built-ins, overlaid by its
 * own variables with every reference substituted. Only references reachable
 * from the service's own variables are resolved, so a broken variable on
 * another service does not block this one.
 *
 * Algorithm: depth-first substitution with memoisation. A reference to a
 * variable already on the stack is a cycle. Values are bounded by
 * {@link MAX_RESOLVED_VALUE_BYTES} during substitution, so a chain of values
 * that each double their input fails fast instead of exhausting memory.
 * Runs in O(total size of the reachable values).
 *
 * @param input - The service and every value it may reference.
 * @returns The environment, or every error found.
 * @example
 * resolveVariables({
 *   service: "api",
 *   services: { api: { DB: "${{db.ROUNDHOUSE_PRIVATE_DOMAIN}}" }, db: {} },
 *   shared: {},
 *   builtins: { api: { PORT: "8080" }, db: { ROUNDHOUSE_PRIVATE_DOMAIN: "db.internal" } },
 * });
 * // { ok: true, env: { PORT: "8080", DB: "db.internal" } }
 */
export function resolveVariables(input: ResolveVariablesInput): ResolveVariablesResult {
  const { services, shared, builtins } = input;
  const errors: VariableError[] = [];
  const memo = new Map<string, string | null>();
  const stack: string[] = [];
  const keyOf = (ns: string, name: string) => `${ns}.${name}`;

  const knownNamespace = (ns: string) =>
    ns === SHARED_NAMESPACE || Object.hasOwn(services, ns) || Object.hasOwn(builtins, ns);

  // Own variables shadow built-ins; shared has no built-ins.
  const lookup = (ns: string, name: string): { raw: string; literal: boolean } | undefined => {
    if (ns === SHARED_NAMESPACE) {
      return Object.hasOwn(shared, name) ? { raw: shared[name]!, literal: false } : undefined;
    }
    const own = services[ns];
    if (own && Object.hasOwn(own, name)) return { raw: own[name]!, literal: false };
    const builtin = builtins[ns];
    if (builtin && Object.hasOwn(builtin, name)) {
      const raw = builtin[name as BuiltinVariable];
      if (raw !== undefined) return { raw, literal: true };
    }
    return undefined;
  };

  const resolve = (ns: string, name: string): string | null => {
    const key = keyOf(ns, name);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const found = lookup(ns, name)!;
    if (found.literal) {
      memo.set(key, found.raw);
      return found.raw;
    }

    stack.push(key);
    const variable = { namespace: ns, name };
    const parsed = parseReferences(found.raw);
    let failed = parsed.errors.length > 0;
    for (const e of parsed.errors) errors.push({ ...e, variable });

    let out = "";
    for (const segment of parsed.segments) {
      if (segment.type === "text") {
        out += segment.text;
      } else {
        const ref = segment.reference;
        const span = { start: ref.start, end: ref.end };
        const target = ref.namespace ?? ns;
        if (!knownNamespace(target)) {
          errors.push({
            code: "unknown_service",
            message: `No service "${target}" in this environment`,
            variable,
            ...span,
          });
          failed = true;
          continue;
        }
        if (!lookup(target, ref.name)) {
          errors.push({
            code: "unknown_variable",
            message: `${keyOf(target, ref.name)} is not defined`,
            variable,
            ...span,
          });
          failed = true;
          continue;
        }
        const targetKey = keyOf(target, ref.name);
        const loopAt = stack.indexOf(targetKey);
        if (loopAt !== -1) {
          const cycle = [...stack.slice(loopAt), targetKey];
          errors.push({
            code: "cycle",
            message: `Variables reference each other in a loop: ${cycle.join(" → ")}`,
            variable,
            ...span,
            cycle,
          });
          failed = true;
          continue;
        }
        const value = resolve(target, ref.name);
        if (value === null) failed = true;
        else out += value;
      }
      // UTF-16 length never exceeds UTF-8 length, so this is a safe early exit.
      if (!failed && out.length > MAX_RESOLVED_VALUE_BYTES) break;
    }
    stack.pop();

    if (!failed && utf8Length(out) > MAX_RESOLVED_VALUE_BYTES) {
      errors.push({
        code: "value_too_large",
        message: `${key} resolves to more than ${MAX_RESOLVED_VALUE_BYTES} bytes`,
        variable,
      });
      failed = true;
    }
    const result = failed ? null : out;
    memo.set(key, result);
    return result;
  };

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(builtins[input.service] ?? {})) {
    if (value !== undefined) env[name] = value;
  }
  for (const name of Object.keys(services[input.service] ?? {})) {
    const value = resolve(input.service, name);
    if (value !== null) env[name] = value;
  }
  return errors.length ? { ok: false, errors } : { ok: true, env };
}

// -----------------------------------------------------------------------------
// Dependency graph
// -----------------------------------------------------------------------------

/** A service whose variables reference another service (or `shared`). */
export interface ServiceDependency {
  /** Slug of the referencing service. */
  from: string;
  /** Slug of the referenced service, or `shared`. */
  to: string;
  /** Referenced variables as `namespace.NAME`, sorted and unique. */
  variables: string[];
}

/**
 * Lists which services reference which, from raw (unresolved) values. Used to
 * draw edges on the project canvas; self-references are left out, and
 * malformed references are ignored.
 *
 * @param services - Raw variables of every service, by slug.
 * @returns One entry per (from, to) pair, sorted by `from` then `to`.
 * @example
 * variableDependencies({ api: { DB: "${{db.URL}}" }, db: {} });
 * // [{ from: "api", to: "db", variables: ["db.URL"] }]
 */
export function variableDependencies(
  services: Readonly<Record<string, Readonly<Record<string, string>>>>,
): ServiceDependency[] {
  const edges = new Map<string, { from: string; to: string; variables: Set<string> }>();
  for (const [from, vars] of Object.entries(services)) {
    for (const value of Object.values(vars)) {
      for (const ref of parseReferences(value).references) {
        if (ref.namespace === null || ref.namespace === from) continue;
        const id = `${from}\0${ref.namespace}`;
        let edge = edges.get(id);
        if (!edge) {
          edge = { from, to: ref.namespace, variables: new Set() };
          edges.set(id, edge);
        }
        edge.variables.add(`${ref.namespace}.${ref.name}`);
      }
    }
  }
  const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...edges.values()]
    .map((e) => ({ from: e.from, to: e.to, variables: [...e.variables].sort(byString) }))
    .sort((a, b) => byString(a.from, b.from) || byString(a.to, b.to));
}
