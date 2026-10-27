/**
 * Response/request schemas shared across routes. They drive both runtime
 * validation and the generated OpenAPI document.
 *
 * - Phase 0: errors, workspaces, members, invites, nodes, audit log.
 * - Phase 1: projects, environments, services and their config versions,
 *   deployments, builds, logs, domains, instance settings, the GitHub App,
 *   and realtime messages. Routes using them are in `./contracts`.
 * - ADR 0014, one file per stream under `./schemas/` and re-exported here:
 *   variables, access (teams, grants, protection), auth (2FA, re-auth),
 *   instance (admins, workspaces, audit) and keys (rotation).
 * - API tokens and project summaries.
 *
 * Config part schemas are checked against the `@roundhouse/shared` types they
 * store (`satisfies z.ZodType<…>`), so the API, the database and the
 * dashboard can't drift apart.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import {
  CapabilitiesSchema,
  HOSTNAME_RE,
  IMAGE_REFERENCE_RE,
  INGRESS_TLS_MODES,
  type IngressTlsMode,
  isSafeGitRef,
  isSafeRelativePath,
  LABEL_KEY_RE,
  LOG_STREAMS,
  MAX_HOSTNAME_LENGTH,
  WORKLOAD_STATES,
} from "@roundhouse/protocol";
import {
  API_TOKEN_SCOPES,
  AUDIT_ACTIONS,
  AUDIT_ACTOR_TYPES,
  BUILD_STATUSES,
  BUILDERS,
  type BuildConfig,
  DEPLOYMENT_EVENT_TYPES,
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_TRIGGERS,
  type DeployConfig,
  DNS_RECORD_PURPOSES,
  DNS_RECORD_STATES,
  DNS_RECORD_TYPES,
  DOMAIN_MODES,
  DOMAIN_STATUSES,
  DOMAIN_TLS_STATUSES,
  DOMAIN_TYPES,
  DOMAIN_VERIFICATION_STATUSES,
  ENVIRONMENT_KINDS,
  GITHUB_ACCOUNT_TYPES,
  HEALTHCHECK_TYPES,
  type HealthcheckConfig,
  MAX_API_TOKEN_TTL_DAYS,
  MAX_HSTS_MAX_AGE_S,
  MAX_LOG_RETENTION_DAYS,
  MAX_SHELL_RECORDING_RETENTION_DAYS,
  type NetworkingConfig,
  NODE_STATUSES,
  PLACEMENT_ONLY_STATES,
  type PlacementConfig,
  RESERVED_SERVICE_SLUGS,
  RESTART_POLICIES,
  type ResourcesConfig,
  ROLES,
  SERVICE_DATABASE_ENGINES,
  SERVICE_HEALTH,
  SERVICE_HEALTH_REASONS,
  SERVICE_KINDS,
  type ServiceSource,
  SHELL_RECORDING_MODES,
  secretBuildArgsValid,
  TLS_MODES,
  type TlsMode,
} from "@roundhouse/shared";
import {
  CanvasEdgesUpdatedMessageSchema,
  CanvasLayoutUpdatedMessageSchema,
  ChangeSetAppliedMessageSchema,
  ChangeSetUpdatedMessageSchema,
  PresenceColorSchema,
  PresenceEditingSchema,
  PresenceUpdateMessageSchema,
} from "./schemas/changes";
import { CloudflarePlacementSchema, ServiceProviderSchema } from "./schemas/cloudflare";
import { CronConfigFields, CronConfigSchema, CronRunUpdatedMessageSchema } from "./schemas/cron";
import { CostEstimateSchema } from "./schemas/providers";
import { VariableKeyField } from "./schemas/variables";

export * from "./schemas/access";
export * from "./schemas/auth";
export * from "./schemas/changes";
export * from "./schemas/cron";
export * from "./schemas/instance";
export * from "./schemas/keys";
export * from "./schemas/providers";
export * from "./schemas/variables";

/** Error envelope returned by every non-2xx response. */
export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      /** Per-field problems, e.g. each malformed `${{…}}` reference with its span. */
      details: z
        .array(
          z.object({
            field: z.string(),
            code: z.string(),
            message: z.string(),
            start: z.number().int().optional(),
            end: z.number().int().optional(),
          }),
        )
        .optional(),
    }),
  })
  .openapi("Error");

/** Unix-millisecond timestamp. */
export const Millis = z
  .number()
  .int()
  .openapi({ description: "Unix time in milliseconds", example: 1767225600000 });

/** Workspace role. */
export const RoleSchema = z.enum(ROLES).openapi("Role");

/** A workspace as seen by one of its members. */
export const WorkspaceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    role: RoleSchema,
    /**
     * Whether canvas edits stage into the environment's draft for review
     * (ADR 0006); off, the dashboard applies each edit as it is saved.
     */
    staged_changes: z.boolean(),
    created_at: Millis,
  })
  .openapi("Workspace");

/** A workspace member joined with their user profile. */
export const MemberSchema = z
  .object({
    id: z.string(),
    user_id: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    role: RoleSchema,
    created_at: Millis,
  })
  .openapi("Member");

