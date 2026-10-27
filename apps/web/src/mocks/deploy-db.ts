/**
 * Phase 1 tables of the mock database (projects, services, config versions, variables,
 * deployments, builds, logs, domains, instance settings, the GitHub App, API tokens) and
 * their seed.
 *
 * The seed is one realistic workspace: a `storefront` project with a git-built `web`
 * service, an image-based `api` with two replicas and a `worker` mid-deploy, plus an
 * `internal-tools` project running Grafana. Row shapes are the API's own types.
 *
 * @module
 */
import {
  API_TOKEN_PRESETS,
  DEFAULT_LOG_RETENTION_DAYS,
  DEFAULT_SHELL_RECORDING,
  DEFAULT_SHELL_RECORDING_RETENTION_DAYS,
  defaultServiceConfig,
  presenceColor,
  type ServiceSource,
  type VariableTier,
} from "@roundhouse/shared";
import type {
  ApiToken,
  Build,
  Deployment,
  DeploymentEvent,
  Domain,
  Environment,
  GithubInstallation,
  GithubRepository,
  GithubStatus,
  InstanceSettings,
  LogEntry,
  Placement,
  PresenceUser,
  Project,
  Service,
  ServiceConfig,
} from "../lib/api/deploy-types";
import { type DbTls, generatedDomainState, seedTls } from "./domains-db";

/** A stored variable of a service or of a project environment (`shared`). */
export interface DbVariable {
  scope: "service" | "shared";
  /** Service id, or project id for shared variables. */
  owner_id: string;
  environment_id: string;
  key: string;
  /** Kept for secrets too, so the mock can resolve them; never returned for a secret. */
  value: string;
  tier: VariableTier;
  locked: boolean;
  available_at_build: boolean;
  mount_as_file: boolean;
  version: number;
  updated_at: number;
  updated_by: string | null;
}

/** A deployment row; the API joins its build on read. */
export type DbDeployment = Omit<Deployment, "build">;

/** An API token row: the listed token, its workspace and the secret the mock checks. */
export interface DbApiToken extends ApiToken {
  workspace_id: string;
  /** The full `tok_…` secret. The API stores only a hash; the mock keeps it for tests. */
  secret: string;
}

/** A pending GitHub manifest flow. */
export interface DbManifestState {
  state: string;
  workspace_id: string;
  expires_at: number;
  /** Set once an install callback redeemed it; the API refuses a second use (`link_used`). */
  used?: boolean;
}

/** Every Phase 1 table. */
export interface DeployDb {
  projects: (Project & { deleted?: boolean })[];
  environments: Environment[];
  services: (Service & { deleted?: boolean })[];
  configs: ServiceConfig[];
  variables: DbVariable[];
  deployments: DbDeployment[];
  builds: Build[];
  events: DeploymentEvent[];
  placements: Placement[];
  /** Log lines by `deployment:<id>` or `build:<id>`, oldest first. */
  logs: Record<string, LogEntry[]>;
  domains: Domain[];
  instance: InstanceSettings;
  /** Settings → Domains & TLS. */
  tls: DbTls;
  github: {
    app: GithubStatus["app"];
    installations: GithubInstallation[];
    repositories: GithubRepository[];
    states: DbManifestState[];
    /** Secret the webhook handler checks `X-Hub-Signature-256` against. */
    webhookSecret: string;
  };
  /** Who the realtime mock reports as viewing a project. */
  presence: PresenceUser[];
  tokens: DbApiToken[];
}

/** Ids of the seeded rows, for tests. */
export const SEED = {
  project: "prj_store",
  toolsProject: "prj_tools",
  production: "env_store_prod",
  toolsProduction: "env_tools_prod",
  web: "svc_web",
  api: "svc_api",
  worker: "svc_worker",
  grafana: "svc_grafana",
  webActive: "dep_web_4",
  webFailed: "dep_web_3",
  webOld: "dep_web_2",
  webFirst: "dep_web_1",
  webBuild: "bld_web_4",
  apiActive: "dep_api_2",
  apiOld: "dep_api_1",
  workerDeploying: "dep_worker_1",
  grafanaActive: "dep_grafana_1",
  installation: "ghi_acme",
  ciToken: "tok_ci",
  revokedToken: "tok_laptop",
  expiredToken: "tok_old",
} as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SHA_A = "3f9c2b1d8e7a6f5c4b3a29180716253443526170";
const SHA_B = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const SHA_C = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807";

