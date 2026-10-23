/**
 * The workload contract: what a node runs ({@link WorkloadSpecSchema}), how
 * it is exposed through Caddy, and the node-level ingress and registry
 * settings carried by `desired_state`.
 *
 * Mirrored by `go/workload.go`; `computeSpecHash` (./spec-hash) and Go's
 * `SpecHash` must agree on every spec, which `fixtures/spec-hash.json` checks.
 *
 * @module
 */
import { z } from "zod";
import { SealedBoxSchema } from "./box";
import {
  BCRYPT_RE,
  boundedString,
  CidrString,
  ENV_KEY_RE,
  IdString,
  IMAGE_REFERENCE_RE,
  Ipv4String,
  isIPv4,
  isSafeMountPath,
  LABEL_KEY_RE,
  MAX_ARG_BYTES,
  MAX_ARGS,
  MAX_ENV_KEY_BYTES,
  MAX_ENV_TOTAL_BYTES,
  MAX_ENV_VALUE_BYTES,
  MAX_ENV_VARS,
  MAX_HSTS_MAX_AGE_S,
  MAX_LABEL_KEY_BYTES,
  MAX_LABEL_VALUE_BYTES,
  MAX_LABELS,
  MAX_MOUNTS_PER_WORKLOAD,
  MAX_PORTS,
  MAX_PUBLISH_CIDRS,
  MAX_REGISTRY_PULL_USERS,
  MAX_ROUTES,
  MAX_UPSTREAMS,
  MAX_VOLUME_SIZE_MB,
  MIN_VOLUME_SIZE_MB,
  NETWORK_RE,
  PATH_PREFIX_RE,
  PortNumber,
  REGISTRY_USER_RE,
  RouteHostnameString,
  SPEC_HASH_RE,
  utf8ByteLength,
} from "./limits";
import { sha256Hex } from "./sha256";

// -----------------------------------------------------------------------------
// Enums
// -----------------------------------------------------------------------------

/**
 * - `service`: a replica of a user deployment, listed in `desired_state`.
 * - `system`: infrastructure the agent runs for itself (registry, BuildKit);
 *   never sent by the control plane, only reported back in statuses.
 * - `route` (ADR 0005, from `MESH_PROTOCOL_VERSION`): ingress routes for a
 *   service with no replica on this node, proxied to `upstreams` over the
 *   mesh. No container and no environment; listed in `desired_state`.
 * - `job` (ADR 0010, from `JOBS_PROTOCOL_VERSION`): a run-to-completion
 *   container, sent only inside `job_run`, never in `desired_state`.
 */
export const WORKLOAD_KINDS = ["service", "system", "route", "job"] as const;

/** Kind of workload; see {@link WORKLOAD_KINDS}. */
export type WorkloadKind = (typeof WORKLOAD_KINDS)[number];

/** How a container port is exposed: `http` ports can carry Caddy routes. */
export const PORT_PROTOCOLS = ["http", "tcp"] as const;

/** Port protocol; see {@link PORT_PROTOCOLS}. */
export type PortProtocol = (typeof PORT_PROTOCOLS)[number];

/**
 * Health probe the agent runs against a replica. `none` reports healthy once
 * running. `exec` (ADR 0004, from `VOLUMES_PROTOCOL_VERSION`) runs `command`
 * inside the container and passes on exit code 0.
 */
export const HEALTHCHECK_TYPES = ["http", "tcp", "none", "exec"] as const;

/** Health probe type; see {@link HEALTHCHECK_TYPES}. */
export type HealthcheckType = (typeof HEALTHCHECK_TYPES)[number];

/** Container restart policies, as Docker understands them. */
export const RESTART_POLICIES = ["always", "on_failure", "never"] as const;

/** Container restart policy; see {@link RESTART_POLICIES}. */
export type RestartPolicy = (typeof RESTART_POLICIES)[number];

/**
 * Ingress TLS modes:
 * - `acme`: on-demand public certificates, gated by the agent's `ask` endpoint;
 * - `internal`: Caddy's local CA (development and tests);
 * - `off`: plain HTTP (tests).
 */
export const TLS_MODES = ["acme", "internal", "off"] as const;

/** Ingress TLS mode; see {@link TLS_MODES}. */
export type TlsMode = (typeof TLS_MODES)[number];