/** A pending invite. The token is never returned after creation. */
export const InviteSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    role: RoleSchema,
    expires_at: Millis,
    created_at: Millis,
  })
  .openapi("Invite");

/** A machine running the node agent. */
export const NodeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    hostname: z.string().nullable(),
    status: z.enum(NODE_STATUSES),
    /** `server` for machines joined by hand, else the cloud provider that created it. */
    provider: z.string(),
    region: z.string().nullable(),
    /** The provider's server ID, for servers Roundhouse provisioned (deleting the node deletes it). */
    provider_server_id: z.string().nullable(),
    /** When the provider was first found to no longer have the server. */
    provider_server_missing_at: Millis.nullable(),
    /**
     * For servers Roundhouse provisioned: the plan's monthly price from the
     * provider's catalogue when it was created. An estimate, not the bill.
     */
    estimated_monthly_cost: CostEstimateSchema.nullable(),
    public_ip: z.string().nullable(),
    os: z.string().nullable(),
    arch: z.string().nullable(),
    kernel: z.string().nullable(),
    docker_version: z.string().nullable(),
    agent_version: z.string().nullable(),
    /**
     * Why the node gets no workloads or builds: `upgrade_agent` (its agent
     * predates sealed variables) or `no_encryption_key` (it registered no
     * key to seal them to); `null` when it can run them, or hasn't connected.
     */
    workloads_blocked: z.enum(["upgrade_agent", "no_encryption_key"]).nullable(),
    capabilities: CapabilitiesSchema.nullable(),
    cpu_total: z.number().nullable(),
    mem_total: z.number().nullable(),
    disk_total: z.number().nullable(),
    cpu_percent: z.number().nullable(),
    mem_used: z.number().nullable(),
    disk_used: z.number().nullable(),
    load1: z.number().nullable(),
    last_heartbeat_at: Millis.nullable(),
    created_at: Millis,
  })
  .openapi("Node");

/** One audit log entry. */
export const AuditLogSchema = z
  .object({
    id: z.string(),
    actor_type: z.enum(AUDIT_ACTOR_TYPES),
    actor_id: z.string().nullable(),
    actor_name: z.string().nullable(),
    action: z.enum(AUDIT_ACTIONS),
    target_type: z.string().nullable(),
    target_id: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    ip: z.string().nullable(),
    created_at: Millis,
  })
  .openapi("AuditLog");

/** Path params for workspace-scoped routes. */
export const WorkspaceParams = z.object({ workspaceId: z.string() });

/**
 * Standard error responses to spread into a route's `responses`.
 *
 * @param codes - HTTP statuses the route can fail with.
 * @returns OpenAPI response objects keyed by status.
 */
export function errors<const S extends number>(...codes: S[]) {
  return Object.fromEntries(
    codes.map((code) => [
      code,
      { description: "Error", content: { "application/json": { schema: ErrorSchema } } },
    ]),
  ) as Record<
    S,
    { description: string; content: { "application/json": { schema: typeof ErrorSchema } } }
  >;
}

/**
 * Wraps a schema as a JSON response object.
 *
 * @param schema - Body schema.
 * @param description - Human description for the docs.
 * @returns An OpenAPI response object.
 */
export function json<T extends z.ZodType>(schema: T, description = "OK") {
  return { description, content: { "application/json": { schema } } };
}

/**
 * Wraps a schema as a required JSON request body.
 *
 * @param schema - Body schema.
 * @returns A `request` fragment to spread into `createRoute`.
 */
export function body<T extends z.ZodType>(schema: T) {
  return { body: { required: true, content: { "application/json": { schema } } } } as const;
}

/** Name of the session-cookie security scheme registered in the OpenAPI document. */
export const SESSION_SCHEME = "session";

/** Name of the API-token security scheme registered in the OpenAPI document. */
export const TOKEN_SCHEME = "api_token";

/**
 * `security` requirement for routes a signed-in browser session or an API
 * token (`Authorization: Bearer tok_…`) may call; either one suffices.
 */
export const sessionAuth: Record<string, string[]>[] = [
  { [SESSION_SCHEME]: [] },
  { [TOKEN_SCHEME]: [] },
];

/** `security` requirement for routes only a browser session may call. */
export const sessionOnlyAuth: Record<string, string[]>[] = [{ [SESSION_SCHEME]: [] }];

// -----------------------------------------------------------------------------
// Phase 1: common fields
// -----------------------------------------------------------------------------

/** Display name of a project, environment or service. */
export const NameField = z.string().trim().min(1).max(100);

/** URL- and DNS-safe identifier, unique within its parent; see `slugify`. */
export const SlugField = z
  .string()
  .max(40)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "expected a lowercase slug")
  .openapi({ example: "api" });

/** Lowercase DNS hostname with at least two labels. */
export const HostnameField = z
  .string()
  .max(MAX_HOSTNAME_LENGTH)
  .regex(HOSTNAME_RE, "expected a lowercase hostname")
  .openapi({ example: "apps.example.com" });

