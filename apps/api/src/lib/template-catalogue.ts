// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are variable references (`${{input.KEY}}`), not template literals.
/**
 * The built-in template catalogue, embedded in the control plane so listing
 * and deploying templates needs no network fetch and no database rows.
 *
 * Every entry is a {@link TemplateManifest} checked by `TemplateSchema` when
 * the module loads (`test/templates.test.ts` also merges each service's
 * config through the API's own config schemas). Git starters point at
 * public repositories that Railpack builds as they are; image templates use
 * official images on Docker Hub.
 *
 * TODO: ADR 0012 wants official images pinned by digest with a weekly
 * re-resolve job. Until that job exists the images track a major or stable
 * tag, so they pick up security fixes on redeploy.
 *
 * @module
 */
import { type Template, type TemplateManifest, TemplateSchema } from "@roundhouse/shared/template";

const RAILPACK = "https://github.com/railwayapp/railpack";
const STARTERS = "https://github.com/railwayapp-templates";

const httpCheck = (path: string, startPeriodS = 10) => ({
  type: "http" as const,
  path,
  interval_s: 10,
  timeout_s: 5,
  retries: 3,
  start_period_s: startPeriodS,
});

const PUBLIC_WEB = (port: number) => ({ port, generated_domain: true });

const MANIFESTS: TemplateManifest[] = [
  {
    schema_version: 1,
    id: "static-site",
    version: 1,
    name: "Static site",
    description:
      "A plain HTML page served by Caddy. Railpack detects the index.html and serves the " +
      "directory; replace the repository with your own to publish any static site.",
    icon: "builtin:globe",
    category: "static",
    tags: ["html", "caddy", "railpack"],
    docs_url: "https://railpack.com/languages/staticfile",
    services: [
      {
        ref: "web",
        name: "Static site",
        source: {
          type: "git",
          repo_url: RAILPACK,
          branch: "main",
          root_dir: "examples/staticfile-index",
        },
        config: {
          resources: { memory_mb: 256 },
          healthcheck: httpCheck("/health"),
          networking: PUBLIC_WEB(8080),
        },
      },
    ],
  },
  {
    schema_version: 1,
    id: "vite-react",
    version: 1,
    name: "Vite + React",
    description:
      "A React single-page app built with Vite and served as static files by Caddy. Railpack " +
      "runs the build and ships only the output.",
    icon: "builtin:react",
    category: "static",
    tags: ["react", "vite", "spa", "node"],
    docs_url: "https://railpack.com/languages/node",
    services: [
      {
        ref: "web",
        name: "Vite + React",
        source: {
          type: "git",
          repo_url: RAILPACK,
          branch: "main",
          root_dir: "examples/node-vite-react",
        },
        config: {
          resources: { memory_mb: 256 },
          healthcheck: httpCheck("/"),
          networking: PUBLIC_WEB(8080),
        },
      },
    ],
  },
  {
    schema_version: 1,
    id: "express",
    version: 1,
    name: "Express",
    description:
      "A TypeScript Express API answering JSON on /. Railpack installs dependencies, runs " +
      "the TypeScript build and starts it with node.",
    icon: "builtin:nodejs",
    category: "starter",
    tags: ["node", "typescript", "express", "api"],
    docs_url: "https://expressjs.com/",
    services: [
      {
        ref: "api",
        name: "Express API",
        source: { type: "git", repo_url: `${STARTERS}/expressjs`, branch: "main" },
        config: {
          healthcheck: httpCheck("/"),
          networking: PUBLIC_WEB(8080),
        },
        variables: { NODE_ENV: "production" },
      },
    ],
  },
  {
    schema_version: 1,
    id: "node-http",
    version: 1,
    name: "Node.js HTTP server",
    description:
      "The smallest possible Node.js web server: node:http with no dependencies, listening " +
      "on $PORT. A good first deploy to check a new server end to end.",
    icon: "builtin:nodejs",
    category: "starter",
    tags: ["node", "http", "hello-world"],
    services: [
      {
        ref: "web",
        name: "Node.js server",
        source: { type: "git", repo_url: `${STARTERS}/http-nodejs`, branch: "main" },
        config: {
          resources: { memory_mb: 256 },
          healthcheck: httpCheck("/"),
          networking: PUBLIC_WEB(8080),
        },
      },
    ],
  },
  {
    schema_version: 1,
    id: "fastapi",
    version: 1,
    name: "FastAPI",
    description:
      "A Python FastAPI app served by Hypercorn. Railpack installs requirements.txt; the " +
      "start command binds Hypercorn to $PORT.",
    icon: "builtin:python",
    category: "starter",
    tags: ["python", "fastapi", "api", "asgi"],
    docs_url: "https://fastapi.tiangolo.com/",
    services: [
      {
        ref: "api",
        name: "FastAPI",
        source: { type: "git", repo_url: `${STARTERS}/fastapi`, branch: "main" },
        config: {
          deploy: { start_command: 'hypercorn main:app --bind "0.0.0.0:$PORT"' },
          healthcheck: httpCheck("/"),
          networking: PUBLIC_WEB(8080),
        },
      },
    ],
  },
  {
    schema_version: 1,
    id: "go-gin",
    version: 1,
    name: "Go + Gin",
    description:
      "A Go web service on the Gin router with structured JSON logs, listening on $PORT. " +
      "Railpack builds a static binary from go.mod.",
    icon: "builtin:go",
    category: "starter",
    tags: ["go", "gin", "api"],
    docs_url: "https://gin-gonic.com/",
    services: [
      {
        ref: "api",
        name: "Gin API",
        source: { type: "git", repo_url: `${STARTERS}/gin`, branch: "main" },
        config: {
          resources: { memory_mb: 256 },
          healthcheck: httpCheck("/"),
          networking: PUBLIC_WEB(8080),
        },
      },
    ],
  },
  {
    schema_version: 1,
    id: "nginx",
    version: 1,
    name: "nginx",
    description:
      "The official nginx image showing its welcome page. Swap the image for your own " +
      "nginx-based one to serve a built site or proxy.",
    icon: "builtin:nginx",
    category: "static",
    tags: ["nginx", "web-server", "image"],
    docs_url: "https://hub.docker.com/_/nginx",
    services: [
      {
        ref: "nginx",
        name: "nginx",
        source: { type: "image", image: "nginx:stable-alpine" },
        config: {
          resources: { cpu_millis: 500, memory_mb: 128 },
          healthcheck: httpCheck("/"),
          networking: PUBLIC_WEB(80),
        },
      },
    ],
  },
  {
    schema_version: 1,
    id: "whoami",
    version: 1,
    name: "whoami",
    description:
      "Traefik's tiny echo server: it answers every request with the headers, client " +
      "address and container it reached. Handy for checking domains, TLS and proxies.",
    icon: "builtin:radar",
    category: "tool",
    tags: ["debug", "http", "image"],
    docs_url: "https://github.com/traefik/whoami",
    services: [
      {
        ref: "whoami",
        name: "whoami",
        source: { type: "image", image: "traefik/whoami:v1.12" },
        config: {
          resources: { cpu_millis: 250, memory_mb: 64 },
          healthcheck: httpCheck("/health", 5),
          networking: PUBLIC_WEB(80),
        },
      },
    ],
  },
  {
    schema_version: 1,
    id: "uptime-kuma",
    version: 1,
    name: "Uptime Kuma",
    description:
      "A self-hosted status monitor for HTTP, TCP, DNS and more, with notifications. " +
      "Monitors and history live in the container until volumes arrive, so they reset on " +
      "redeploy.",
    icon: "builtin:activity",
    category: "monitoring",
    tags: ["monitoring", "status-page", "image"],
    docs_url: "https://github.com/louislam/uptime-kuma",
    services: [
      {
        ref: "uptime-kuma",
        name: "Uptime Kuma",
        source: { type: "image", image: "louislam/uptime-kuma:2" },
        config: {
          deploy: { drain_s: 0 },
          resources: { memory_mb: 512 },
          healthcheck: httpCheck("/", 30),
          networking: PUBLIC_WEB(3001),
        },
      },
    ],
  },
  {
    schema_version: 1,
    id: "n8n",
    version: 1,
    name: "n8n",
    description:
      "Workflow automation with a visual editor and hundreds of integrations. Its " +
      "encryption key is generated on deploy and stored as a secret. Workflows live in the " +
      "container's SQLite file until volumes arrive, so they reset on redeploy.",
    icon: "builtin:workflow",
    category: "automation",
    tags: ["automation", "workflows", "image"],
    docs_url: "https://docs.n8n.io/hosting/",
    inputs: [
      {
        key: "TIMEZONE",
        label: "Timezone",
        description: "IANA name used by schedule triggers, e.g. Europe/Berlin.",
        type: "string",
        required: false,
        default: "UTC",
      },
    ],
    services: [
      {
        ref: "n8n",
        name: "n8n",
        source: { type: "image", image: "n8nio/n8n:stable" },
        config: {
          deploy: { drain_s: 0 },
          resources: { memory_mb: 1024 },
          healthcheck: httpCheck("/healthz", 30),
          networking: PUBLIC_WEB(5678),
        },
        variables: {
          N8N_ENCRYPTION_KEY: {
            generate: { bytes: 32, encoding: "hex" },
            description: "Encrypts stored credentials. Changing it makes them unreadable.",
          },
          GENERIC_TIMEZONE: "${{input.TIMEZONE}}",
          TZ: "${{input.TIMEZONE}}",
          N8N_PROXY_HOPS: "1",
          N8N_DIAGNOSTICS_ENABLED: "false",
        },
      },
    ],
  },
  {
    schema_version: 1,
    id: "n8n-postgres",
    version: 1,
    name: "n8n with PostgreSQL",
    description:
      "n8n workflow automation backed by PostgreSQL 18 on a persistent volume, so workflows, " +
      "credentials and executions survive redeploys. The database password and n8n's " +
      "encryption key are generated on deploy and stored as secrets.",
    icon: "builtin:workflow",
    category: "automation",
    tags: ["automation", "workflows", "postgres", "database", "image"],
    docs_url: "https://docs.n8n.io/hosting/configuration/supported-databases-settings/",
    inputs: [
      {
        key: "TIMEZONE",
        label: "Timezone",
        description: "IANA name used by schedule triggers, e.g. Europe/Berlin.",
        type: "string",
        required: false,
        default: "UTC",
      },
    ],
    services: [
      {
        ref: "postgres",
        name: "PostgreSQL",
        kind: "database",
        source: { type: "database", engine: "postgres", version: "18" },
        volume: { mount_path: "/var/lib/postgresql", size_mb: 5120 },
      },
      {
        ref: "n8n",
        name: "n8n",
        source: { type: "image", image: "n8nio/n8n:stable" },
        config: {
          deploy: { drain_s: 0 },
          resources: { memory_mb: 1024 },
          healthcheck: httpCheck("/healthz", 60),
          networking: PUBLIC_WEB(5678),
        },
        variables: {
          N8N_ENCRYPTION_KEY: {
            generate: { bytes: 32, encoding: "hex" },
            description: "Encrypts stored credentials. Changing it makes them unreadable.",
          },
          // n8n's documented database settings (docs.n8n.io, "Supported databases").
          DB_TYPE: "postgresdb",
          DB_POSTGRESDB_HOST: "${{postgres.PGHOST}}",
          DB_POSTGRESDB_PORT: "${{postgres.PGPORT}}",
          DB_POSTGRESDB_DATABASE: "${{postgres.POSTGRES_DB}}",
          DB_POSTGRESDB_USER: "${{postgres.POSTGRES_USER}}",
          DB_POSTGRESDB_PASSWORD: { value: "${{postgres.POSTGRES_PASSWORD}}", secret: true },
          GENERIC_TIMEZONE: "${{input.TIMEZONE}}",
          TZ: "${{input.TIMEZONE}}",
          N8N_PROXY_HOPS: "1",
          N8N_DIAGNOSTICS_ENABLED: "false",
        },
        connects_to: ["postgres"],
      },
    ],
  },
];

/**
 * The built-in templates, validated, in gallery order.
 *
 * @throws {Error} At module load when a manifest is invalid, so a broken
 *   catalogue fails every test instead of reaching an install.
 */
export const BUILT_IN_TEMPLATES: readonly Template[] = MANIFESTS.map((manifest) => {
  const parsed = TemplateSchema.safeParse(manifest);
  if (!parsed.success) {
    throw new Error(`Invalid built-in template ${manifest.id}: ${parsed.error.message}`);
  }
  return parsed.data;
});
