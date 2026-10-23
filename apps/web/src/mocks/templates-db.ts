// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are variable references (`${{input.KEY}}`), not template literals.
/**
 * The mock template catalogue and its API views.
 *
 * The catalogue is the control plane's own built-in one (read from the API source), plus
 * a few fixtures covering what the built-ins don't: required, secret, select, number and
 * boolean inputs, a generated secret, and templates that need databases or volumes (so
 * the API answers 409 and the gallery shows them unsupported).
 *
 * The view functions mirror `toTemplateSummary` / `toTemplateDetail` in
 * `apps/api/src/lib/templates.ts`, which can't be imported here because that module
 * pulls in D1 and the Worker runtime.
 *
 * @module
 */
import { defaultServiceConfig } from "@roundhouse/shared";
import {
  isSecretTemplateVariable,
  type Template,
  type TemplateManifest,
  type TemplateRequirement,
  TemplateSchema,
  type TemplateSource,
  type TemplateVariable,
  templateRequirements,
} from "@roundhouse/shared/template";
import { BUILT_IN_TEMPLATES } from "../../../api/src/lib/template-catalogue";
import type { TemplateDetail, TemplateSummary } from "../lib/api/templates-types";

/** Ids of the fixture templates, for tests. */
export const TEMPLATE_FIXTURES = {
  /** Required string and secret inputs, a select, a number, a boolean and a generated key. */
  relay: "webhook-relay",
  /** Needs databases; unsupported. */
  postgres: "postgres-app",
  /** Needs volumes; unsupported. */
  files: "file-browser",
} as const;

const FIXTURES: TemplateManifest[] = [
  {
    schema_version: 1,
    id: TEMPLATE_FIXTURES.relay,
    version: 2,
    name: "Webhook relay",
    description: "Receives signed webhooks and forwards them to an internal URL with retries.",
    icon: "builtin:webhook",
    category: "automation",
    tags: ["webhooks", "image"],
    docs_url: "https://example.com/webhook-relay",
    inputs: [
      {
        key: "TARGET_URL",
        label: "Target URL",
        description: "Where verified webhooks are forwarded.",
        type: "string",
        required: true,
      },
      {
        key: "SIGNING_SECRET",
        label: "Signing secret",
        description: "Shared with the sender to verify signatures.",
        type: "secret",
        required: true,
      },
      {
        key: "LOG_LEVEL",
        label: "Log level",
        type: "select",
        options: ["debug", "info", "warn"],
        default: "info",
      },
      { key: "RETRIES", label: "Retries", type: "number", default: "3" },
      { key: "VERBOSE", label: "Verbose logging", type: "boolean", default: "false" },
    ],
    services: [
      {
        ref: "relay",
        name: "Relay",
        source: { type: "image", image: "ghcr.io/example/webhook-relay:1" },
        config: {
          deploy: { start_command: "relay --listen :8080" },
          networking: { port: 8080, generated_domain: true },
        },
        variables: {
          TARGET_URL: "${{input.TARGET_URL}}",
          SIGNING_SECRET: "${{input.SIGNING_SECRET}}",
          RELAY_TOKEN: {
            generate: { bytes: 32, encoding: "hex" },
            description: "Authenticates the worker to the relay.",
          },
          LOG_LEVEL: "${{input.LOG_LEVEL}}",
        },
      },
      {
        ref: "worker",
        name: "Retry worker",
        source: { type: "image", image: "ghcr.io/example/webhook-relay:1" },
        config: { networking: { port: null } },
        variables: { RETRIES: "${{input.RETRIES}}", VERBOSE: "${{input.VERBOSE}}" },
      },
    ],
    shared_variables: { RELAY_REGION: "eu" },
  },
  {
    schema_version: 1,
    id: TEMPLATE_FIXTURES.postgres,
    version: 1,
    name: "App + Postgres",
    description: "A starter app wired to a managed Postgres database.",
    icon: "builtin:database",
    category: "database",
    tags: ["postgres", "sql"],
    services: [
      {
        ref: "web",
        name: "Web",
        source: { type: "git", repo_url: "https://github.com/example/app", branch: "main" },
      },
      {
        ref: "db",
        name: "Postgres",
        kind: "database",
        source: { type: "database", engine: "postgres", version: "17" },
      },
    ],
  },
  {
    schema_version: 1,
    id: TEMPLATE_FIXTURES.files,
    version: 1,
    name: "File browser",
    description: "A web file manager that keeps uploads on a persistent volume.",
    icon: "builtin:folder",
    category: "tool",
    tags: ["files", "image"],
    services: [
      {
        ref: "files",
        name: "File browser",
        source: { type: "image", image: "filebrowser/filebrowser:v2" },
        volume: { mount_path: "/srv", size_mb: 1024 },
      },
    ],
  },
];