/** Path inside a repository; no leading `/` and no `..`. */
export const RepoPathField = z
  .string()
  .refine(isSafeRelativePath, { message: "expected a relative path inside the repository" })
  .openapi({ example: "apps/web" });

/** Opaque pagination cursor from a previous page's `next_cursor`. */
export const CursorField = z.string().min(1).max(200).optional();

/** Page size for cursor-paginated lists. */
export const LimitField = z.coerce.number().int().min(1).max(100).default(50);

/** Port a process listens on. */
export const PortField = z.number().int().min(1).max(65535);

// -----------------------------------------------------------------------------
// Phase 1: projects, environments, services
// -----------------------------------------------------------------------------

/** A project in a workspace. */
export const ProjectSchema = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    created_at: Millis,
    updated_at: Millis,
  })
  .openapi("Project");

/** An environment of a project. */
export const EnvironmentSchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
    name: z.string(),
    slug: z.string(),
    kind: z.enum(ENVIRONMENT_KINDS),
    pr_number: z.number().int().nullable(),
    source_branch: z.string().nullable(),
    /** Whether protection rules narrow deploys, config and variable changes here (ADR 0014). */
    protected: z.boolean(),
    created_at: Millis,
  })
  .openapi("Environment");

/** A service of a project. Its config lives in versions per environment. */
export const ServiceSchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
    name: z.string(),
    slug: z.string(),
    kind: z.enum(SERVICE_KINDS),
    icon: z.string().nullable(),
    /** Set for database services: the registry engine and version it runs. */
    database: z
      .object({ engine: z.enum(SERVICE_DATABASE_ENGINES), version: z.string() })
      .nullable()
      .optional(),
    /**
     * Service-level health (ADR 0005), separate from deployment status:
     * `degraded` while a stateful replica's server is offline
     * (`node_offline`) or was drained by force (`node_maintenance`).
     */
    health: z.enum(SERVICE_HEALTH),
    health_reason: z.enum(SERVICE_HEALTH_REASONS).nullable(),
    created_at: Millis,
    updated_at: Millis,
  })
  .openapi("Service");

/** A project with everything the project canvas needs in one request. */
export const ProjectDetailSchema = ProjectSchema.extend({
  environments: z.array(EnvironmentSchema),
  services: z.array(ServiceSchema),
}).openapi("ProjectDetail");

/**
 * Service slug. A reserved one (`RESERVED_SERVICE_SLUGS`, the reference
 * namespaces) is accepted and suffixed like a taken one, e.g. `shared-2`.
 */
export const ServiceSlugField = SlugField.openapi({
  description: `Suffixed with -2, -3, … when taken or reserved (${RESERVED_SERVICE_SLUGS.join(", ")})`,
});

// -----------------------------------------------------------------------------
// Phase 1: service config parts
// -----------------------------------------------------------------------------

/** Run an image as-is. */
export const ImageSourceSchema = z.object({
  type: z.literal("image"),
  image: z.string().max(1024).regex(IMAGE_REFERENCE_RE, "expected an image reference"),
});

/** Git branch name; the same rule agents apply to build refs (`isSafeGitRef`). */
const BranchField = z
  .string()
  .min(1)
  .max(255)
  .refine(isSafeGitRef, { message: "expected a branch name" });