function config(
  serviceId: string,
  environmentId: string,
  version: number,
  createdAt: number,
  source: ServiceSource,
  overrides: Partial<Omit<ServiceConfig, "source">> = {},
): ServiceConfig {
  return {
    id: `cfg_${serviceId}_${version}`,
    service_id: serviceId,
    environment_id: environmentId,
    version,
    created_by: "usr_ada",
    created_at: createdAt,
    ...defaultServiceConfig(source),
    cron: null,
    source,
    ...overrides,
  };
}

function deployment(
  id: string,
  serviceId: string,
  environmentId: string,
  fields: Partial<DbDeployment> & Pick<DbDeployment, "status" | "created_at">,
): DbDeployment {
  return {
    id,
    project_id: serviceId === SEED.grafana ? SEED.toolsProject : SEED.project,
    service_id: serviceId,
    environment_id: environmentId,
    config_version: 1,
    build_id: null,
    image: null,
    trigger: "manual",
    triggered_by: "usr_ada",
    rollback_of: null,
    failure_reason: null,
    started_at: fields.created_at + 2_000,
    finished_at: null,
    updated_at: fields.created_at,
    ...fields,
  };
}

function build(id: string, deploymentId: string, fields: Partial<Build>): Build {
  return {
    id,
    deployment_id: deploymentId,
    service_id: SEED.web,
    commit_sha: SHA_A,
    commit_message: null,
    commit_author: "Ada Lovelace",
    status: "succeeded",
    node_id: "node_hel1",
    image_repository: "127.0.0.1:5000/prj_store/svc_web",
    image_digest: `sha256:${"ab".repeat(32)}`,
    started_at: null,
    finished_at: null,
    error: null,
    created_at: 0,
    ...fields,
  };
}

const ROUTES = ["/", "/products", "/products/42", "/cart", "/api/health", "/checkout"];

/**
 * Generates runtime log lines with ANSI colors, mostly stdout with some stderr and system.
 *
 * @param count - Lines to generate.
 * @param endAt - Timestamp of the last line.
 * @returns Lines, oldest first.
 */
export function runtimeLogLines(count: number, endAt: number): LogEntry[] {
  const lines: LogEntry[] = [];
  for (let i = 0; i < count; i++) {
    const ts = endAt - (count - i) * 1_500;
    const workload_id = i % 3 === 0 ? "wl_web_1" : "wl_web_0";
    if (i % 50 === 0) {
      lines.push({ ts, stream: "system", text: `replica ${workload_id} healthy`, workload_id });
    } else if (i % 17 === 0) {
      lines.push({
        ts,
        stream: "stderr",
        text: `\x1b[33mwarn\x1b[0m slow query on products (${120 + (i % 90)}ms)`,
        workload_id,
      });
    } else {
      const status = i % 29 === 0 ? 404 : 200;
      const color = status === 200 ? 32 : 31;
      lines.push({
        ts,
        stream: "stdout",
        text: `\x1b[2m${new Date(ts).toISOString()}\x1b[0m \x1b[${color}m${status}\x1b[0m GET ${ROUTES[i % ROUTES.length]} ${4 + (i % 40)}ms`,
        workload_id,
      });
    }
  }
  return lines;
}

/**
 * Generates build log lines in Railpack's style.
 *
 * @param endAt - Timestamp of the last line.
 * @returns Lines, oldest first.
 */