/**
 * Every `desired_state.tls_mode` value: {@link TLS_MODES} plus `managed`
 * (ADR 0009, from `CERTS_PROTOCOL_VERSION`), where certificates come from the
 * control plane in `cert_sync` and Caddy issues none itself. Kept apart from
 * {@link TLS_MODES}, which `@roundhouse/shared` mirrors as the settable modes,
 * until the domains stream adds `managed` there.
 */
export const INGRESS_TLS_MODES = [...TLS_MODES, "managed"] as const;

/** A `desired_state.tls_mode`; see {@link INGRESS_TLS_MODES}. */
export type IngressTlsMode = (typeof INGRESS_TLS_MODES)[number];

/**
 * How the agent replaces a replica (ADR 0004): `start_first` starts the new
 * container before stopping the old one; `stop_first` stops the old one (and
 * every holder of its volume) first. Absent means `start_first`.
 */
export const ROLLOUT_STRATEGIES = ["start_first", "stop_first"] as const;

/** Replacement order; see {@link ROLLOUT_STRATEGIES}. */
export type RolloutStrategy = (typeof ROLLOUT_STRATEGIES)[number];

/** Host addresses a TCP proxy port binds (ADR 0004). */
export const PUBLISH_HOST_IPS = ["0.0.0.0", "::"] as const;

/**
 * Registry roles (ADR 0005): `primary` on builders; `replica` reads the
 * primary's S3 bucket with read-only keys; `proxy` is a pull-through cache of
 * a filesystem primary over the mesh. Absent means `primary`.
 */
export const REGISTRY_MODES = ["primary", "replica", "proxy"] as const;

/** Registry role; see {@link REGISTRY_MODES}. */
export type RegistryMode = (typeof REGISTRY_MODES)[number];

/** Address the builder node's registry listens on. Fixed so image references are stable. */
export const REGISTRY_LISTEN = "127.0.0.1:5000";

/**
 * Builds the local-registry repository for a service's images. Repository
 * path components must be lowercase, so IDs are lowercased.
 *
 * @param projectId - Owning project ID.
 * @param serviceId - Service ID.
 * @returns A repository such as `127.0.0.1:5000/prj_01jab…/svc_01jab…`.
 */
export function localImageRepository(projectId: string, serviceId: string): string {
  return `${REGISTRY_LISTEN}/${projectId.toLowerCase()}/${serviceId.toLowerCase()}`;
}

/**
 * Phase 1's per-project network name.
 *
 * @deprecated One network per project let every environment reach every
 * other one. Use {@link environmentNetworkName}.
 * @param projectId - Project ID.
 * @returns `roundhouse-<project_id>`.
 */
export function projectNetworkName(projectId: string): string {
  return `roundhouse-${projectId}`;
}

/** Longest Docker network name {@link NETWORK_RE} admits. */
export const MAX_NETWORK_NAME_LENGTH = 128;

/** Prefix of the hashed form of {@link environmentNetworkName}. */
export const HASHED_NETWORK_PREFIX = "roundhouse-env-";

/**
 * Docker network for one environment of a project. Every replica of the
 * environment joins it, so its services reach each other by private domain,
 * and nothing outside the environment can reach them: environments never
 * share a network.
 *
 * The readable `roundhouse-<project_id>-<environment_id>` is used whenever it
 * fits {@link MAX_NETWORK_NAME_LENGTH}. Longer IDs get
 * `roundhouse-env-<sha256(project_id "/" environment_id) in hex>`, which never
 * equals a readable name: IDs always contain `_`, hex digits never do.
 * Go's `EnvironmentNetworkName` returns the same name, which
 * `fixtures/network-names.json` checks.
 *
 * @param projectId - Project ID.
 * @param environmentId - Environment ID.
 * @returns The network name; it always matches {@link NETWORK_RE}.
 * @example
 * await environmentNetworkName("prj_1", "env_2"); // "roundhouse-prj_1-env_2"
 */
export async function environmentNetworkName(
  projectId: string,
  environmentId: string,
): Promise<string> {
  const readable = `roundhouse-${projectId}-${environmentId}`;
  if (readable.length <= MAX_NETWORK_NAME_LENGTH) return readable;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${projectId}/${environmentId}`),
  );
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${HASHED_NETWORK_PREFIX}${hex}`;
}