/** Build from a git repository. */
export const GitSourceSchema = z.object({
  type: z.literal("git"),
  repo_url: z
    .string()
    .max(2048)
    .regex(/^https:\/\/[^\s/@?#]+\/[^\s?#]+$/, "expected an https clone URL without credentials"),
  branch: BranchField,
  root_dir: RepoPathField,
  github_installation_id: z
    .string()
    .optional()
    .openapi({
      description:
        "Our ID (ghi_…) of a GitHub App installation the service's workspace claimed and that can " +
        "read repo_url, which must then be https://github.com/<owner>/<repo>. Tokens minted for it " +
        "are scoped to that one repository.",
    }),
});

/** Where a service's code comes from. */
export const ServiceSourceSchema = z
  .discriminatedUnion("type", [ImageSourceSchema, GitSourceSchema])
  .openapi("ServiceSource") satisfies z.ZodType<ServiceSource>;

const BuildConfigFields = z.object({
  builder: z.enum(BUILDERS),
  dockerfile_path: RepoPathField.optional(),
  build_args: z
    .record(VariableKeyField, z.string().max(4096))
    .refine((a) => Object.keys(a).length <= 64, { message: "at most 64 build args" }),
  secret_build_args: z
    .array(VariableKeyField)
    .max(64)
    .optional()
    .openapi({
      description:
        "Names of build_args whose values are secret. The builder passes them as BuildKit " +
        "secrets (read them with RUN --mount=type=secret,id=NAME,env=NAME), never as build " +
        "args, so they stay out of the image and its history, and redacts them from build logs.",
      example: ["NPM_TOKEN"],
    }),
});

/** How a git source is built. */
export const BuildConfigSchema = BuildConfigFields.refine(secretBuildArgsValid, {
  message: "secret_build_args must name distinct keys of build_args",
  path: ["secret_build_args"],
}).openapi("BuildConfig") satisfies z.ZodType<BuildConfig>;

const CommandField = z.string().min(1).max(4096);

const DeployConfigFields = z.object({
  start_command: CommandField.optional(),
  replicas: z.number().int().min(0).max(20),
  restart_policy: z.enum(RESTART_POLICIES),
  max_retries: z.number().int().min(0).max(100),
  drain_s: z.number().int().min(0).max(3600),
  pre_deploy_command: CommandField.optional(),
});

/** How a service runs. */
export const DeployConfigSchema = DeployConfigFields.openapi(
  "DeployConfig",
) satisfies z.ZodType<DeployConfig>;

const ResourcesConfigFields = z.object({
  cpu_millis: z.number().int().min(10).max(64_000),
  memory_mb: z.number().int().min(16).max(262_144),
});

/** Per-replica limits. */
export const ResourcesConfigSchema = ResourcesConfigFields.openapi(
  "ResourcesConfig",
) satisfies z.ZodType<ResourcesConfig>;

/** Health probe run before a replica receives traffic. */
export const HealthcheckConfigSchema = z
  .object({
    type: z.enum(HEALTHCHECK_TYPES),
    path: z
      .string()
      .max(1024)
      .regex(/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/, "expected a path starting with /")
      .optional(),
    port: PortField.optional(),
    interval_s: z.number().int().min(1).max(3600),
    timeout_s: z.number().int().min(1).max(300),
    retries: z.number().int().min(0).max(100),
    start_period_s: z.number().int().min(0).max(3600),
  })
  .refine((h) => (h.type === "http") === (h.path !== undefined), {
    message: "path is required for http probes and only allowed for them",
    path: ["path"],
  })
  .openapi("HealthcheckConfig") satisfies z.ZodType<HealthcheckConfig>;

const NetworkingConfigFields = z.object({
  port: PortField.nullable(),
  generated_domain: z.boolean(),
});

/** How a service is reached. */
export const NetworkingConfigSchema = NetworkingConfigFields.openapi(
  "NetworkingConfig",
) satisfies z.ZodType<NetworkingConfig>;

const PlacementConfigFields = z.object({
  node_selector: z
    .record(z.string().max(128).regex(LABEL_KEY_RE, "expected a label key"), z.string().max(256))
    .refine((s) => Object.keys(s).length <= 16, { message: "at most 16 selector labels" }),
  /** `nodes` when absent (ADR 0011). */
  provider: ServiceProviderSchema.optional(),
  /** Required with `provider: "cloudflare"`; kept when switching back. */
  cloudflare: CloudflarePlacementSchema.optional(),
});

/** Where a service runs: which nodes, or Cloudflare Containers (ADR 0011). */
export const PlacementConfigSchema = PlacementConfigFields.refine(
  (p) => p.provider !== "cloudflare" || p.cloudflare !== undefined,
  { message: "placement.cloudflare is required with provider cloudflare", path: ["cloudflare"] },
).openapi("PlacementConfig") satisfies z.ZodType<PlacementConfig>;

/** One immutable config version of a service in an environment. */
export const ServiceConfigSchema = z
  .object({
    id: z.string(),
    service_id: z.string(),
    environment_id: z.string(),
    version: z.number().int().positive(),
    created_by: z.string().nullable(),
    created_at: Millis,
    source: ServiceSourceSchema,
    build: BuildConfigSchema,
    deploy: DeployConfigSchema,
    resources: ResourcesConfigSchema,
    healthcheck: HealthcheckConfigSchema.nullable(),
    networking: NetworkingConfigSchema,
    placement: PlacementConfigSchema,
    /** Set exactly for `cron` services (ADR 0010). */
    cron: CronConfigSchema.nullable(),
  })
  .openapi("ServiceConfig");

/**
 * Changes to a service's config. Each part present is shallow-merged into the
 * latest version's part; `source` and `healthcheck` are replaced whole
 * (`healthcheck: null` removes the probe). The result is stored as a new
 * version, and absent parts carry over unchanged.
 */
export const ServiceConfigPatchSchema = z
  .object({
    source: ServiceSourceSchema.optional(),
    build: BuildConfigFields.partial().optional(),
    deploy: DeployConfigFields.partial().optional(),
    resources: ResourcesConfigFields.partial().optional(),
    healthcheck: HealthcheckConfigSchema.nullable().optional(),
    networking: NetworkingConfigFields.partial().optional(),
    placement: PlacementConfigFields.partial().optional(),
    /**
     * Merged into the latest `cron` part, or into the defaults when there is
     * none (`schedule` is then required); `null` removes it.
     */
    cron: CronConfigFields.partial().nullable().optional(),
  })
  .openapi("ServiceConfigPatch");

/** Names of the parts {@link ServiceConfigPatchSchema} accepts. */
export const SERVICE_CONFIG_PARTS = [
  "source",
  "build",
  "deploy",
  "resources",
  "healthcheck",
  "networking",
  "placement",
  "cron",
] as const;

// -----------------------------------------------------------------------------
// Phase 1: deployments, builds, logs, domains
// -----------------------------------------------------------------------------

/** An image build. */
export const BuildSchema = z
  .object({
    id: z.string(),
    deployment_id: z.string(),
    service_id: z.string(),
    commit_sha: z.string(),
    commit_message: z.string().nullable(),
    commit_author: z.string().nullable(),
    status: z.enum(BUILD_STATUSES),
    node_id: z.string().nullable(),
    image_repository: z.string(),
    image_digest: z.string().nullable(),
    started_at: Millis.nullable(),
    finished_at: Millis.nullable(),
    error: z.string().nullable(),
    created_at: Millis,
  })
  .openapi("Build");

/** A deployment, with its build when it has one. */
export const DeploymentSchema = z
  .object({
    id: z.string(),
    /** Project of the service, so a deployment link can be built without another lookup. */
    project_id: z.string(),
    service_id: z.string(),
    environment_id: z.string(),
    config_version: z.number().int().positive(),
    build_id: z.string().nullable(),
    build: BuildSchema.nullable(),
    image: z.string().nullable(),
    status: z.enum(DEPLOYMENT_STATUSES),
    trigger: z.enum(DEPLOYMENT_TRIGGERS),
    triggered_by: z.string().nullable(),
    rollback_of: z.string().nullable(),
    failure_reason: z.string().nullable(),
    started_at: Millis.nullable(),
    finished_at: Millis.nullable(),
    created_at: Millis,
    updated_at: Millis,
  })
  .openapi("Deployment");

/** One entry of a deployment's timeline. */
export const DeploymentEventSchema = z
  .object({
    id: z.string(),
    deployment_id: z.string(),
    type: z.enum(DEPLOYMENT_EVENT_TYPES),
    message: z.string(),
    data: z.record(z.string(), z.unknown()).nullable(),
    created_at: Millis,
  })
  .openapi("DeploymentEvent");

/** Where one replica runs and its last reported state. */
export const PlacementSchema = z
  .object({
    id: z.string(),
    deployment_id: z.string(),
    replica: z.number().int().nonnegative(),
    node_id: z.string(),
    node_name: z.string().nullable(),
    workload_id: z.string(),
    container_id: z.string().nullable(),
    /**
     * The agent's last report, or `lost` (its server went offline and it was
     * rescheduled) or `parked` (stopped by a forced drain) (ADR 0005).
     */
    state: z.enum([...WORKLOAD_STATES, ...PLACEMENT_ONLY_STATES]),
    last_status_at: Millis.nullable(),
  })
  .openapi("Placement");

/** A deployment with its timeline and replicas. */
export const DeploymentDetailSchema = DeploymentSchema.extend({
  events: z.array(DeploymentEventSchema),
  placements: z.array(PlacementSchema),
}).openapi("DeploymentDetail");

/** One stored log line. */
export const LogEntrySchema = z
  .object({
    ts: Millis,
    stream: z.enum(LOG_STREAMS),
    text: z.string(),
    /** Replica that wrote it; absent for build logs. */
    workload_id: z.string().optional(),
  })
  .openapi("LogEntry");

/**
 * A page of log lines, oldest first. Without a cursor it holds the most
 * recent lines; `next_cursor` fetches the page before it and is `null` at the
 * beginning. New lines arrive over the realtime socket.
 */
export const LogPageSchema = z
  .object({ lines: z.array(LogEntrySchema), next_cursor: z.string().nullable() })
  .openapi("LogPage");

/** A DNS record the owner of a custom domain must create, with what the last check saw. */
export const DnsRecordSchema = z
  .object({
    type: z.enum(DNS_RECORD_TYPES),
    name: z.string(),
    value: z.string(),
    purpose: z.enum(DNS_RECORD_PURPOSES),
    state: z.enum(DNS_RECORD_STATES),
    /** Extra instructions, e.g. ALIAS or CNAME flattening at a zone apex. */
    note: z.string().nullable(),
  })
  .openapi("DnsRecord");

/** A custom domain's HSTS policy (ADR 0009); see `hstsProblems` in `@roundhouse/shared`. */
export const DomainHstsSchema = z
  .object({
    enabled: z.boolean(),
    /** Seconds. */
    max_age: z.number().int().min(0).max(MAX_HSTS_MAX_AGE_S),
    include_subdomains: z.boolean(),
    /** Needs `include_subdomains`, a max-age of a year or more, and an apex hostname. */
    preload: z.boolean(),
  })
  .openapi("DomainHsts");

/** One ingress node's certificate state for a domain. */
export const DomainTlsNodeSchema = z
  .object({
    node_id: z.string(),
    name: z.string(),
    /**
     * `acme` mode: what the node's Caddy reported. `managed` mode:
     * `issued` once the node confirmed loading the current certificate.
     */
    state: z.enum(["pending", "issued", "failed"]),
    error: z.string().nullable(),
  })
  .openapi("DomainTlsNode");

/** The certificate serving a domain, as reported by the nodes or issued by the control plane. */
export const DomainTlsSchema = z
  .object({
    status: z.enum(DOMAIN_TLS_STATUSES),
    /** E.g. Let's Encrypt's intermediate's name; `null` until issued. */
    issuer: z.string().nullable(),
    not_before: Millis.nullable(),
    /** Expiry of the certificate in use; renewal starts well before it. */
    not_after: Millis.nullable(),
    /** Why issuance or loading failed, in words safe to show. */
    error: z.string().nullable(),
    updated_at: Millis.nullable(),
    /** Per serving node. Empty in `internal` and `off` modes. */
    nodes: z.array(DomainTlsNodeSchema),
  })
  .openapi("DomainTls");

/** A server a domain's DNS may point at. */
export const DomainRoutingNodeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    public_ip: z.string().nullable(),
    /**
     * Whether it answers for the domain: it runs a replica of the service,
     * or it is a meshed, ready ingress server and the service runs on meshed
     * servers (ADR 0005, "Cross-node ingress").
     */
    serves: z.boolean(),
  })
  .openapi("DomainRoutingNode");