export function buildLogLines(endAt: number): LogEntry[] {
  const steps = [
    "\x1b[1;36m==>\x1b[0m Cloning https://github.com/acme/storefront.git (main @ 3f9c2b1)",
    "\x1b[1;36m==>\x1b[0m Detected \x1b[1mNode.js 22\x1b[0m with pnpm (apps/web)",
    "\x1b[1;36m==>\x1b[0m Installing dependencies",
    ...Array.from(
      { length: 40 },
      (_, i) => `  + package-${i.toString(36)}@${1 + (i % 9)}.${i % 7}.${i % 5}`,
    ),
    "\x1b[32m✓\x1b[0m Dependencies installed in 18.2s",
    "\x1b[1;36m==>\x1b[0m Running build: pnpm build",
    "  vite v8.3.5 building for production...",
    "  \x1b[32m✓\x1b[0m 412 modules transformed.",
    "  dist/index.html                 0.71 kB",
    "  dist/assets/index-Dk2.js      231.40 kB │ gzip: 74.12 kB",
    "\x1b[1;36m==>\x1b[0m Exporting image 127.0.0.1:5000/prj_store/svc_web@sha256:abab…",
    "\x1b[32m✓\x1b[0m Build finished in 1m 12s",
  ];
  return steps.map((text, i) => ({
    ts: endAt - (steps.length - i) * 1_200,
    stream: "stdout",
    text,
  }));
}

/**
 * Builds the seeded Phase 1 tables.
 *
 * @param workspaceId - Workspace that owns the seeded projects.
 * @param now - Reference time.
 * @returns Fresh tables.
 */