/**
 * Networks a service workload may never join, whatever the control plane
 * says: Docker's built-ins and the agent's own.
 */
export const RESERVED_NETWORKS = [
  "host",
  "bridge",
  "none",
  "roundhouse-system",
  "roundhouse-build",
] as const;

/**
 * Whether a service workload of `projectId`/`environmentId` may join
 * `network` (ADR 0014, H1): only its own environment network, or, while
 * Phase 1 replicas migrate, its own project's legacy
 * {@link projectNetworkName}. Never a reserved network or another project's.
 * Go's `ServiceNetworkAllowed` applies the same rule on the agent.
 *
 * @param network - The workload's `network`.
 * @param projectId - The workload's `project_id`.
 * @param environmentId - The workload's `environment_id`.
 * @returns `true` when the agent may attach the workload to `network`.
 * @example
 * isServiceNetworkAllowed("roundhouse-prj_1-env_2", "prj_1", "env_2"); // true
 * isServiceNetworkAllowed("roundhouse-prj_9-env_2", "prj_1", "env_2"); // false
 */
export function isServiceNetworkAllowed(
  network: string,
  projectId: string,
  environmentId: string,
): boolean {
  if ((RESERVED_NETWORKS as readonly string[]).includes(network)) return false;
  if (network === projectNetworkName(projectId)) return true;
  return network === environmentNetworkNameSync(projectId, environmentId);
}

// NOTE: zod refinements can't await WebCrypto, so validation recomputes
// `environmentNetworkName` with a synchronous SHA-256. The fixtures pin both.
function environmentNetworkNameSync(projectId: string, environmentId: string): string {
  const readable = `roundhouse-${projectId}-${environmentId}`;
  if (readable.length <= MAX_NETWORK_NAME_LENGTH) return readable;
  return `${HASHED_NETWORK_PREFIX}${sha256Hex(`${projectId}/${environmentId}`)}`;
}

/**
 * DNS alias every replica of a service answers to on its environment
 * network, derived from the service ID so it can't collide with or spoof
 * another service. Agents register it whatever the labels say.
 *
 * @param serviceId - Service ID.
 * @returns E.g. `svc-01jab….roundhouse.internal`.
 */
export function privateServiceAlias(serviceId: string): string {
  return `${serviceId.toLowerCase().replace(/_/g, "-")}.roundhouse.internal`;
}

/**
 * BuildKit cache scope of a service's builds. Agents also isolate BuildKit
 * per project, so the key only separates services within one project.
 *
 * @param projectId - Project ID.
 * @param serviceId - Service ID.
 * @returns `<project_id>.<service_id>`.
 */
export function buildCacheKey(projectId: string, serviceId: string): string {
  return `${projectId}.${serviceId}`;
}

// -----------------------------------------------------------------------------
// Parts
// -----------------------------------------------------------------------------

const NO_NUL = (s: string) => !s.includes("\0");

/** Command-line argument vector; empty vectors are not allowed, omit the field instead. */
const ArgsSchema = z
  .array(boundedString(MAX_ARG_BYTES).refine(NO_NUL, { message: "must not contain NUL" }))
  .min(1)
  .max(MAX_ARGS);

/**
 * Environment variables of a container, resolved. Never sent in clear: the
 * control plane seals them into `WorkloadSpec.env_sealed` (see ./box).
 */
export const EnvSchema = z
  .record(
    z.string().max(MAX_ENV_KEY_BYTES).regex(ENV_KEY_RE, "expected an environment variable name"),
    boundedString(MAX_ENV_VALUE_BYTES).refine(NO_NUL, { message: "must not contain NUL" }),
  )
  .refine((env) => Object.keys(env).length <= MAX_ENV_VARS, {
    message: `at most ${MAX_ENV_VARS} variables`,
  })
  .refine(
    (env) =>
      Object.entries(env).reduce((n, [k, v]) => n + k.length + utf8ByteLength(v), 0) <=
      MAX_ENV_TOTAL_BYTES,
    { message: `at most ${MAX_ENV_TOTAL_BYTES} bytes of variables` },
  );

/** Docker labels on the container. The agent adds its own `roundhouse.*` labels on top. */
export const LabelsSchema = z
  .record(
    z.string().max(MAX_LABEL_KEY_BYTES).regex(LABEL_KEY_RE, "expected a label key"),
    boundedString(MAX_LABEL_VALUE_BYTES),
  )
  .refine((labels) => Object.keys(labels).length <= MAX_LABELS, {
    message: `at most ${MAX_LABELS} labels`,
  });