/** A hostname routed to a service. */
export const DomainSchema = z
  .object({
    id: z.string(),
    service_id: z.string(),
    environment_id: z.string(),
    hostname: z.string(),
    /** `https://` or `http://` depending on the TLS mode. */
    url: z.string(),
    type: z.enum(DOMAIN_TYPES),
    target_port: z.number().int(),
    /** Routed only once `verified`. */
    verification_status: z.enum(DOMAIN_VERIFICATION_STATUSES),
    tls_status: z.enum(DOMAIN_TLS_STATUSES),
    /** Lifecycle; generated domains are always `active`. */
    status: z.enum(DOMAIN_STATUSES),
    /** Whether the hostname is a zone apex, which needs A/AAAA (or ALIAS) instead of a CNAME. */
    apex: z.boolean(),
    /** Records to create, routing first; empty for generated domains. */
    records: z.array(DnsRecordSchema),
    /** Why the last check didn't pass, or a warning about records changed since. */
    error: z.string().nullable(),
    /** `*.example.com`; refused until `managed` TLS can issue wildcards (ADR 0009). */
    wildcard: z.boolean(),
    /** The policy in effect: a custom domain's own, else the default. Sent only over HTTPS. */
    hsts: DomainHstsSchema,
    tls: DomainTlsSchema,
    /**
     * Ingress servers in the service's workspace. When some don't serve the
     * service, `records` asks for A/AAAA records of the ones that do.
     */
    /** `cloudflare_saas` when served through Cloudflare for SaaS (ADR 0009). */
    mode: z.enum(DOMAIN_MODES),
    /**
     * Cloudflare's view of a SaaS domain's custom hostname: `status` and
     * `ssl_status` as Cloudflare words them, and its errors verbatim; `null`
     * in direct mode.
     */
    cf: z
      .object({
        status: z.string().nullable(),
        ssl_status: z.string().nullable(),
        errors: z.array(z.string()),
      })
      .nullable(),
    routing_nodes: z.array(DomainRoutingNodeSchema),
    last_checked_at: Millis.nullable(),
    /** `null` when no check is scheduled (failed domains wait for a manual check). */
    next_check_at: Millis.nullable(),
    verified_at: Millis.nullable(),
    created_at: Millis,
  })
  .openapi("Domain");

