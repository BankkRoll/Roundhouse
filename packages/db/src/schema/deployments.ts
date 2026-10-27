/**
 * The deploy pipeline's records: builds, deployments and their events,
 * replica placements on nodes, domains routed to services, and the index of
 * log chunks stored in R2.
 *
 * @module
 */

import type { WorkloadState } from "@roundhouse/protocol";
import type {
  BuildStatus,
  DeploymentEventType,
  DeploymentStatus,
  DeploymentTrigger,
  DnsRecordState,
  DomainDnsObservation,
  DomainHsts,
  DomainMode,
  DomainStatus,
  DomainTlsStatus,
  DomainType,
  DomainVerificationStatus,
  PlacementOnlyState,
} from "@roundhouse/shared";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { changeSets } from "./changes";
import { id, json, timestamp, timestamps } from "./columns";
import { cronRuns } from "./cron";
import { nodes } from "./nodes";
import { environments, projects, type SealedValue, services } from "./projects";

/** A deployment of one service config version to one environment. */
export const deployments = sqliteTable(
  "deployments",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** `service_configs.version` this deployment runs. */
    configVersion: integer("config_version").notNull(),
    /** Set for git sources; image sources and rollbacks skip the build. */
    // builds and deployments reference each other; the annotation breaks the type cycle.
    buildId: text("build_id").references((): AnySQLiteColumn => builds.id, {
      onDelete: "set null",
    }),
    /** Resolved image reference: a digest for built images, else as configured. */
    image: text("image"),
    status: text("status").$type<DeploymentStatus>().notNull().default("queued"),
    trigger: text("trigger").$type<DeploymentTrigger>().notNull(),
    triggeredBy: text("triggered_by").references(() => users.id, { onDelete: "set null" }),
    /** The deployment whose image and config a rollback restores. */
    rollbackOf: text("rollback_of").references((): AnySQLiteColumn => deployments.id, {
      onDelete: "set null",
    }),
    /**
     * The replicas' resolved environment as JSON, sealed under the project DEK
     * with AAD `deployment-env:<id>`. Resolved once per deployment so later
     * variable edits never change (and restart) a running deployment.
     */
    envSealed: json<SealedValue>("env_sealed"),
    /**
     * Keys of `env_sealed` whose values are secret or derived from a secret,
     * frozen with it. Their values, plus their encodings, are the redaction
     * set for this deployment's logs. Key names only; never values.
     */
    secretKeys: json<string[]>("secret_keys"),
    /**
     * The build's inputs as JSON `{ args, secrets }`, sealed under the project
     * DEK with AAD `deployment-build:v2:<workspace>:<project>:<deployment>`.
     * `args` become build args; `secrets` become BuildKit secrets and are
     * redacted from build logs.
     */
    buildEnvSealed: json<SealedValue>("build_env_sealed"),
    /** Cloudflare Workflow instance driving the pipeline. */
    workflowInstanceId: text("workflow_instance_id"),
    /** The change set whose apply started this deployment (ADR 0006). */
    changeSetId: text("change_set_id").references((): AnySQLiteColumn => changeSets.id, {
      onDelete: "set null",
    }),
    failureReason: text("failure_reason"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    ...timestamps,
  },
  (t) => [
    // IDs are monotonic ULIDs, so this serves newest-first keyset pagination
    // per service and environment.
    index("deployments_svc_env_id_idx").on(t.serviceId, t.environmentId, t.id),
    index("deployments_env_status_idx").on(t.environmentId, t.status),
  ],
);

/** An image build for a git deployment. */
export const builds = sqliteTable(
  "builds",
  {
    id: id(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha").notNull(),
    commitMessage: text("commit_message"),
    commitAuthor: text("commit_author"),
    status: text("status").$type<BuildStatus>().notNull().default("queued"),
    /** Builder node the job was sent to. */
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "set null" }),
    /** Local-registry repository, see `localImageRepository` in `@roundhouse/protocol`. */
    imageRepository: text("image_repository").notNull(),
    /** `sha256:…` from `build_result`, once succeeded. */
    imageDigest: text("image_digest"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    index("builds_deployment_idx").on(t.deploymentId),
    index("builds_service_id_idx").on(t.serviceId, t.id),
  ],
);