/** Credentials for pulling a private image. */
export const RegistryAuthSchema = z.object({
  /** Registry host, optionally with a port: `ghcr.io`, `registry.example.com:5000`. */
  server: z
    .string()
    .max(260)
    .regex(/^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/, "expected a registry host"),
  username: boundedString(256, 1),
  password: boundedString(4096, 1),
});

/** Credentials for pulling a private image. */
export type RegistryAuth = z.infer<typeof RegistryAuthSchema>;

/**
 * Publishes a container port on the node (ADR 0004, TCP proxy; from
 * `VOLUMES_PROTOCOL_VERSION`). Docker binds it; the agent drops every source
 * outside `WorkloadSpec.publish_allowed_cidrs` with a final nftables rule.
 */
export const PortPublishSchema = z.object({
  host_port: z.number().int().min(1024).max(65535),
  host_ip: z.enum(PUBLISH_HOST_IPS),
});

/** Publishes a container port on the node. */
export type PortPublish = z.infer<typeof PortPublishSchema>;

/** A container port the replica listens on. */
export const WorkloadPortSchema = z.object({
  container_port: PortNumber,
  protocol: z.enum(PORT_PROTOCOLS),
  /** Part of the spec hash: publishing recreates the container once. */
  publish: PortPublishSchema.optional(),
});

/** A container port the replica listens on. */
export type WorkloadPort = z.infer<typeof WorkloadPortSchema>;

/**
 * `Strict-Transport-Security` for a route (ADR 0009, from
 * `CERTS_PROTOCOL_VERSION`). Sent on the HTTPS server only, never on :80.
 */
export const RouteHstsSchema = z
  .object({
    max_age: z.number().int().min(0).max(MAX_HSTS_MAX_AGE_S),
    include_subdomains: z.boolean(),
    preload: z.boolean(),
  })
  .refine((h) => !h.preload || (h.include_subdomains && h.max_age >= 31_536_000), {
    message: "preload needs include_subdomains and max_age >= 31536000",
    path: ["preload"],
  });

/** HSTS for a route. */
export type RouteHsts = z.infer<typeof RouteHstsSchema>;

/** A Caddy route to this replica. Only valid for ports declared with protocol `http`. */
export const WorkloadRouteSchema = z.object({
  /**
   * A lowercase hostname; a leading `*.` wildcard label only from
   * `CERTS_PROTOCOL_VERSION` (an older agent rejects the frame).
   */
  hostname: RouteHostnameString,
  container_port: PortNumber,
  /** Defaults to `/` (every path). */
  path_prefix: z
    .string()
    .max(256)
    .regex(PATH_PREFIX_RE, "expected a path starting with /")
    .optional(),
  /** Absent or `null` means no HSTS header. Not hashed (routes never are). */
  hsts: RouteHstsSchema.nullish(),
});

/** A Caddy route to this replica. */
export type WorkloadRoute = z.infer<typeof WorkloadRouteSchema>;

const NO_NUL_ARG = boundedString(MAX_ARG_BYTES).refine((s) => !s.includes("\0"), {
  message: "must not contain NUL",
});

/** Health probe the agent runs before a replica counts as `healthy`. */
export const HealthcheckSchema = z
  .object({
    type: z.enum(HEALTHCHECK_TYPES),
    /** Request path for `http` probes; required for them and forbidden otherwise. */
    path: z.string().max(1024).regex(PATH_PREFIX_RE, "expected a path starting with /").optional(),
    /** Probed port; required for every type except `exec`, which has none. */
    port: PortNumber.optional(),
    /**
     * Argument vector `exec` probes run inside the container (no shell unless
     * the vector names one); required for them and forbidden otherwise.
     */
    command: z.array(NO_NUL_ARG).min(1).max(MAX_ARGS).optional(),
    interval_s: z.number().int().min(1).max(3600),
    timeout_s: z.number().int().min(1).max(300),
    /** Consecutive failures before the replica is `unhealthy`. */
    retries: z.number().int().min(0).max(100),
    /** Grace period after start during which failures don't count. */
    start_period_s: z.number().int().min(0).max(3600),
  })
  .refine((h) => (h.type === "http") === (h.path !== undefined), {
    message: "path is required for http probes and only allowed for them",
    path: ["path"],
  })
  .refine((h) => (h.type === "exec") === (h.command !== undefined), {
    message: "command is required for exec probes and only allowed for them",
    path: ["command"],
  })
  .refine((h) => (h.type === "exec") === (h.port === undefined), {
    message: "port is required for every probe except exec, which has none",
    path: ["port"],
  });