export function seedDeploy(workspaceId: string, now = Date.now()): DeployDb {
  const webSource: ServiceSource = {
    type: "git",
    repo_url: "https://github.com/acme/storefront.git",
    branch: "main",
    root_dir: "apps/web",
    github_installation_id: SEED.installation,
  };
  const apiSource: ServiceSource = { type: "image", image: "ghcr.io/acme/api:1.4.2" };
  const workerSource: ServiceSource = { type: "image", image: "ghcr.io/acme/worker:1.4.2" };
  const grafanaSource: ServiceSource = { type: "image", image: "grafana/grafana:11.2.0" };
  const P = SEED.production;
  const T = SEED.toolsProduction;

  const webActiveAt = now - 2 * HOUR;
  const deployments: DbDeployment[] = [
    deployment(SEED.webFirst, SEED.web, P, {
      status: "removed",
      trigger: "manual",
      created_at: now - 6 * DAY,
      finished_at: now - 6 * DAY + 95_000,
      build_id: "bld_web_1",
      image: `127.0.0.1:5000/prj_store/svc_web@sha256:${"11".repeat(32)}`,
    }),
    deployment(SEED.webOld, SEED.web, P, {
      status: "removed",
      trigger: "push",
      created_at: now - 3 * DAY,
      finished_at: now - 3 * DAY + 88_000,
      build_id: "bld_web_2",
      config_version: 2,
      image: `127.0.0.1:5000/prj_store/svc_web@sha256:${"22".repeat(32)}`,
    }),
    deployment(SEED.webFailed, SEED.web, P, {
      status: "failed",
      trigger: "push",
      created_at: now - 1 * DAY,
      finished_at: now - 1 * DAY + 64_000,
      build_id: "bld_web_3",
      config_version: 2,
      failure_reason: "Build failed: pnpm build exited with code 1",
    }),
    deployment(SEED.webActive, SEED.web, P, {
      status: "active",
      trigger: "push",
      created_at: webActiveAt,
      finished_at: webActiveAt + 102_000,
      build_id: SEED.webBuild,
      config_version: 3,
      image: `127.0.0.1:5000/prj_store/svc_web@sha256:${"ab".repeat(32)}`,
    }),
    deployment(SEED.apiOld, SEED.api, P, {
      status: "removed",
      created_at: now - 5 * DAY,
      finished_at: now - 5 * DAY + 21_000,
      image: "ghcr.io/acme/api:1.4.1",
    }),
    deployment(SEED.apiActive, SEED.api, P, {
      status: "active",
      created_at: now - 9 * HOUR,
      finished_at: now - 9 * HOUR + 26_000,
      config_version: 2,
      image: "ghcr.io/acme/api:1.4.2",
    }),
    deployment(SEED.workerDeploying, SEED.worker, P, {
      status: "deploying",
      created_at: now - 40_000,
      image: "ghcr.io/acme/worker:1.4.2",
    }),
    deployment(SEED.grafanaActive, SEED.grafana, T, {
      status: "active",
      created_at: now - 12 * DAY,
      finished_at: now - 12 * DAY + 31_000,
      image: "grafana/grafana:11.2.0",
    }),
  ].map((row) => ({ ...row, updated_at: row.finished_at ?? row.created_at }));

  const builds: Build[] = [
    build("bld_web_1", SEED.webFirst, {
      commit_sha: SHA_C,
      commit_message: "Initial storefront",
      created_at: now - 6 * DAY,
      started_at: now - 6 * DAY + 1_000,
      finished_at: now - 6 * DAY + 70_000,
      image_digest: `sha256:${"11".repeat(32)}`,
    }),
    build("bld_web_2", SEED.webOld, {
      commit_sha: SHA_B,
      commit_message: "Add product search",
      created_at: now - 3 * DAY,
      started_at: now - 3 * DAY + 1_000,
      finished_at: now - 3 * DAY + 61_000,
      image_digest: `sha256:${"22".repeat(32)}`,
    }),
    build("bld_web_3", SEED.webFailed, {
      commit_sha: "5c4b3a29180716253443526170f9c2b1d8e7a6f5",
      commit_message: "Refactor checkout flow",
      status: "failed",
      created_at: now - DAY,
      started_at: now - DAY + 1_000,
      finished_at: now - DAY + 60_000,
      image_digest: null,
      error: "pnpm build exited with code 1",
    }),
    build(SEED.webBuild, SEED.webActive, {
      commit_sha: SHA_A,
      commit_message: "Fix cart totals rounding",
      created_at: webActiveAt,
      started_at: webActiveAt + 1_000,
      finished_at: webActiveAt + 73_000,
    }),
  ];

  const events: DeploymentEvent[] = [
    ["status_changed", "Queued", 0],
    ["build_started", "Build started on hel-1", 1_000],
    ["build_finished", "Image built in 1m 12s", 73_000],
    ["scheduled", "Scheduled 2 replicas on hel-1", 74_000],
    ["replica_status", "Replica 0 healthy", 92_000],
    ["replica_status", "Replica 1 healthy", 95_000],
    ["route_switched", "Traffic switched to the new replicas", 96_000],
    ["rollout_finished", "Deployment is live", 102_000],
  ].map(([type, message, offset], index) => ({
    id: `dev_web4_${index}`,
    deployment_id: SEED.webActive,
    type: type as DeploymentEvent["type"],
    message: message as string,
    data: null,
    created_at: webActiveAt + (offset as number),
  }));
  events.push(
    {
      id: "dev_worker_0",
      deployment_id: SEED.workerDeploying,
      type: "status_changed",
      message: "Queued",
      data: null,
      created_at: now - 40_000,
    },
    {
      id: "dev_worker_1",
      deployment_id: SEED.workerDeploying,
      type: "scheduled",
      message: "Scheduled 1 replica on hel-1",
      data: null,
      created_at: now - 38_000,
    },
    {
      id: "dev_web3_0",
      deployment_id: SEED.webFailed,
      type: "error",
      message: "pnpm build exited with code 1",
      data: { exit_code: 1 },
      created_at: now - DAY + 60_000,
    },
  );

  const placement = (
    id: string,
    deploymentId: string,
    replica: number,
    state: Placement["state"],
    at: number,
  ): Placement => ({
    id,
    deployment_id: deploymentId,
    replica,
    node_id: "node_hel1",
    node_name: "hel-1",
    workload_id: `wl_${deploymentId}_${replica}`,
    container_id: state === "pending" ? null : `c${id.slice(-4)}9f2e1d`,
    state,
    last_status_at: at,
  });

  const webVariables: [string, string, VariableTier][] = [
    ["DATABASE_URL", "postgres://store:hunter2@db.internal:5432/store", "secret"],
    ["NODE_ENV", "production", "plain"],
    ["API_URL", `http://\${{api.ROUNDHOUSE_PRIVATE_DOMAIN}}:8080`, "plain"],
    ["SESSION_SECRET", "s3cr3t-session-key-0123456789", "secret"],
    ["REGION", `\${{shared.REGION}}`, "plain"],
  ];
  const flags = {
    locked: false,
    available_at_build: false,
    mount_as_file: false,
    updated_by: "usr_ada",
  };

  return {
    projects: [
      {
        id: SEED.project,
        workspace_id: workspaceId,
        name: "storefront",
        slug: "storefront",
        description: "Customer-facing shop: web frontend, API and background worker.",
        created_at: now - 7 * DAY,
        updated_at: now - DAY,
      },
      {
        id: SEED.toolsProject,
        workspace_id: workspaceId,
        name: "internal-tools",
        slug: "internal-tools",
        description: null,
        created_at: now - 14 * DAY,
        updated_at: now - 12 * DAY,
      },
    ],
    environments: [
      {
        id: P,
        project_id: SEED.project,
        name: "production",
        slug: "production",
        kind: "production",
        pr_number: null,
        source_branch: null,
        // NOTE: Created before ADR 0014, so the migration left it unprotected; the tools
        // project's production shows the protected case.
        protected: false,
        created_at: now - 7 * DAY,
      },
      {
        id: T,
        project_id: SEED.toolsProject,
        name: "production",
        slug: "production",
        kind: "production",
        pr_number: null,
        source_branch: null,
        protected: true,
        created_at: now - 14 * DAY,
      },
    ],
    services: [
      {
        id: SEED.web,
        project_id: SEED.project,
        name: "web",
        slug: "web",
        kind: "app",
        icon: null,
        created_at: now - 7 * DAY,
        updated_at: now - 2 * DAY,
      },
      {
        id: SEED.api,
        project_id: SEED.project,
        name: "api",
        slug: "api",
        kind: "app",
        icon: null,
        created_at: now - 7 * DAY,
        updated_at: now - 5 * DAY,
      },
      {
        id: SEED.worker,
        project_id: SEED.project,
        name: "worker",
        slug: "worker",
        kind: "app",
        icon: null,
        created_at: now - 2 * DAY,
        updated_at: now - 2 * DAY,
      },
      {
        id: SEED.grafana,
        project_id: SEED.toolsProject,
        name: "grafana",
        slug: "grafana",
        kind: "app",
        icon: null,
        created_at: now - 14 * DAY,
        updated_at: now - 14 * DAY,
      },
    ],
    configs: [
      config(SEED.web, P, 1, now - 7 * DAY, webSource),
      config(SEED.web, P, 2, now - 4 * DAY, webSource, {
        networking: { port: 3000, generated_domain: true },
      }),
      config(SEED.web, P, 3, now - 2 * DAY, webSource, {
        networking: { port: 3000, generated_domain: true },
        deploy: { replicas: 2, restart_policy: "on_failure", max_retries: 10, drain_s: 10 },
        healthcheck: {
          type: "http",
          path: "/healthz",
          interval_s: 10,
          timeout_s: 3,
          retries: 3,
          start_period_s: 5,
        },
      }),
      config(SEED.api, P, 1, now - 7 * DAY, apiSource),
      config(SEED.api, P, 2, now - 5 * DAY, apiSource, {
        deploy: {
          replicas: 2,
          restart_policy: "always",
          max_retries: 10,
          drain_s: 30,
          start_command: "node dist/server.js",
        },
        networking: { port: 8080, generated_domain: true },
        resources: { cpu_millis: 500, memory_mb: 256 },
      }),
      config(SEED.worker, P, 1, now - 2 * DAY, workerSource, {
        networking: { port: null, generated_domain: false },
        deploy: {
          replicas: 1,
          restart_policy: "on_failure",
          max_retries: 10,
          drain_s: 10,
          start_command: "node dist/worker.js",
        },
      }),
      config(SEED.grafana, T, 1, now - 14 * DAY, grafanaSource, {
        networking: { port: 3000, generated_domain: true },
      }),
    ],
    variables: [
      ...webVariables.map(([key, value, tier], index) => ({
        scope: "service" as const,
        owner_id: SEED.web,
        environment_id: P,
        key,
        value,
        tier,
        ...flags,
        version: 1 + (index % 2),
        updated_at: now - (index + 1) * HOUR,
      })),
      {
        scope: "service",
        owner_id: SEED.api,
        environment_id: P,
        key: "LOG_LEVEL",
        value: "info",
        tier: "plain",
        ...flags,
        version: 1,
        updated_at: now - DAY,
      },
      {
        scope: "service",
        owner_id: SEED.api,
        environment_id: P,
        key: "STRIPE_KEY",
        value: "sk_live_0123456789",
        tier: "secret",
        ...flags,
        locked: true,
        version: 1,
        updated_at: now - DAY,
      },
      {
        scope: "shared",
        owner_id: SEED.project,
        environment_id: P,
        key: "REGION",
        value: "hel1",
        tier: "plain",
        ...flags,
        version: 1,
        updated_at: now - 3 * DAY,
      },
    ],
    deployments,
    builds,
    events,
    placements: [
      placement("plc_web4_0", SEED.webActive, 0, "healthy", now - 30_000),
      placement("plc_web4_1", SEED.webActive, 1, "healthy", now - 30_000),
      placement("plc_api2_0", SEED.apiActive, 0, "healthy", now - 60_000),
      placement("plc_api2_1", SEED.apiActive, 1, "healthy", now - 60_000),
      placement("plc_worker_0", SEED.workerDeploying, 0, "starting", now - 20_000),
      placement("plc_graf_0", SEED.grafanaActive, 0, "healthy", now - 90_000),
    ],
    logs: {
      [`deployment:${SEED.webActive}`]: runtimeLogLines(450, now - 5_000),
      [`build:${SEED.webBuild}`]: buildLogLines(webActiveAt + 73_000),
      "build:bld_web_3": [
        ...buildLogLines(now - DAY + 50_000).slice(0, 46),
        {
          ts: now - DAY + 59_000,
          stream: "stderr",
          text: "\x1b[31merror\x1b[0m src/checkout.ts(42,7): Type 'string' is not assignable to type 'number'.",
        },
      ],
      [`deployment:${SEED.apiActive}`]: runtimeLogLines(80, now - 15_000),
    },
    domains: [
      {
        id: "dom_web",
        service_id: SEED.web,
        environment_id: P,
        hostname: "web-production-x7k2.apps.example.com",
        url: "https://web-production-x7k2.apps.example.com",
        type: "generated",
        target_port: 3000,
        verification_status: "verified",
        ...generatedDomainState("issued", now - 4 * DAY),
        created_at: now - 4 * DAY,
      },
      {
        id: "dom_api",
        service_id: SEED.api,
        environment_id: P,
        hostname: "api-production-q3zk.apps.example.com",
        url: "https://api-production-q3zk.apps.example.com",
        type: "generated",
        target_port: 8080,
        verification_status: "verified",
        ...generatedDomainState("issued", now - 5 * DAY),
        created_at: now - 5 * DAY,
      },
      {
        id: "dom_grafana",
        service_id: SEED.grafana,
        environment_id: T,
        hostname: "grafana-production-m2pd.apps.example.com",
        url: "https://grafana-production-m2pd.apps.example.com",
        type: "generated",
        target_port: 3000,
        verification_status: "verified",
        ...generatedDomainState("issued", now - 14 * DAY),
        created_at: now - 14 * DAY,
      },
    ],
    instance: {
      apps_domain: "apps.example.com",
      tls_mode: "acme",
      log_retention_days: DEFAULT_LOG_RETENTION_DAYS,
      mcp_enabled: false,
      shell_recording: DEFAULT_SHELL_RECORDING,
      shell_recording_retention_days: DEFAULT_SHELL_RECORDING_RETENTION_DAYS,
      ingress_nodes: 0,
    },
    tls: seedTls(),
    github: {
      app: {
        id: 912_345,
        slug: "roundhouse-acme",
        name: "Roundhouse (acme)",
        html_url: "https://github.com/apps/roundhouse-acme",
        install_url: "https://github.com/apps/roundhouse-acme/installations/new",
      },
      installations: [
        {
          id: SEED.installation,
          installation_id: 55_501,
          account_login: "acme",
          account_type: "Organization",
          workspace_id: workspaceId,
          verified: true,
          claimed_at: now - 10 * DAY,
          created_at: now - 10 * DAY,
        },
      ],
      repositories: [
        {
          id: 1001,
          full_name: "acme/storefront",
          private: true,
          default_branch: "main",
          clone_url: "https://github.com/acme/storefront.git",
          installation_id: SEED.installation,
        },
        {
          id: 1002,
          full_name: "acme/billing",
          private: true,
          default_branch: "trunk",
          clone_url: "https://github.com/acme/billing.git",
          installation_id: SEED.installation,
        },
        {
          id: 1003,
          full_name: "acme/docs",
          private: false,
          default_branch: "main",
          clone_url: "https://github.com/acme/docs.git",
          installation_id: SEED.installation,
        },
      ],
      states: [],
      webhookSecret: "whsec_mock",
    },
    presence: [
      {
        user_id: "usr_ada",
        name: "Ada Lovelace",
        image: null,
        color: presenceColor("usr_ada"),
        environment_id: null,
        selection: [],
        editing: null,
      },
      {
        user_id: "usr_bob",
        name: "Bob Builder",
        image: null,
        color: presenceColor("usr_bob"),
        environment_id: null,
        selection: [],
        editing: null,
      },
    ],
    tokens: [
      {
        id: SEED.ciToken,
        workspace_id: workspaceId,
        name: "github-actions",
        scopes: [...API_TOKEN_PRESETS.deploy],
        prefix: "tok_c1Q9",
        secret: "tok_c1Q9mockmockmockmockmockmockmockmock",
        created_by: { user_id: "usr_ada", name: "Ada Lovelace" },
        last_used_at: now - 3 * HOUR,
        expires_at: now + 80 * DAY,
        revoked_at: null,
        created_at: now - 10 * DAY,
      },
      {
        id: SEED.revokedToken,
        workspace_id: workspaceId,
        name: "old laptop",
        scopes: [...API_TOKEN_PRESETS.read],
        prefix: "tok_Lp7x",
        secret: "tok_Lp7xmockmockmockmockmockmockmockmock",
        created_by: { user_id: "usr_ada", name: "Ada Lovelace" },
        last_used_at: now - 20 * DAY,
        expires_at: null,
        revoked_at: now - 15 * DAY,
        created_at: now - 40 * DAY,
      },
      {
        id: SEED.expiredToken,
        workspace_id: workspaceId,
        name: "staging smoke test",
        scopes: [...API_TOKEN_PRESETS.read],
        prefix: "tok_Ex3k",
        secret: "tok_Ex3kmockmockmockmockmockmockmockmock",
        created_by: null,
        last_used_at: null,
        expires_at: now - 2 * DAY,
        revoked_at: null,
        created_at: now - 32 * DAY,
      },
    ],
  };
}

/**
 * Empty Phase 1 tables, for a fresh install.
 *
 * @returns Tables with no rows, generated domains disabled and no GitHub App.
 */
export function emptyDeploy(): DeployDb {
  return {
    projects: [],
    environments: [],
    services: [],
    configs: [],
    variables: [],
    deployments: [],
    builds: [],
    events: [],
    placements: [],
    logs: {},
    domains: [],
    instance: {
      apps_domain: null,
      tls_mode: "acme",
      log_retention_days: DEFAULT_LOG_RETENTION_DAYS,
      mcp_enabled: false,
      shell_recording: DEFAULT_SHELL_RECORDING,
      shell_recording_retention_days: DEFAULT_SHELL_RECORDING_RETENTION_DAYS,
      ingress_nodes: 0,
    },
    tls: seedTls(),
    github: {
      app: null,
      installations: [],
      repositories: [],
      states: [],
      webhookSecret: "whsec_mock",
    },
    presence: [],
    tokens: [],
  };
}