/** Timeline entry of a deployment, shown in the dashboard and streamed live. */
export const deploymentEvents = sqliteTable(
  "deployment_events",
  {
    id: id(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    type: text("type").$type<DeploymentEventType>().notNull(),
    message: text("message").notNull(),
    data: json<Record<string, unknown>>("data"),
    ...timestamps,
  },
  (t) => [index("deployment_events_deployment_id_idx").on(t.deploymentId, t.id)],
);

/** Re-exported so database callers find it next to {@link PlacementState}. */
export { PLACEMENT_ONLY_STATES } from "@roundhouse/shared";

/** A placement's state: an agent-reported workload state or a `PLACEMENT_ONLY_STATES` one. */
export type PlacementState = WorkloadState | PlacementOnlyState;

/** Where one replica of a deployment runs, and its last reported state. */
export const placements = sqliteTable(
  "placements",
  {
    id: id(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    replica: integer("replica").notNull(),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    /** `wl_…`; the workload's ID in `desired_state` and `workload_status`. */
    workloadId: text("workload_id").notNull().unique(),
    containerId: text("container_id"),
    state: text("state").$type<PlacementState>().notNull().default("pending"),
    lastStatusAt: timestamp("last_status_at"),
    /**
     * The placement this one replaces during a move (drain or offline
     * rescheduling, ADR 0005). For a moment both rows exist for one replica;
     * the old one is deleted once this one is healthy.
     */
    replacesWorkloadId: text("replaces_workload_id"),
    /**
     * The replica's mesh IP in its node's /24 (ADR 0005), NATed 1:1 to its
     * bridge IP; cleared once the deployment stops being live.
     */
    meshIp: text("mesh_ip"),
    ...timestamps,
  },
  (t) => [
    // Not unique: a move briefly has two live rows for one replica.
    index("placements_deployment_replica_idx").on(t.deploymentId, t.replica),
    index("placements_node_idx").on(t.nodeId),
    uniqueIndex("placements_node_mesh_ip_uq")
      .on(t.nodeId, t.meshIp)
      .where(sql`${t.meshIp} IS NOT NULL`),
  ],
);

/** A DNS record Cloudflare for SaaS asks the customer for. */
export interface CloudflareDcvRecord {
  type: "TXT" | "CNAME";
  name: string;
  value: string;
}

/** A hostname routed to a service in an environment. */
export const domains = sqliteTable(
  "domains",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull().unique(),
    type: text("type").$type<DomainType>().notNull(),
    targetPort: integer("target_port").notNull(),
    verificationStatus: text("verification_status")
      .$type<DomainVerificationStatus>()
      .notNull()
      .default("pending"),
    tlsStatus: text("tls_status").$type<DomainTlsStatus>().notNull().default("pending"),
    /**
     * Lifecycle (ADR 0009). Defaults to `active` so generated domains, which
     * are verified at birth, need nothing; custom domains are inserted as
     * `pending_dns`. Routing still keys off `verification_status` only.
     */
    status: text("status").$type<DomainStatus>().notNull().default("active"),
    mode: text("mode").$type<DomainMode>().notNull().default("direct"),
    /** 32 random bytes, hex; the customer publishes it as the ownership TXT. Custom domains only. */
    verificationToken: text("verification_token"),
    /** Whether the hostname is a zone apex (has its own SOA), which can't hold a CNAME. */
    apex: integer("apex", { mode: "boolean" }).notNull().default(false),
    /** Routing record as last observed. */
    dnsStatus: text("dns_status").$type<DnsRecordState>().notNull().default("unknown"),
    /** Ownership TXT as last observed. */
    ownershipStatus: text("ownership_status").$type<DnsRecordState>().notNull().default("unknown"),
    /** The last check's answers, for the dashboard's "what we saw". */
    dnsObserved: json<DomainDnsObservation>("dns_observed"),
    /** Why the last check didn't pass, in words safe to show the customer. */
    error: text("error"),
    checkAttempts: integer("check_attempts").notNull().default(0),
    /** Start of the current verification window; `failed` after `DOMAIN_VERIFY_WINDOW_MS`. */
    pendingSince: timestamp("pending_since"),
    lastCheckedAt: timestamp("last_checked_at"),
    /** When the cron checks it next; `null` stops scheduled checks (failed domains). */
    nextCheckAt: timestamp("next_check_at"),
    verifiedAt: timestamp("verified_at"),
    /** HSTS policy of a custom domain; `null` takes `DEFAULT_HSTS` (ADR 0009). */
    hsts: json<DomainHsts>("hsts"),
    /** Issuer, validity and last error of the certificate serving the hostname. */
    tlsIssuer: text("tls_issuer"),
    tlsNotBefore: timestamp("tls_not_before"),
    tlsNotAfter: timestamp("tls_not_after"),
    tlsError: text("tls_error"),
    /** When the `tls_*` columns last changed: a node's report or an issuance. */
    tlsUpdatedAt: timestamp("tls_updated_at"),
    /** Cloudflare for SaaS mode: the custom hostname's ID in the SaaS zone. */
    cfCustomHostnameId: text("cf_custom_hostname_id"),
    /** Cloudflare's `status` of the custom hostname, as last read. */
    cfStatus: text("cf_status"),
    /** Cloudflare's `ssl.status`, as last read. */
    cfSslStatus: text("cf_ssl_status"),
    /** Cloudflare's verification and validation errors, verbatim (its words for the customer). */
    cfErrors: json<string[]>("cf_errors"),
    /** Validation records Cloudflare asks for (pre-validation TXT, certificate TXT). */
    cfDcv: json<CloudflareDcvRecord[]>("cf_dcv"),
    ...timestamps,
  },
  (t) => [
    index("domains_svc_env_idx").on(t.serviceId, t.environmentId),
    index("domains_next_check_idx").on(t.nextCheckAt),
  ],
);

/**
 * Index of one NDJSON log chunk in R2 at
 * `logs/<project>/<service>/<yyyy>/<mm>/<dd>/<hh>/<chunk>.ndjson`.
 * Exactly one of `deployment_id` (runtime logs), `build_id` and `cron_run_id`
 * is set.
 */
export const logChunks = sqliteTable(
  "log_chunks",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    serviceId: text("service_id").references(() => services.id, { onDelete: "cascade" }),
    deploymentId: text("deployment_id").references(() => deployments.id, { onDelete: "cascade" }),
    buildId: text("build_id").references(() => builds.id, { onDelete: "cascade" }),
    /** Set for the output of a cron run (ADR 0010); `deployment_id` is then null. */
    cronRunId: text("cron_run_id").references((): AnySQLiteColumn => cronRuns.id, {
      onDelete: "cascade",
    }),
    r2Key: text("r2_key").notNull().unique(),
    /** Timestamp of the chunk's first and last line. */
    firstTs: timestamp("first_ts").notNull(),
    lastTs: timestamp("last_ts").notNull(),
    lineCount: integer("line_count").notNull(),
    bytes: integer("bytes").notNull(),
    ...timestamps,
  },
  (t) => [
    // Range queries select chunks with first_ts <= :to AND last_ts >= :from.
    index("log_chunks_service_ts_idx").on(t.serviceId, t.firstTs),
    index("log_chunks_deployment_ts_idx").on(t.deploymentId, t.firstTs),
    index("log_chunks_build_ts_idx").on(t.buildId, t.firstTs),
    index("log_chunks_cron_run_ts_idx").on(t.cronRunId, t.firstTs),
    // Retention deletes chunks whose newest line is older than the cutoff.
    index("log_chunks_last_ts_idx").on(t.lastTs),
  ],
);