// -----------------------------------------------------------------------------
// Phase 1: instance settings and GitHub
// -----------------------------------------------------------------------------

/**
 * Ingress TLS mode. `@roundhouse/shared` and `@roundhouse/protocol` (as
 * `INGRESS_TLS_MODES`) both define the values; the two `satisfies` checks
 * fail the build if they drift apart.
 */
export const TlsModeSchema = z
  .enum(TLS_MODES satisfies readonly IngressTlsMode[])
  .openapi("TlsMode") satisfies z.ZodType<TlsMode>;

// Checks the other direction: every protocol mode is a shared one.
INGRESS_TLS_MODES satisfies readonly TlsMode[];

/** Install-wide settings an owner can change. */
export const InstanceSettingsSchema = z
  .object({
    /** Parent of generated hostnames; `null` until set, which disables generated domains. */
    apps_domain: z.string().nullable(),
    tls_mode: TlsModeSchema,
    /** Days runtime and build logs are kept; older chunks are deleted hourly. */
    log_retention_days: z.number().int().min(1).max(MAX_LOG_RETENTION_DAYS),
    /**
     * Whether `/mcp` serves coding agents with API tokens (ADR 0012). Off on
     * new installs; while off, `/mcp` answers 404 before authenticating.
     */
    mcp_enabled: z.boolean(),
    /**
     * What web shells keep: `metadata` (who, where, when, how long) or
     * `full` (also an encrypted recording of input and output, ADR 0012).
     */
    shell_recording: z.enum(SHELL_RECORDING_MODES),
    /** Days a shell recording is kept after its session ended; deleted hourly. */
    shell_recording_retention_days: z.number().int().min(1).max(MAX_SHELL_RECORDING_RETENTION_DAYS),
    /** Servers that run ingress, across workspaces; `acme` mode is for one. */
    ingress_nodes: z.number().int(),
    /**
     * Servers join the WireGuard mesh (ADR 0005), so an environment may span
     * servers and every ingress server routes to every replica. Off on new
     * installs.
     */
    mesh_enabled: z.boolean(),
    /** IPv4 `/16` the servers' `/24`s come from; fixed once a server joined the mesh. */
    mesh_supernet: z.string(),
    /** The supernet can no longer change: a server has joined the mesh. */
    mesh_supernet_locked: z.boolean(),
  })
  .openapi("InstanceSettings");