/** Health probe the agent runs before a replica counts as `healthy`. */
export type Healthcheck = z.infer<typeof HealthcheckSchema>;

/** Hard resource limits applied to the container. */
export const ResourcesSchema = z.object({
  /** CPU limit in thousandths of a core (1000 = one core). */
  cpu_millis: z.number().int().min(10).max(512_000),
  /** Memory limit in MiB. Never overcommitted by the scheduler. */
  memory_mb: z.number().int().min(16).max(2_097_152),
  /** Maximum number of processes in the container. */
  pids: z.number().int().min(16).max(65_536),
});

/** Hard resource limits applied to the container. */
export type Resources = z.infer<typeof ResourcesSchema>;

/** What Docker does when the container exits. */
export const RestartSchema = z.object({
  policy: z.enum(RESTART_POLICIES),
  /** Restart attempts for `on_failure`; ignored by the other policies. */
  max_retries: z.number().int().min(0).max(1000),
});

/** What Docker does when the container exits. */
export type Restart = z.infer<typeof RestartSchema>;

/**
 * A volume bound into the container (ADR 0004, from
 * `VOLUMES_PROTOCOL_VERSION`). The agent binds `<root>/mnt/<volume_id>/data`
 * at `path`; the volume must be listed in the same `desired_state.volumes`
 * and belong to the workload's service.
 */
export const WorkloadMountSchema = z.object({
  volume_id: IdString,
  path: z
    .string()
    .refine(isSafeMountPath, { message: "expected an absolute, non-reserved mount path" }),
  read_only: z.boolean(),
});

/** A volume bound into the container. */
export type WorkloadMount = z.infer<typeof WorkloadMountSchema>;

/** A remote replica a route-only workload proxies to: its mesh IP and container port (ADR 0005). */
export const UpstreamSchema = z.object({
  ip: Ipv4String,
  port: PortNumber,
});

/** A remote replica a route-only workload proxies to. */
export type Upstream = z.infer<typeof UpstreamSchema>;

// -----------------------------------------------------------------------------
// WorkloadSpec
// -----------------------------------------------------------------------------

/**
 * One container a node should run: a single replica of a deployment, or a
 * system workload the agent manages itself.
 *
 * The agent recreates the container whenever {@link WorkloadSpec.spec_hash}
 * changes. Routes, `registry_auth` and `drain_s` are excluded from the hash
 * because they change without a restart; see `SPEC_HASH_EXCLUDED_FIELDS`.
 */
