/**
 * Templates (ADR 0012 section 2): a versioned manifest describing one or more
 * services, their config and variables, validated with {@link TemplateSchema}
 * and turned into concrete services by {@link renderTemplate}.
 *
 * Responsibilities:
 * - the manifest shape (`schema_version: 1`), shared by the built-in
 *   catalogue, the API and any later published workspace templates;
 * - cross-field validation: unique refs, every `${{ref.VAR}}`,
 *   `${{shared.VAR}}` and `${{input.KEY}}` pointing somewhere real, and no
 *   reference cycles;
 * - rendering: picking free service slugs, rewriting references to them,
 *   substituting inputs and minting generated secrets.
 *
 * Database sources and volumes are part of the format so stacks with
 * databases (ADR 0004) need no new schema version; {@link templateRequirements}
 * reports them so a control plane that can't run them yet refuses cleanly.
 *
 * Imported as `@roundhouse/shared/template`, not from the package index, so
 * code that never touches templates doesn't pull zod in.
 *
 * @module
 */
import { z } from "zod";
import { databaseVersion, renderDatabaseService, type ServiceDatabaseEngine } from "./databases";
import { RESERVED_SERVICE_SLUGS, SERVICE_KINDS, type ServiceKind } from "./projects";
import { BUILDERS, HEALTHCHECK_TYPES, RESTART_POLICIES } from "./service-config";
import { freeSlug } from "./slug";
import {
  BUILTIN_VARIABLES,
  MAX_RESOLVED_VALUE_BYTES,
  parseReferences,
  resolveVariables,
  SHARED_NAMESPACE,
  VARIABLE_NAME_RE,
} from "./variables";

// -----------------------------------------------------------------------------
// Vocabulary
// -----------------------------------------------------------------------------

/** Manifest format version this module reads and writes. */
export const TEMPLATE_SCHEMA_VERSION = 1;

/** Reference namespace for template inputs, `${{input.KEY}}`. Never a service ref. */
export const INPUT_NAMESPACE = "input";

/** Gallery groupings. Every template has exactly one. */
export const TEMPLATE_CATEGORIES = [
  "starter",
  "static",
  "tool",
  "monitoring",
  "automation",
  "database",
] as const;

/** A gallery grouping; see {@link TEMPLATE_CATEGORIES}. */
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/** Kinds of value a template input collects. */
export const TEMPLATE_INPUT_TYPES = ["string", "secret", "number", "boolean", "select"] as const;

/** Kind of template input; see {@link TEMPLATE_INPUT_TYPES}. */
export type TemplateInputType = (typeof TEMPLATE_INPUT_TYPES)[number];

/** Database engines a template service can ask for (ADR 0004). */
export const TEMPLATE_DATABASE_ENGINES = ["postgres", "mysql", "redis", "mongodb"] as const;

/** Encodings of a generated secret. */
export const TEMPLATE_SECRET_ENCODINGS = ["base64url", "hex"] as const;

/** Platform features a template can need beyond plain services. */
export const TEMPLATE_REQUIREMENTS = ["databases", "volumes"] as const;

/** A platform feature a template needs; see {@link TEMPLATE_REQUIREMENTS}. */
export type TemplateRequirement = (typeof TEMPLATE_REQUIREMENTS)[number];

/** Most services one template may define. */
export const MAX_TEMPLATE_SERVICES = 16;

/** Most variables one service (or the shared set) of a template may define. */
export const MAX_TEMPLATE_VARIABLES = 64;