/**
 * A mesh supernet: an RFC 1918 IPv4 `/16` that is not inside Docker's
 * default address pools (`172.17.0.0/16` to `172.31.0.0/16`,
 * `192.168.0.0/16`), so mesh IPs never collide with container bridges.
 */
export const MeshSupernetField = z
  .string()
  .regex(
    /^10\.(25[0-5]|2[0-4]\d|1?\d?\d)\.0\.0\/16$/,
    "expected a private /16 under 10.0.0.0/8, e.g. 10.200.0.0/16",
  );

/** Partial update of instance settings. */
export const InstanceSettingsPatchSchema = z
  .object({
    apps_domain: HostnameField.nullable().optional(),
    tls_mode: TlsModeSchema.optional(),
    log_retention_days: z.number().int().min(1).max(MAX_LOG_RETENTION_DAYS).optional(),
    mcp_enabled: z.boolean().optional(),
    mesh_enabled: z.boolean().optional(),
    /**
     * A private IPv4 `/16` outside Docker's default pools; 409
     * `mesh_supernet_locked` once a server has joined the mesh.
     */
    mesh_supernet: MeshSupernetField.optional(),
    shell_recording: z.enum(SHELL_RECORDING_MODES).optional(),
    shell_recording_retention_days: z
      .number()
      .int()
      .min(1)
      .max(MAX_SHELL_RECORDING_RETENTION_DAYS)
      .optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: "nothing to update",
  })
  .openapi("InstanceSettingsPatch");

/** A GitHub App installation visible to the caller's workspace. */
export const GithubInstallationSchema = z
  .object({
    id: z.string(),
    installation_id: z.number().int(),
    account_login: z.string(),
    account_type: z.enum(GITHUB_ACCOUNT_TYPES),
    workspace_id: z.string().nullable(),
    /**
     * Claimed by a user GitHub showed to administer the account (ADR 0014).
     * `false` for claims made before that check, which stay valid.
     */
    verified: z.boolean(),
    claimed_at: Millis.nullable(),
    created_at: Millis,
  })
  .openapi("GithubInstallation");

/** Whether the instance has a GitHub App, and where it is installed. */
export const GithubStatusSchema = z
  .object({
    configured: z.boolean(),
    app: z
      .object({
        id: z.number().int(),
        slug: z.string(),
        name: z.string(),
        html_url: z.string(),
        /**
         * The App's public install page. Installing from it claims nothing;
         * to connect an installation to a workspace, start a claim with
         * `POST /v1/github/claims` and follow its `install_url`.
         */
        install_url: z.string(),
      })
      .nullable(),
    installations: z.array(GithubInstallationSchema),
  })
  .openapi("GithubStatus");

/** A repository an installation can read. */
export const GithubRepositorySchema = z
  .object({
    id: z.number().int(),
    full_name: z.string(),
    private: z.boolean(),
    default_branch: z.string(),
    clone_url: z.string(),
    /** Our `ghi_…` ID of the installation that grants access. */
    installation_id: z.string(),
  })
  .openapi("GithubRepository");

// -----------------------------------------------------------------------------
// Phase 1: realtime
// -----------------------------------------------------------------------------

/**
 * Someone looking at the project right now, with what they last told the
 * room they are looking at (ADR 0006). The room lists only browser sessions
 * that passed the project's access check, so nobody without access to the
 * project ever appears here.
 */
export const PresenceUserSchema = z.object({
  user_id: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  /** Stable per user; see `presenceColor`. */
  color: PresenceColorSchema,
  /** Environment the user's canvas shows; `null` before their first update. */
  environment_id: z.string().nullable(),
  /** Service IDs (or `new:<n>`) selected on their canvas. */
  selection: z.array(z.string()),
  editing: PresenceEditingSchema.nullable(),
});

/** Where streamed log lines come from. */
export const RealtimeLogSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("runtime"),
    service_id: z.string(),
    deployment_id: z.string(),
    workload_id: z.string(),
  }),
  z.object({ type: z.literal("build"), service_id: z.string(), build_id: z.string() }),
  z.object({
    type: z.literal("job"),
    service_id: z.string(),
    run_id: z.string(),
    workload_id: z.string(),
  }),
]);