export const WorkloadSpecSchema = z
  .object({
    /** Stable per deployment replica (`wl_…`); system workloads use `sys_<name>`. */
    id: IdString,
    kind: z.enum(WORKLOAD_KINDS),
    /** `null` only for `system` workloads, as are the other ownership IDs. */
    project_id: IdString.nullable(),
    environment_id: IdString.nullable(),
    service_id: IdString.nullable(),
    deployment_id: IdString.nullable(),
    /** Zero-based replica index within the deployment. */
    replica: z.number().int().min(0).max(999),
    /**
     * Image to run. Git-built services use a digest reference in the local
     * registry; image sources and system workloads may use a tag.
     */
    image: z.string().max(1024).regex(IMAGE_REFERENCE_RE, "expected an image reference"),
    /** Pull credentials, when the image is private. */
    registry_auth: RegistryAuthSchema.nullish(),
    /** Overrides the image's `CMD`. */
    command: ArgsSchema.optional(),
    /** Overrides the image's `ENTRYPOINT`. */
    entrypoint: ArgsSchema.optional(),
    /**
     * The resolved environment and secret files, sealed to the node; see
     * `SealedWorkloadEnvSchema`, `workloadEnvAad` and, for jobs, `jobEnvAad`.
     * Set exactly for `service` and `job` workloads. Excluded from the spec
     * hash: a workload ID's environment never changes (a new deployment
     * mints new workload IDs).
     */
    env_sealed: SealedBoxSchema.nullable(),
    ports: z.array(WorkloadPortSchema).max(MAX_PORTS),
    routes: z.array(WorkloadRouteSchema).max(MAX_ROUTES),
    /** `null` behaves like a `none` probe. */
    healthcheck: HealthcheckSchema.nullable(),
    resources: ResourcesSchema,
    restart: RestartSchema,
    /**
     * Docker network to attach to: `environmentNetworkName(project_id,
     * environment_id)` for service workloads, so environments are isolated.
     * Part of the spec hash, so moving a replica to another network
     * recreates its container. See {@link isServiceNetworkAllowed}.
     */
    network: z.string().regex(NETWORK_RE, "expected a docker network name"),
    labels: LabelsSchema,
    /** Seconds the old replica keeps serving after its route is switched away. */
    drain_s: z.number().int().min(0).max(3600),
    /** `computeSpecHash` of this spec, lowercase hex. */
    spec_hash: z.string().regex(SPEC_HASH_RE, "expected a lowercase hex sha256"),

    // Phase 2 (protocol 5): volumes, rollout, TCP proxy, mesh.

    /** Volumes bound into the container; `service` workloads only. Hashed. */
    mounts: z.array(WorkloadMountSchema).min(1).max(MAX_MOUNTS_PER_WORKLOAD).optional(),
    /** Replacement order; absent means `start_first`. Not hashed. */
    rollout: z.enum(ROLLOUT_STRATEGIES).optional(),
    /** SIGTERM → SIGKILL grace when stopping the container; absent means 10. Not hashed. */
    stop_grace_s: z.number().int().min(0).max(600).optional(),
    /**
     * Sources admitted to `ports[].publish`; required exactly when a port is
     * published. Not hashed: the agent's nftables rule changes in place.
     */
    publish_allowed_cidrs: z.array(CidrString).min(1).max(MAX_PUBLISH_CIDRS).optional(),
    /**
     * The replica's mesh IP, NATed 1:1 to its bridge IP (ADR 0005). Not
     * hashed: a new mesh IP changes NAT rules, not the container.
     */
    mesh_ip: Ipv4String.optional(),
    /** Use the node's private DNS (`mesh.dns_address`) as resolver. Hashed. */
    private_dns: z.boolean().optional(),
    /**
     * Remote replicas of a `route` workload. Not hashed: the agent's upstream
     * DNS answers change in place, as `routes` do.
     */
    upstreams: z.array(UpstreamSchema).min(1).max(MAX_UPSTREAMS).optional(),
  })
  .superRefine((w, ctx) => {
    const issue = (message: string, path?: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, ...(path ? { path } : {}) });
    const owned = [w.project_id, w.environment_id, w.service_id, w.deployment_id];
    if (w.kind !== "system" && owned.some((v) => v === null)) {
      issue(`${w.kind} workloads need every ownership id`);
    }
    if (w.kind === "system" && owned.some((v) => v !== null)) {
      issue("system workloads have no ownership ids");
    }
    if ((w.kind === "service" || w.kind === "job") !== (w.env_sealed !== null)) {
      issue("env_sealed is required for service and job workloads and forbidden otherwise", [
        "env_sealed",
      ]);
    }
    if (w.mounts && w.kind !== "service") issue("only service workloads mount volumes", ["mounts"]);
    if (w.upstreams && w.kind !== "route")
      issue("only route workloads have upstreams", ["upstreams"]);
    if (w.kind === "route") {
      if (!w.upstreams) issue("route workloads need upstreams", ["upstreams"]);
      if (w.routes.length === 0) issue("route workloads need routes", ["routes"]);
      if (w.healthcheck !== null) issue("route workloads have no healthcheck", ["healthcheck"]);
      if (w.mesh_ip !== undefined) issue("route workloads have no mesh ip", ["mesh_ip"]);
    }
    if (w.kind === "job") {
      if (w.routes.length > 0 || w.ports.length > 0) {
        issue("job workloads have no ports or routes", ["ports"]);
      }
      if (w.healthcheck !== null) issue("job workloads have no healthcheck", ["healthcheck"]);
      if (w.restart.policy !== "never" || w.restart.max_retries !== 0) {
        issue("job workloads never restart", ["restart"]);
      }
    }
    const published = w.ports.filter((p) => p.publish);
    if (published.length > 0 && w.kind !== "service") {
      issue("only service workloads publish ports", ["ports"]);
    }
    if (published.length > 0 !== (w.publish_allowed_cidrs !== undefined)) {
      issue("publish_allowed_cidrs is required exactly when a port is published", [
        "publish_allowed_cidrs",
      ]);
    }
    if (new Set(published.map((p) => p.publish!.host_port)).size !== published.length) {
      issue("duplicate published host port", ["ports"]);
    }
    if (w.mounts) {
      const ids = new Set(w.mounts.map((m) => m.volume_id));
      const paths = new Set(w.mounts.map((m) => m.path));
      if (ids.size !== w.mounts.length || paths.size !== w.mounts.length) {
        issue("mounts must name distinct volumes and paths", ["mounts"]);
      }
    }
    if (w.kind !== "system" && w.project_id && w.environment_id && w.service_id) {
      if (!isServiceNetworkAllowed(w.network, w.project_id, w.environment_id)) {
        issue(`${w.kind} workloads must join their own environment network`, ["network"]);
      }
      if (w.image.startsWith(`${REGISTRY_LISTEN}/`)) {
        const repo = localImageRepository(w.project_id, w.service_id);
        const digest = w.image.startsWith(`${repo}@sha256:`) ? w.image.slice(repo.length + 8) : "";
        if (!/^[a-f0-9]{64}$/.test(digest)) {
          ctx.addIssue({
            code: "custom",
            message: `local registry images must be ${repo}@sha256:…`,
            path: ["image"],
          });
        }
      }
    }
    const ports = new Set<number>();
    for (const p of w.ports) {
      if (ports.has(p.container_port)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate port ${p.container_port}`,
          path: ["ports"],
        });
      }
      ports.add(p.container_port);
    }
    const http = new Set(w.ports.filter((p) => p.protocol === "http").map((p) => p.container_port));
    const routes = new Set<string>();
    w.routes.forEach((r, i) => {
      if (!http.has(r.container_port)) {
        ctx.addIssue({
          code: "custom",
          message: `route targets port ${r.container_port}, which is not an http port`,
          path: ["routes", i, "container_port"],
        });
      }
      const key = `${r.hostname}${r.path_prefix ?? "/"}`;
      if (routes.has(key)) {
        ctx.addIssue({ code: "custom", message: `duplicate route ${key}`, path: ["routes", i] });
      }
      routes.add(key);
    });
  });

/** One container a node should run. */
export type WorkloadSpec = z.infer<typeof WorkloadSpecSchema>;

/**
 * @deprecated Use {@link WorkloadSpecSchema}. Phase 0's minimal workload
 * (`id`, `image`) is a subset of it, so Phase 0 agents still read its fields.
 */
export const WorkloadSchema = WorkloadSpecSchema;

/** @deprecated Use {@link WorkloadSpec}. */
export type Workload = WorkloadSpec;

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

/** Registry storage on the builder's local disk. */
export const FilesystemStorageSchema = z.object({ type: z.literal("filesystem") });

/** Registry storage in an S3-compatible bucket (R2 included). */
export const S3StorageSchema = z.object({
  type: z.literal("s3"),
  /** `https://<account>.r2.cloudflarestorage.com`, or any S3 endpoint. */
  endpoint: z
    .string()
    .max(2048)
    .regex(/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/, "expected an http(s) endpoint URL"),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "expected a bucket name"),
  /** `auto` for R2. */
  region: z.string().regex(/^[a-z0-9-]{1,64}$/, "expected a region"),
  access_key_id: boundedString(256, 1),
  secret_access_key: boundedString(256, 1),
});