/** Longest service slug the API stores. */
const SLUG_MAX_LENGTH = 40;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const HTTPS_URL_RE = /^https:\/\/[^\s/@?#]+(?:\/[^\s]*)?$/;
const CLONE_URL_RE = /^https:\/\/[^\s/@?#]+\/[^\s?#]+$/;
const ICON_RE = /^(?:builtin:[a-z0-9-]{1,40}|https:\/\/[^\s]+)$/;

// -----------------------------------------------------------------------------
// Schema
// -----------------------------------------------------------------------------

const RefField = z
  .string()
  .max(SLUG_MAX_LENGTH)
  .regex(SLUG_RE, "expected a lowercase slug")
  .refine(
    (ref) =>
      ref !== INPUT_NAMESPACE && !(RESERVED_SERVICE_SLUGS as readonly string[]).includes(ref),
    {
      message: `"${INPUT_NAMESPACE}" and "${SHARED_NAMESPACE}" are reference namespaces`,
    },
  );

const KeyField = z
  .string()
  .max(256)
  .regex(VARIABLE_NAME_RE, "expected an environment variable name");

const ValueField = z.string().max(MAX_RESOLVED_VALUE_BYTES);

/** How a variable's value is minted at render time. */
const GenerateSchema = z
  .object({
    /** Random bytes before encoding: 32 gives 43 base64url or 64 hex characters. */
    bytes: z.number().int().min(16).max(64),
    encoding: z.enum(TEMPLATE_SECRET_ENCODINGS),
  })
  .strict();

/** One template variable: a value (which may hold references) or a generator. */
const VariableSpecSchema = z
  .object({
    /** May contain `${{<ref>.VAR}}`, `${{shared.VAR}}`, `${{VAR}}` and `${{input.KEY}}`. */
    value: ValueField.optional(),
    /** Minted fresh per deploy; always stored as a secret. */
    generate: GenerateSchema.optional(),
    /** Store as a write-only secret. Generated values are secret regardless. */
    secret: z.boolean().optional(),
    description: z.string().max(300).optional(),
  })
  .strict()
  .refine((v) => (v.value === undefined) !== (v.generate === undefined), {
    message: "set exactly one of value and generate",
  });

/** A variable, written as a plain string or as a {@link VariableSpecSchema}. */
const VariableSchema = z.union([ValueField, VariableSpecSchema]);

const VariablesSchema = z
  .record(KeyField, VariableSchema)
  .refine((v) => Object.keys(v).length <= MAX_TEMPLATE_VARIABLES, {
    message: `at most ${MAX_TEMPLATE_VARIABLES} variables`,
  });

/** A value the deployer supplies, substituted wherever `${{input.KEY}}` appears. */
const InputSchema = z
  .object({
    key: KeyField,
    label: z.string().trim().min(1).max(100),
    description: z.string().max(300).optional(),
    type: z.enum(TEMPLATE_INPUT_TYPES),
    required: z.boolean().default(false),
    /** Used when the deployer leaves the input empty. Not allowed for `secret` inputs. */
    default: z.string().max(4096).optional(),
    /** Choices of a `select` input. */
    options: z.array(z.string().min(1).max(200)).min(1).max(50).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const issue = (message: string, path: string) =>
      ctx.addIssue({ code: "custom", message, path: [path] });
    if ((input.type === "select") !== (input.options !== undefined)) {
      issue("options are required for select inputs and only allowed for them", "options");
    }
    if (input.type === "secret" && input.default !== undefined) {
      issue("secret inputs can't have a default", "default");
    }
    if (input.default !== undefined) {
      const problem = inputValueProblem(input, input.default);
      if (problem) issue(problem, "default");
    }
  });

const ImageSourceSchema = z
  .object({ type: z.literal("image"), image: z.string().min(1).max(1024) })
  .strict();

const GitSourceSchema = z
  .object({
    type: z.literal("git"),
    repo_url: z.string().max(2048).regex(CLONE_URL_RE, "expected an https clone URL"),
    branch: z.string().min(1).max(255),
    /** Directory to build from; the repository root when omitted. */
    root_dir: z.string().min(1).max(1024).default("."),
  })
  .strict();

const DatabaseSourceSchema = z
  .object({
    type: z.literal("database"),
    engine: z.enum(TEMPLATE_DATABASE_ENGINES),
    /** Engine major version; the registry's default when omitted (ADR 0004). */
    version: z.string().min(1).max(32).optional(),
  })
  .strict();

/** Where a template service's code comes from. */
const TemplateSourceSchema = z.discriminatedUnion("type", [
  ImageSourceSchema,
  GitSourceSchema,
  DatabaseSourceSchema,
]);

/**
 * Config applied over the platform defaults, part by part like a config
 * patch (`healthcheck` replaces whole). The API validates the merged result
 * with its own schemas, so only the shape is checked here. Placement is left
 * out on purpose: node labels belong to an install, not to a template.
 */
const TemplateConfigSchema = z
  .object({
    build: z
      .object({
        builder: z.enum(BUILDERS).optional(),
        dockerfile_path: z.string().min(1).max(1024).optional(),
        build_args: z.record(KeyField, z.string().max(4096)).optional(),
      })
      .strict()
      .optional(),
    deploy: z
      .object({
        start_command: z.string().min(1).max(4096).optional(),
        replicas: z.number().int().min(0).max(20).optional(),
        restart_policy: z.enum(RESTART_POLICIES).optional(),
        max_retries: z.number().int().min(0).max(100).optional(),
        drain_s: z.number().int().min(0).max(3600).optional(),
        pre_deploy_command: z.string().min(1).max(4096).optional(),
      })
      .strict()
      .optional(),
    resources: z
      .object({
        cpu_millis: z.number().int().min(10).max(64_000).optional(),
        memory_mb: z.number().int().min(16).max(262_144).optional(),
      })
      .strict()
      .optional(),
    healthcheck: z
      .object({
        type: z.enum(HEALTHCHECK_TYPES),
        path: z.string().min(1).max(1024).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        interval_s: z.number().int().min(1).max(3600),
        timeout_s: z.number().int().min(1).max(300),
        retries: z.number().int().min(0).max(100),
        start_period_s: z.number().int().min(0).max(3600),
      })
      .strict()
      .nullable()
      .optional(),
    networking: z
      .object({
        port: z.number().int().min(1).max(65535).nullable().optional(),
        generated_domain: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** One service of a template. */
const TemplateServiceSchema = z
  .object({
    /** The default service slug, and the namespace other services reference it by. */
    ref: RefField,
    name: z.string().trim().min(1).max(100),
    kind: z.enum(SERVICE_KINDS).default("app"),
    icon: z.string().max(2048).regex(ICON_RE, "expected builtin:<name> or an https URL").optional(),
    source: TemplateSourceSchema,
    config: TemplateConfigSchema.optional(),
    variables: VariablesSchema.optional(),
    /** Persistent storage (ADR 0004); needs volume support. */
    volume: z
      .object({
        mount_path: z
          .string()
          .min(2)
          .max(1024)
          .regex(/^\/[^\0]*$/, "expected an absolute path"),
        size_mb: z.number().int().min(64).max(1_048_576),
      })
      .strict()
      .optional(),
    /** Explicit canvas edges to other refs (ADR 0006). */
    connects_to: z.array(RefField).max(MAX_TEMPLATE_SERVICES).optional(),
    /** Canvas position hint. */
    position: z.object({ x: z.number(), y: z.number() }).strict().optional(),
  })
  .strict();

/** The manifest's shape, before the cross-field rules of {@link TemplateSchema}. */
const TemplateObjectSchema = z
  .object({
    schema_version: z.literal(TEMPLATE_SCHEMA_VERSION),
    /** Stable identifier, slug-shaped. */
    id: z.string().max(SLUG_MAX_LENGTH).regex(SLUG_RE, "expected a lowercase slug"),
    /** Bumped whenever the manifest changes; audit entries record `id@version`. */
    version: z.number().int().min(1),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().min(1).max(500),
    /** `builtin:<name>` for an icon the dashboard ships, or an https URL. */
    icon: z.string().max(2048).regex(ICON_RE, "expected builtin:<name> or an https URL").optional(),
    category: z.enum(TEMPLATE_CATEGORIES),
    tags: z.array(z.string().min(1).max(32)).max(10).default([]),
    docs_url: z.string().max(2048).regex(HTTPS_URL_RE, "expected an https URL").optional(),
    inputs: z.array(InputSchema).max(32).default([]),
    services: z.array(TemplateServiceSchema).min(1).max(MAX_TEMPLATE_SERVICES),
    shared_variables: VariablesSchema.optional(),
  })
  .strict();

/** A validated template manifest, defaults applied. */
export type Template = z.output<typeof TemplateObjectSchema>;

/** A template manifest as written, before defaults. */
export type TemplateManifest = z.input<typeof TemplateObjectSchema>;

/** One service of a {@link Template}. */
export type TemplateService = Template["services"][number];

/** Where a template service's code comes from. */
export type TemplateSource = TemplateService["source"];

/** Config a template service applies over the platform defaults. */
export type TemplateServiceConfig = NonNullable<TemplateService["config"]>;

/** One input of a {@link Template}. */
export type TemplateInput = Template["inputs"][number];

/** A template variable, short or long form. */
export type TemplateVariable = z.output<typeof VariableSchema>;

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

function inputValueProblem(input: { type: TemplateInputType; options?: string[] }, value: string) {
  switch (input.type) {
    case "number":
      return /^-?\d+(?:\.\d+)?$/.test(value) ? null : "expected a number";
    case "boolean":
      return value === "true" || value === "false" ? null : "expected true or false";
    case "select":
      return input.options?.includes(value) ? null : `expected one of ${input.options?.join(", ")}`;
    default:
      return null;
  }
}

/** Normalises a short-form variable to its long form. */
function specOf(v: TemplateVariable): Exclude<TemplateVariable, string> {
  return typeof v === "string" ? { value: v } : v;
}

const PLACEHOLDER = "x";

function databasePlaceholders(
  engine: ServiceDatabaseEngine,
  version: string | undefined,
): Record<string, string> {
  const v = databaseVersion(engine, version);
  if (!v) return {};
  const rendered = renderDatabaseService(engine, v.version, (n) => new Uint8Array(n));
  return Object.fromEntries(rendered.variables.map((r) => [r.key, PLACEHOLDER]));
}

/**
 * Cross-field rules of a manifest, run after the shape is valid:
 * 1. refs and input keys are unique; `connects_to` names other refs;
 * 2. database sources are `kind: "database"`;
 * 3. every value parses, `${{input.KEY}}` names a declared input, and every
 *    other reference resolves within the template or to a built-in;
 * 4. no reference cycles, via a {@link resolveVariables} dry run per service
 *    with placeholder values.
 */
function checkTemplate(template: Template, ctx: z.RefinementCtx): void {
  const refs = new Set<string>();
  template.services.forEach((s, i) => {
    if (refs.has(s.ref)) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate ref ${s.ref}`,
        path: ["services", i, "ref"],
      });
    }
    refs.add(s.ref);
    if ((s.source.type === "database") !== (s.kind === "database")) {
      ctx.addIssue({
        code: "custom",
        message: "database sources are kind database, and only they are",
        path: ["services", i, "kind"],
      });
    }
  });
  template.services.forEach((s, i) => {
    for (const [j, target] of (s.connects_to ?? []).entries()) {
      if (!refs.has(target) || target === s.ref) {
        ctx.addIssue({
          code: "custom",
          message: `connects_to names no other service: ${target}`,
          path: ["services", i, "connects_to", j],
        });
      }
    }
  });
  const inputs = new Set<string>();
  template.inputs.forEach((input, i) => {
    if (inputs.has(input.key)) {
      ctx.addIssue({
        code: "custom",
        message: `duplicate input ${input.key}`,
        path: ["inputs", i, "key"],
      });
    }
    inputs.add(input.key);
  });

  const placeholderServices: Record<string, Record<string, string>> = {};
  const placeholderShared: Record<string, string> = {};
  const checkValues = (
    vars: Record<string, TemplateVariable> | undefined,
    path: (string | number)[],
    out: Record<string, string>,
  ) => {
    for (const [key, raw] of Object.entries(vars ?? {})) {
      const spec = specOf(raw);
      if (spec.value === undefined) {
        out[key] = PLACEHOLDER;
        continue;
      }
      const parsed = parseReferences(spec.value);
      for (const e of parsed.errors) {
        ctx.addIssue({ code: "custom", message: e.message, path: [...path, key] });
      }
      for (const ref of parsed.references) {
        if (ref.namespace === INPUT_NAMESPACE && !inputs.has(ref.name)) {
          ctx.addIssue({
            code: "custom",
            message: `\${{input.${ref.name}}} names no declared input`,
            path: [...path, key],
          });
        }
      }
      out[key] = withoutInputs(spec.value);
    }
  };
  template.services.forEach((s, i) => {
    // A database gets generated variables (DATABASE_URL, …) on deploy, so
    // other services may reference them although the manifest never sets them.
    placeholderServices[s.ref] =
      s.source.type === "database" ? databasePlaceholders(s.source.engine, s.source.version) : {};
    if (s.source.type === "database" && !databaseVersion(s.source.engine, s.source.version)) {
      ctx.addIssue({
        code: "custom",
        message: `${s.source.engine} has no version ${s.source.version}`,
        path: ["services", i, "source", "version"],
      });
    }
    checkValues(s.variables, ["services", i, "variables"], placeholderServices[s.ref]!);
  });
  checkValues(template.shared_variables, ["shared_variables"], placeholderShared);
  // A reserved or duplicate ref is already reported, and would make the dry
  // run resolve the wrong namespace.
  if (
    refs.size !== template.services.length ||
    refs.has(SHARED_NAMESPACE) ||
    refs.has(INPUT_NAMESPACE)
  ) {
    return;
  }

  const builtins = Object.fromEntries(
    template.services.map((s) => [
      s.ref,
      Object.fromEntries(BUILTIN_VARIABLES.map((name) => [name, PLACEHOLDER])),
    ]),
  );
  const seen = new Set<string>();
  const dryRun = (service: string, shared: Record<string, string>) => {
    const result = resolveVariables({
      service,
      services: placeholderServices,
      shared,
      builtins,
    });
    if (result.ok) return;
    for (const e of result.errors) {
      if (e.code === "malformed_reference" || e.code === "unclosed_reference") continue;
      const id = `${e.code}:${e.variable.namespace}.${e.variable.name}:${e.start ?? ""}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const where =
        e.variable.namespace === SHARED_NAMESPACE
          ? ["shared_variables", e.variable.name]
          : [
              "services",
              template.services.findIndex((s) => s.ref === e.variable.namespace),
              "variables",
              e.variable.name,
            ];
      ctx.addIssue({ code: "custom", message: e.message, path: where });
    }
  };
  for (const s of template.services) dryRun(s.ref, placeholderShared);
  // NOTE: Shared values are only resolved when a service reaches them, so a
  // throwaway service referencing every shared key checks the rest.
  const probe = "\0shared-probe";
  placeholderServices[probe] = Object.fromEntries(
    Object.keys(placeholderShared).map((k) => [k, `\${{shared.${k}}}`]),
  );
  dryRun(probe, placeholderShared);
  delete placeholderServices[probe];
}

/** Replaces every `${{input.KEY}}` with a placeholder, keeping other text exact. */
function withoutInputs(value: string): string {
  return rewriteReferences(value, (ref) =>
    ref.namespace === INPUT_NAMESPACE ? PLACEHOLDER : null,
  );
}

/**
 * Rewrites references in a value by span, leaving every other character
 * (escapes included) exactly as written.
 *
 * @param value - A raw value.
 * @param replace - Replacement text for a reference, or `null` to keep it.
 */
function rewriteReferences(
  value: string,
  replace: (ref: { namespace: string | null; name: string }) => string | null,
): string {
  let out = "";
  let at = 0;
  for (const ref of parseReferences(value).references) {
    const next = replace(ref);
    if (next === null) continue;
    out += value.slice(at, ref.start) + next;
    at = ref.end;
  }
  return out + value.slice(at);
}

/**
 * A template manifest. Unknown keys are rejected so a typo never silently
 * drops part of a stack.
 *
 * @example
 * TemplateSchema.parse({
 *   schema_version: 1, id: "whoami", version: 1, name: "whoami", description: "Echo server",
 *   category: "tool", services: [{ ref: "whoami", name: "whoami",
 *     source: { type: "image", image: "traefik/whoami:v1.12" } }],
 * });
 */
export const TemplateSchema = TemplateObjectSchema.superRefine(checkTemplate);

/**
 * Platform features a template needs beyond plain services.
 *
 * @param template - A validated template.
 * @returns `databases` and/or `volumes`, in {@link TEMPLATE_REQUIREMENTS} order.
 * @example
 * templateRequirements(whoami); // []
 */
export function templateRequirements(template: Template): TemplateRequirement[] {
  const out: TemplateRequirement[] = [];
  if (template.services.some((s) => s.source.type === "database")) out.push("databases");
  if (template.services.some((s) => s.volume)) out.push("volumes");
  return out;
}

/**
 * Whether a template variable is stored as a secret: generated, marked
 * `secret`, or carrying the value of a `secret` input.
 *
 * @param template - The template the variable belongs to.
 * @param variable - The variable.
 * @returns `true` for write-only variables.
 */
export function isSecretTemplateVariable(template: Template, variable: TemplateVariable): boolean {
  const spec = specOf(variable);
  if (spec.generate || spec.secret) return true;
  if (spec.value === undefined) return false;
  const secretInputs = new Set(
    template.inputs.filter((i) => i.type === "secret").map((i) => i.key),
  );
  return parseReferences(spec.value).references.some(
    (r) => r.namespace === INPUT_NAMESPACE && secretInputs.has(r.name),
  );
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

/** A problem with the inputs a deployer supplied. */
export interface TemplateInputIssue {
  key: string;
  code: "required" | "invalid" | "unknown_input" | "too_large";
  message: string;
}

/** Thrown by {@link renderTemplate} when the supplied inputs are unusable. */
export class TemplateInputError extends Error {
  override readonly name = "TemplateInputError";

  /**
   * @param issues - Every problem found, in input order.
   */
  constructor(readonly issues: TemplateInputIssue[]) {
    super(issues.map((i) => `${i.key}: ${i.message}`).join("; "));
  }
}

/** Options of {@link renderTemplate}. */
export interface RenderTemplateOptions {
  /** Values for the template's inputs, by key. Empty strings count as absent. */
  inputs: Readonly<Record<string, string>>;
  /** Service slugs already taken in the target project. */
  existingSlugs: Iterable<string>;
  /** Cryptographically secure random bytes; `crypto.getRandomValues` in practice. */
  randomBytes: (length: number) => Uint8Array;
}

/** One variable ready to store. */
export interface RenderedVariable {
  key: string;
  /** References are rewritten to final slugs; inputs and generators are filled in. */
  value: string;
  /** Store as a write-only secret. */
  secret: boolean;
  /** Minted by a generator. */
  generated: boolean;
}

/** One service ready to create. */
export interface RenderedService {
  ref: string;
  /** Free in the target project; `ref`, or `ref-2`, `ref-3`, … */
  slug: string;
  name: string;
  kind: ServiceKind;
  icon: string | null;
  source: TemplateSource;
  config: TemplateServiceConfig;
  variables: RenderedVariable[];
}

/** A template rendered against one project. */
export interface RenderedTemplate {
  services: RenderedService[];
  sharedVariables: RenderedVariable[];
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encode(bytes: Uint8Array, encoding: (typeof TEMPLATE_SECRET_ENCODINGS)[number]): string {
  if (encoding === "hex") return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.ceil((Math.min(3, bytes.length - i) * 8) / 6);
    for (let c = 0; c < chars; c++) out += BASE64URL[(n >> (18 - 6 * c)) & 63];
  }
  return out;
}

function utf8Length(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * Resolves the deployer's input values against the template's declarations.
 *
 * @param template - A validated template.
 * @param supplied - Values by key; empty strings count as absent.
 * @returns Every declared input's final value (`""` when optional and unset).
 * @throws {TemplateInputError} For missing required inputs, invalid values or unknown keys.
 */
export function resolveTemplateInputs(
  template: Template,
  supplied: Readonly<Record<string, string>>,
): Record<string, string> {
  const issues: TemplateInputIssue[] = [];
  const declared = new Set(template.inputs.map((i) => i.key));
  for (const key of Object.keys(supplied)) {
    if (!declared.has(key)) {
      issues.push({ key, code: "unknown_input", message: "The template declares no such input" });
    }
  }
  const out: Record<string, string> = {};
  for (const input of template.inputs) {
    const given = supplied[input.key];
    const value = given !== undefined && given !== "" ? given : (input.default ?? "");
    if (value === "") {
      if (input.required) issues.push({ key: input.key, code: "required", message: "Required" });
      out[input.key] = "";
      continue;
    }
    if (utf8Length(value) > MAX_RESOLVED_VALUE_BYTES) {
      issues.push({ key: input.key, code: "too_large", message: "Too long" });
      continue;
    }
    const problem = inputValueProblem(input, value);
    if (problem) issues.push({ key: input.key, code: "invalid", message: problem });
    out[input.key] = value;
  }
  if (issues.length) throw new TemplateInputError(issues);
  return out;
}

/**
 * Renders a template for one project.
 *
 * Steps:
 * 1. resolve inputs (defaults, required, types);
 * 2. give each service a free slug, in manifest order, against `existingSlugs`
 *    and the slugs already picked (reserved slugs are suffixed);
 * 3. rewrite every `${{<ref>.VAR}}` to the final slug and substitute
 *    `${{input.KEY}}` (escaped, so input text can't inject a reference);
 * 4. mint generated values from `randomBytes`.
 *
 * Pure apart from `randomBytes`. Capability checks
 * ({@link templateRequirements}) are the caller's.
 *
 * @param template - A validated template.
 * @param options - Inputs, taken slugs and a random source.
 * @returns Services and shared variables ready to store.
 * @throws {TemplateInputError} When the inputs are unusable.
 * @example
 * const rendered = renderTemplate(template, {
 *   inputs: { TZ: "Europe/Berlin" },
 *   existingSlugs: ["web"],
 *   randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
 * });
 */
export function renderTemplate(
  template: Template,
  options: RenderTemplateOptions,
): RenderedTemplate {
  const inputs = resolveTemplateInputs(template, options.inputs);
  const taken = new Set(options.existingSlugs);
  const slugs = new Map<string, string>();
  for (const s of template.services) {
    const slug = freeSlug(taken, s.ref, RESERVED_SERVICE_SLUGS, SLUG_MAX_LENGTH);
    taken.add(slug);
    slugs.set(s.ref, slug);
  }

  const render = (vars: Record<string, TemplateVariable> | undefined): RenderedVariable[] =>
    Object.entries(vars ?? {}).map(([key, raw]) => {
      const spec = specOf(raw);
      const secret = isSecretTemplateVariable(template, raw);
      if (spec.generate) {
        const bytes = options.randomBytes(spec.generate.bytes);
        if (bytes.length !== spec.generate.bytes)
          throw new Error("randomBytes returned the wrong length");
        return { key, value: encode(bytes, spec.generate.encoding), secret: true, generated: true };
      }
      const value = rewriteReferences(spec.value!, (ref) => {
        // NOTE: A replacer function, because "$$" in a replacement string means one "$".
        if (ref.namespace === INPUT_NAMESPACE)
          return inputs[ref.name]!.replaceAll("${{", () => "$${{");
        const slug = ref.namespace === null ? undefined : slugs.get(ref.namespace);
        return slug === undefined || slug === ref.namespace ? null : `\${{${slug}.${ref.name}}}`;
      });
      return { key, value, secret, generated: false };
    });

  return {
    services: template.services.map((s) => ({
      ref: s.ref,
      slug: slugs.get(s.ref)!,
      name: s.name,
      kind: s.kind,
      icon: s.icon ?? null,
      source: s.source,
      config: s.config ?? {},
      variables: render(s.variables),
    })),
    sharedVariables: render(template.shared_variables),
  };
}
