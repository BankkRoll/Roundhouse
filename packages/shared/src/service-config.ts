/**
 * Shapes of a service's configuration, stored as immutable versions in
 * `service_configs` (one JSON column per part) and validated by the API's
 * zod schemas, which must stay assignable to these types.
 *
 * A deployment references the exact config version it ran with, so rollback
 * replays it and diffs between deployments are exact.
 *
 * @module
 */

/** Run an image reference as-is: no build. */
export interface ImageSource {
  type: "image";
  /** Image reference, e.g. `nginx:1.27` or `ghcr.io/acme/api@sha256:…`. */
  image: string;
}

/** Clone a repository and build it. */
export interface GitSource {
  type: "git";
  /** `https://` clone URL. Public repositories need no GitHub App. */
  repo_url: string;
  /** Branch whose pushes deploy this service. */
  branch: string;
  /** Directory inside the repository to build from; `.` for the root. */
  root_dir: string;
  /** GitHub App installation that can read the repository, when private. */
  github_installation_id?: string;
}

/** Where a service's code comes from. */
export type ServiceSource = ImageSource | GitSource;

/** Image builders for git sources. */
export const BUILDERS = ["railpack", "dockerfile"] as const;

/** Image builder; see {@link BUILDERS}. */
export type Builder = (typeof BUILDERS)[number];

/** How a git source is built. Ignored for image sources. */
export interface BuildConfig {
  builder: Builder;
  /** Relative to `root_dir`; defaults to `Dockerfile`. Only for the `dockerfile` builder. */
  dockerfile_path?: string;
  /** Build-time arguments; may contain variable references. */
  build_args: Record<string, string>;
}

/** Container restart policies. */
export const RESTART_POLICIES = ["always", "on_failure", "never"] as const;

/** Container restart policy; see {@link RESTART_POLICIES}. */
export type RestartPolicy = (typeof RESTART_POLICIES)[number];

/** How a service runs once built. */
export interface DeployConfig {
  /** Overrides the image's command, as a shell command line. */
  start_command?: string;
  /** Replicas per environment; 0 stops the service without deleting it. */
  replicas: number;
  restart_policy: RestartPolicy;
  /** Restart attempts for `on_failure`. */
  max_retries: number;
  /** Seconds an old replica keeps serving after traffic moves to the new one. */
  drain_s: number;
  /** Runs once in a new container before the rollout (e.g. migrations). */
  pre_deploy_command?: string;
}

/** Per-replica limits. */
export interface ResourcesConfig {
  /** Thousandths of a core. */
  cpu_millis: number;
  memory_mb: number;
}

/** Health probe types. */
export const HEALTHCHECK_TYPES = ["http", "tcp", "none"] as const;

/** Health probe type; see {@link HEALTHCHECK_TYPES}. */
export type HealthcheckType = (typeof HEALTHCHECK_TYPES)[number];

/** Health probe run before a replica receives traffic. */
export interface HealthcheckConfig {
  type: HealthcheckType;
  /** Request path for `http` probes. */
  path?: string;
  /** Defaults to `networking.port`. */
  port?: number;
  interval_s: number;
  timeout_s: number;
  retries: number;
  start_period_s: number;
}

/** How a service is reached. */
export interface NetworkingConfig {
  /** Port the app listens on, injected as `PORT`. `null` for services with no listener. */
  port: number | null;
  /** Whether the service gets a `<service>-<env>-<xxxx>.<apps_domain>` hostname. */
  generated_domain: boolean;
}

/** Constraints on which nodes may run the service. */
export interface PlacementConfig {
  /** Node labels that must all match exactly. */
  node_selector: Record<string, string>;
}

/** Every part of one immutable config version. */
export interface ServiceConfigSpec {
  source: ServiceSource;
  build: BuildConfig;
  deploy: DeployConfig;
  resources: ResourcesConfig;
  healthcheck: HealthcheckConfig | null;
  networking: NetworkingConfig;
  placement: PlacementConfig;
}

/** PID limit applied to every replica; not user-configurable in Phase 1. */
export const DEFAULT_PIDS_LIMIT = 4096;

/**
 * Config of a newly created service before the user changes anything.
 *
 * @param source - Where the service's code comes from, chosen at creation.
 * @returns A fresh config object the caller may modify.
 * @example
 * defaultServiceConfig({ type: "image", image: "nginx:1.27" }).deploy.replicas; // 1
 */
export function defaultServiceConfig(source: ServiceSource): ServiceConfigSpec {
  return {
    source,
    build: { builder: "railpack", build_args: {} },
    deploy: { replicas: 1, restart_policy: "on_failure", max_retries: 10, drain_s: 10 },
    resources: { cpu_millis: 1000, memory_mb: 512 },
    healthcheck: null,
    networking: { port: 8080, generated_domain: false },
    placement: { node_selector: {} },
  };
}