/** Server → browser messages on `/v1/projects/{projectId}/realtime`. */
export const RealtimeServerMessageSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("deployment.updated"), deployment: DeploymentSchema }),
    z.object({ type: z.literal("deployment.event"), event: DeploymentEventSchema }),
    z.object({
      type: z.literal("log.lines"),
      source: RealtimeLogSourceSchema,
      lines: z.array(z.object({ ts: Millis, stream: z.enum(LOG_STREAMS), text: z.string() })),
    }),
    z.object({ type: z.literal("service.updated"), service: ServiceSchema }),
    z.object({ type: z.literal("presence"), users: z.array(PresenceUserSchema) }),
    ChangeSetUpdatedMessageSchema,
    ChangeSetAppliedMessageSchema,
    CanvasLayoutUpdatedMessageSchema,
    CronRunUpdatedMessageSchema,
    CanvasEdgesUpdatedMessageSchema,
    /**
     * Sent right before the server closes the socket with
     * {@link REALTIME_ACCESS_REVOKED_CLOSE} because the caller lost access
     * (ADR 0014): the dashboard should stop reconnecting and re-check.
     */
    z.object({
      type: z.literal("access.revoked"),
      reason: z.enum(["membership", "project_access", "session"]),
    }),
  ])
  .openapi("RealtimeServerMessage");

/** WebSocket close code used after `access.revoked`. */
export const REALTIME_ACCESS_REVOKED_CLOSE = 4403;

/** Server → browser realtime message. */
export type RealtimeServerMessage = z.infer<typeof RealtimeServerMessageSchema>;

/** A log stream a browser can subscribe to. Deployment and service updates need no subscription. */
export const RealtimeTopicSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deployment_logs"), deployment_id: z.string() }),
  z.object({ kind: z.literal("build_logs"), build_id: z.string() }),
  z.object({ kind: z.literal("cron_run_logs"), run_id: z.string() }),
]);

/**
 * Browser → server messages. Log lines are forwarded only for subscribed
 * topics, so an open project page doesn't receive every replica's output.
 */
export const RealtimeClientMessageSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("subscribe"), topic: RealtimeTopicSchema }),
    z.object({ type: z.literal("unsubscribe"), topic: RealtimeTopicSchema }),
    PresenceUpdateMessageSchema,
  ])
  .openapi("RealtimeClientMessage");

/** Browser → server realtime message. */
export type RealtimeClientMessage = z.infer<typeof RealtimeClientMessageSchema>;

// -----------------------------------------------------------------------------
// API tokens
// -----------------------------------------------------------------------------

/** A scope an API token can carry: one RBAC action. */
export const ApiTokenScopeSchema = z.enum(API_TOKEN_SCOPES).openapi("ApiTokenScope");

/** An API token as listed. The secret is only ever returned by the create route. */
export const ApiTokenSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    scopes: z.array(ApiTokenScopeSchema),
    /** `tok_` and the next four characters of the secret, to tell tokens apart. */
    prefix: z.string().nullable(),
    created_by: z
      .object({ user_id: z.string(), name: z.string().nullable() })
      .nullable()
      .openapi({ description: "`null` once the creator's account is deleted" }),
    last_used_at: Millis.nullable(),
    /** `null` for a token that never expires. */
    expires_at: Millis.nullable(),
    revoked_at: Millis.nullable(),
    created_at: Millis,
  })
  .openapi("ApiToken");

/** Body of `POST /v1/workspaces/{workspaceId}/tokens`. */
export const CreateApiTokenSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    /** Each must be granted by the creator's role (or, for a token, be one of its own scopes). */
    scopes: z
      .array(ApiTokenScopeSchema)
      .min(1)
      .max(API_TOKEN_SCOPES.length)
      .refine((s) => new Set(s).size === s.length, { message: "scopes must be unique" }),
    /** Lifetime in days; `null` for a token that never expires. */
    expires_in_days: z.number().int().min(1).max(MAX_API_TOKEN_TTL_DAYS).nullable(),
  })
  .openapi("CreateApiToken");

/** Response of the create route: the token and, this once, its secret. */
export const CreatedApiTokenSchema = z
  .object({
    token: ApiTokenSchema,
    /** `tok_…`; store it now, it can't be shown again. */
    secret: z.string(),
  })
  .openapi("CreatedApiToken");

// -----------------------------------------------------------------------------
// Summaries
// -----------------------------------------------------------------------------

/** The first domain of a service in an environment. */
export const DomainLinkSchema = z
  .object({ hostname: z.string(), url: z.string() })
  .openapi("DomainLink");

/** One service as the home page, sidebar and project page draw it. */
export const ServiceSummarySchema = z
  .object({
    service: ServiceSchema,
    /** Latest config version in the summarised environment; `null` when it has none. */
    config_version: z.number().int().positive().nullable(),
    /** Source of that config version. */
    source: ServiceSourceSchema.nullable(),
    domain: DomainLinkSchema.nullable(),
    /** Newest deployment in the environment, with its build (commit); `null` before the first. */
    latest_deployment: DeploymentSchema.nullable(),
  })
  .openapi("ServiceSummary");

/** A project with every service's state in one environment. */
export const ProjectSummarySchema = ProjectSchema.extend({
  /** The environment the services are summarised in. */
  environment: EnvironmentSchema.nullable(),
  environments: z.array(EnvironmentSchema),
  services: z.array(ServiceSummarySchema),
}).openapi("ProjectSummary");