/** Where the builder's registry keeps blobs. */
export const RegistryStorageSchema = z.discriminatedUnion("type", [
  FilesystemStorageSchema,
  S3StorageSchema,
]);

/** Where the builder's registry keeps blobs. */
export type RegistryStorage = z.infer<typeof RegistryStorageSchema>;

/** A node allowed to pull from a primary registry over the mesh (htpasswd). */
export const RegistryPullUserSchema = z.object({
  username: z.string().regex(REGISTRY_USER_RE, "expected a registry user name"),
  /** bcrypt of the user's password; the password itself goes to that node only. */
  bcrypt: z.string().regex(BCRYPT_RE, "expected a bcrypt hash"),
});

/** A node allowed to pull from a primary registry over the mesh. */
export type RegistryPullUser = z.infer<typeof RegistryPullUserSchema>;

/** The primary a `proxy` registry pulls through, reached over the mesh. */
export const RegistryUpstreamSchema = z.object({
  /** E.g. `http://10.200.3.1:5000`; plain HTTP because the hop is inside WireGuard. */
  url: z
    .string()
    .max(2048)
    .regex(/^https?:\/\/[^\s/?#]+\/?$/, "expected an http(s) registry URL"),
  username: z.string().regex(REGISTRY_USER_RE, "expected a registry user name"),
  /** `SealedRegistryUpstreamSchema`, AAD `registryUpstreamAad`. */
  password_sealed: SealedBoxSchema,
});

/** The primary a `proxy` registry pulls through. */
export type RegistryUpstream = z.infer<typeof RegistryUpstreamSchema>;

/**
 * Configuration of the registry system workload. Builders run `primary`;
 * from `MESH_PROTOCOL_VERSION`, other meshed nodes run `replica` (S3
 * storage) or `proxy` (filesystem cache of a primary's `mesh_listen`).
 */
export const RegistryConfigSchema = z
  .object({
    listen: z.literal(REGISTRY_LISTEN),
    storage: RegistryStorageSchema,
    /** Absent means `primary`. */
    mode: z.enum(REGISTRY_MODES).optional(),
    /** `primary` with filesystem storage only: `<mesh .1 address>:5000`, reachable from `@nodes`. */
    mesh_listen: z
      .string()
      .regex(/^[0-9.]+:5000$/, "expected <mesh address>:5000")
      .refine((s) => isIPv4(s.slice(0, -5)), { message: "expected an IPv4 mesh address" })
      .optional(),
    /** `proxy` only. */
    upstream: RegistryUpstreamSchema.optional(),
    /** With `mesh_listen` only: one user per node that may pull. */
    pull_users: z.array(RegistryPullUserSchema).min(1).max(MAX_REGISTRY_PULL_USERS).optional(),
  })
  .superRefine((r, ctx) => {
    const mode = r.mode ?? "primary";
    const issue = (message: string, path: string) =>
      ctx.addIssue({ code: "custom", message, path: [path] });
    if (mode === "replica" && r.storage.type !== "s3") issue("replicas need s3 storage", "storage");
    if (mode === "proxy" && r.storage.type !== "filesystem") {
      issue("proxies cache on the filesystem", "storage");
    }
    if ((mode === "proxy") !== (r.upstream !== undefined)) {
      issue("upstream is required for proxies and only allowed for them", "upstream");
    }
    if (r.mesh_listen && (mode !== "primary" || r.storage.type !== "filesystem")) {
      issue("mesh_listen is only for filesystem primaries", "mesh_listen");
    }
    if (r.pull_users && !r.mesh_listen) issue("pull_users need mesh_listen", "pull_users");
    if (r.pull_users && new Set(r.pull_users.map((u) => u.username)).size !== r.pull_users.length) {
      issue("duplicate pull user", "pull_users");
    }
  });

/** Configuration of the registry system workload on a builder node. */
export type RegistryConfig = z.infer<typeof RegistryConfigSchema>;

// -----------------------------------------------------------------------------
// Volumes
// -----------------------------------------------------------------------------

/**
 * A volume the node holds (ADR 0004, from `VOLUMES_PROTOCOL_VERSION`).
 * `desired_state.volumes` lists every one, including those of services
 * scaled to zero. The agent never deletes a volume missing from the list; it
 * reports it `orphaned`, and only `volume_delete` removes data.
 */
export const VolumeSpecSchema = z.object({
  id: IdString,
  /** Quota; grow-only. */
  size_mb: z.number().int().min(MIN_VOLUME_SIZE_MB).max(MAX_VOLUME_SIZE_MB),
  project_id: IdString,
  environment_id: IdString,
  service_id: IdString,
  /** `"uid:gid"` a fresh data directory is chowned to; `null` uses the image's user. */
  owner: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9})$/, "expected uid:gid")
    .nullable(),
});

/** A volume the node holds. */
export type VolumeSpec = z.infer<typeof VolumeSpecSchema>;
