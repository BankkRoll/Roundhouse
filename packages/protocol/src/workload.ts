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
import {
  boundedString,
  ENV_KEY_RE,
  HostnameString,
  IdString,
  IMAGE_REFERENCE_RE,
  LABEL_KEY_RE,
  MAX_ARG_BYTES,
  MAX_ARGS,
  MAX_ENV_KEY_BYTES,
  MAX_ENV_TOTAL_BYTES,
  MAX_ENV_VALUE_BYTES,
  MAX_ENV_VARS,
  MAX_LABEL_KEY_BYTES,
  MAX_LABEL_VALUE_BYTES,
  MAX_LABELS,
  MAX_PORTS,
  MAX_ROUTES,
  NETWORK_RE,
  PATH_PREFIX_RE,
  PortNumber,
  SPEC_HASH_RE,
  utf8ByteLength,
} from "./limits";

// -----------------------------------------------------------------------------
// Enums
// -----------------------------------------------------------------------------

/**
 * `service`: a replica of a user deployment, listed in `desired_state`.
 * `system`: infrastructure the agent runs for itself (registry, BuildKit);
 * never sent by the control plane, only reported back in statuses.
 */
export const WORKLOAD_KINDS = ["service", "system"] as const;

/** Kind of workload; see {@link WORKLOAD_KINDS}. */
export type WorkloadKind = (typeof WORKLOAD_KINDS)[number];

/** How a container port is exposed: `http` ports can carry Caddy routes. */
export const PORT_PROTOCOLS = ["http", "tcp"] as const;

/** Port protocol; see {@link PORT_PROTOCOLS}. */
export type PortProtocol = (typeof PORT_PROTOCOLS)[number];

/** Health probe the agent runs against a replica. `none` reports healthy once running. */
export const HEALTHCHECK_TYPES = ["http", "tcp", "none"] as const;

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
 * @returns `openrail-<project_id>`.
 */
export function projectNetworkName(projectId: string): string {
  return `openrail-${projectId}`;
}

/** Longest Docker network name {@link NETWORK_RE} admits. */
export const MAX_NETWORK_NAME_LENGTH = 128;

/** Prefix of the hashed form of {@link environmentNetworkName}. */
export const HASHED_NETWORK_PREFIX = "openrail-env-";

/**
 * Docker network for one environment of a project. Every replica of the
 * environment joins it, so its services reach each other by private domain,
 * and nothing outside the environment can reach them: environments never
 * share a network.
 *
 * The readable `openrail-<project_id>-<environment_id>` is used whenever it
 * fits {@link MAX_NETWORK_NAME_LENGTH}. Longer IDs get
 * `openrail-env-<sha256(project_id "/" environment_id) in hex>`, which never
 * equals a readable name: IDs always contain `_`, hex digits never do.
 * Go's `EnvironmentNetworkName` returns the same name, which
 * `fixtures/network-names.json` checks.
 *
 * @param projectId - Project ID.
 * @param environmentId - Environment ID.
 * @returns The network name; it always matches {@link NETWORK_RE}.
 * @example
 * await environmentNetworkName("prj_1", "env_2"); // "openrail-prj_1-env_2"
 */
export async function environmentNetworkName(
  projectId: string,
  environmentId: string,
): Promise<string> {
  const readable = `openrail-${projectId}-${environmentId}`;
  if (readable.length <= MAX_NETWORK_NAME_LENGTH) return readable;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${projectId}/${environmentId}`),
  );
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${HASHED_NETWORK_PREFIX}${hex}`;
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

/** Environment variables passed to the container. Values are already resolved. */
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

/** Docker labels on the container. The agent adds its own `openrail.*` labels on top. */
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

/** A container port the replica listens on. */
export const WorkloadPortSchema = z.object({
  container_port: PortNumber,
  protocol: z.enum(PORT_PROTOCOLS),
});

/** A container port the replica listens on. */
export type WorkloadPort = z.infer<typeof WorkloadPortSchema>;

/** A Caddy route to this replica. Only valid for ports declared with protocol `http`. */
export const WorkloadRouteSchema = z.object({
  hostname: HostnameString,
  container_port: PortNumber,
  /** Defaults to `/` (every path). */
  path_prefix: z
    .string()
    .max(256)
    .regex(PATH_PREFIX_RE, "expected a path starting with /")
    .optional(),
});

/** A Caddy route to this replica. */
export type WorkloadRoute = z.infer<typeof WorkloadRouteSchema>;

/** Health probe the agent runs before a replica counts as `healthy`. */
export const HealthcheckSchema = z
  .object({
    type: z.enum(HEALTHCHECK_TYPES),
    /** Request path for `http` probes; required for them and forbidden otherwise. */
    path: z.string().max(1024).regex(PATH_PREFIX_RE, "expected a path starting with /").optional(),
    port: PortNumber,
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
    env: EnvSchema,
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
     * recreates its container.
     */
    network: z.string().regex(NETWORK_RE, "expected a docker network name"),
    labels: LabelsSchema,
    /** Seconds the old replica keeps serving after its route is switched away. */
    drain_s: z.number().int().min(0).max(3600),
    /** `computeSpecHash` of this spec, lowercase hex. */
    spec_hash: z.string().regex(SPEC_HASH_RE, "expected a lowercase hex sha256"),
  })
  .superRefine((w, ctx) => {
    const owned = [w.project_id, w.environment_id, w.service_id, w.deployment_id];
    if (w.kind === "service" && owned.some((v) => v === null)) {
      ctx.addIssue({ code: "custom", message: "service workloads need every ownership id" });
    }
    if (w.kind === "system" && owned.some((v) => v !== null)) {
      ctx.addIssue({ code: "custom", message: "system workloads have no ownership ids" });
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

/** Configuration of the registry system workload on a builder node. */
export const RegistryConfigSchema = z.object({
  listen: z.literal(REGISTRY_LISTEN),
  storage: RegistryStorageSchema,
});

/** Configuration of the registry system workload on a builder node. */
export type RegistryConfig = z.infer<typeof RegistryConfigSchema>;