/** Every template the mock serves: the built-in catalogue, then the fixtures. */
export const MOCK_TEMPLATES: readonly Template[] = [
  ...BUILT_IN_TEMPLATES,
  ...FIXTURES.map((manifest) => TemplateSchema.parse(manifest)),
];

/** Requirements the mock control plane satisfies; none, like the API today. */
export const SUPPORTED_REQUIREMENTS: readonly TemplateRequirement[] = [];

/**
 * Looks a template up by id.
 *
 * @param id - Template id.
 * @returns The template, or `undefined`.
 */
export function findMockTemplate(id: string): Template | undefined {
  return MOCK_TEMPLATES.find((template) => template.id === id);
}

/**
 * Projects a template for the gallery, like the API.
 *
 * @param t - A template.
 * @returns Its summary.
 */
export function toSummary(t: Template): TemplateSummary {
  const requirements = templateRequirements(t);
  return {
    id: t.id,
    version: t.version,
    name: t.name,
    description: t.description,
    icon: t.icon ?? null,
    category: t.category,
    tags: t.tags,
    docs_url: t.docs_url ?? null,
    service_count: t.services.length,
    requirements,
    supported: requirements.every((r) => SUPPORTED_REQUIREMENTS.includes(r)),
  };
}

const DEFAULT_PORT = defaultServiceConfig({ type: "image", image: "scratch" }).networking.port;

function toVariables(t: Template, vars: Record<string, TemplateVariable> | undefined) {
  return Object.entries(vars ?? {}).map(([key, raw]) => {
    const spec = typeof raw === "string" ? { value: raw } : raw;
    const secret = isSecretTemplateVariable(t, raw);
    return {
      key,
      secret,
      generated: spec.generate !== undefined,
      value: secret ? null : (spec.value ?? null),
      description: spec.description ?? null,
    };
  });
}

function toSource(source: TemplateSource): TemplateDetail["services"][number]["source"] {
  switch (source.type) {
    case "image":
      return { type: "image", image: source.image };
    case "git":
      return {
        type: "git",
        repo_url: source.repo_url,
        branch: source.branch,
        root_dir: source.root_dir,
      };
    case "database":
      return { type: "database", engine: source.engine, version: source.version ?? null };
  }
}

/**
 * Projects a template for its detail page, like the API: secret values are never
 * included.
 *
 * @param t - A template.
 * @returns Its detail view.
 */
export function toDetail(t: Template): TemplateDetail {
  return {
    ...toSummary(t),
    inputs: t.inputs.map((i) => ({
      key: i.key,
      label: i.label,
      description: i.description ?? null,
      type: i.type,
      required: i.required,
      default: i.default ?? null,
      options: i.options ?? null,
    })),
    services: t.services.map((s) => {
      const port = s.config?.networking?.port;
      return {
        ref: s.ref,
        name: s.name,
        kind: s.kind,
        icon: s.icon ?? null,
        source: toSource(s.source),
        port: port === undefined ? DEFAULT_PORT : port,
        public: s.config?.networking?.generated_domain ?? false,
        start_command: s.config?.deploy?.start_command ?? null,
        variables: toVariables(t, s.variables),
      };
    }),
    shared_variables: toVariables(t, t.shared_variables),
  };
}
