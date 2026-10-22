/**
 * Projects and what they contain: environments, services, immutable service
 * config versions, encrypted variables, and each project's data key.
 *
 * @module
 */
import type {
  BuildConfig,
  DeployConfig,
  EnvironmentKind,
  HealthcheckConfig,
  NetworkingConfig,
  PlacementConfig,
  ResourcesConfig,
  ServiceKind,
  ServiceSource,
  VariableScope,
} from "@openrail/shared";
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { id, json, timestamp, timestamps } from "./columns";
import { workspaces } from "./workspaces";

/**
 * AES-256-GCM ciphertext as stored in JSON columns. Same shape as the API's
 * `Sealed`; the AAD binds it to its row, so it can't be moved elsewhere.
 */
export interface SealedValue {
  /** Format version. */
  v: 1;
  /** 96-bit nonce, base64. */
  iv: string;
  /** Ciphertext with the GCM tag appended, base64. */
  ct: string;
}

/** A group of services deployed together, with its own environments and network. */
export const projects = sqliteTable(
  "projects",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    ...timestamps,
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    // Partial, so a deleted project's slug can be reused.
    uniqueIndex("projects_ws_slug_uq").on(t.workspaceId, t.slug).where(sql`deleted_at IS NULL`),
    index("projects_workspace_id_idx").on(t.workspaceId, t.id),
  ],
);

/** An isolated copy of a project's services: production, staging, or a PR preview. */
export const environments = sqliteTable(
  "environments",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    kind: text("kind").$type<EnvironmentKind>().notNull(),
    /** Pull request a `preview` environment was created for. */
    prNumber: integer("pr_number"),
    /** Branch a `preview` environment deploys. */
    sourceBranch: text("source_branch"),
    ...timestamps,
  },
  (t) => [uniqueIndex("environments_project_slug_uq").on(t.projectId, t.slug)],
);

/** Something that runs: an app, a database, or a cron job. */
export const services = sqliteTable(
  "services",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Unique among the project's live services; also the variable-reference namespace. */
    slug: text("slug").notNull(),
    kind: text("kind").$type<ServiceKind>().notNull().default("app"),
    icon: text("icon"),
    ...timestamps,
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    uniqueIndex("services_project_slug_uq").on(t.projectId, t.slug).where(sql`deleted_at IS NULL`),
    index("services_project_id_idx").on(t.projectId, t.id),
  ],
);

/**
 * One immutable version of a service's config in one environment. Changing a
 * setting inserts version N+1; deployments reference the version they ran.
 */
export const serviceConfigs = sqliteTable(
  "service_configs",
  {
    id: id(),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** Starts at 1 and increases by 1 per (service, environment). */
    version: integer("version").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    source: json<ServiceSource>("source").notNull(),
    build: json<BuildConfig>("build").notNull(),
    deploy: json<DeployConfig>("deploy").notNull(),
    resources: json<ResourcesConfig>("resources").notNull(),
    healthcheck: json<HealthcheckConfig | null>("healthcheck"),
    networking: json<NetworkingConfig>("networking").notNull(),
    placement: json<PlacementConfig>("placement").notNull(),
    ...timestamps,
  },
  (t) => [
    // Also serves "latest version" lookups: ORDER BY version DESC LIMIT 1.
    uniqueIndex("service_configs_svc_env_version_uq").on(t.serviceId, t.environmentId, t.version),
  ],
);

/**
 * An environment variable, on one service (`scope = 'service'`) or shared by
 * every service of an environment (`scope = 'shared'`). Values are sealed
 * with the project's data key.
 */
export const variables = sqliteTable(
  "variables",
  {
    id: id(),
    scope: text("scope").$type<VariableScope>().notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** Set exactly when `scope` is `service`. */
    serviceId: text("service_id").references(() => services.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    /** Sealed under the project DEK with AAD `variable:<id>`. */
    valueSealed: json<SealedValue>("value_sealed").notNull(),
    /** Secret values are masked in responses and redacted from logs. */
    isSecret: integer("is_secret", { mode: "boolean" }).notNull().default(false),
    /** Bumped on every write, for optimistic concurrency. */
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (t) => [
    // NOTE: SQLite treats NULLs as distinct in unique indexes, so one index
    // over a nullable service_id would allow duplicate shared keys. Each
    // scope gets its own partial index instead.
    uniqueIndex("variables_service_key_uq")
      .on(t.environmentId, t.serviceId, t.key)
      .where(sql`scope = 'service'`),
    uniqueIndex("variables_shared_key_uq")
      .on(t.projectId, t.environmentId, t.key)
      .where(sql`scope = 'shared'`),
    check(
      "variables_scope_ck",
      sql`(scope = 'service' AND service_id IS NOT NULL) OR (scope = 'shared' AND service_id IS NULL)`,
    ),
  ],
);

/** A project's data encryption key, sealed under the master-derived KEK. One per project. */
export const projectKeys = sqliteTable("project_keys", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  /** The 256-bit DEK, sealed with AAD `project-key:<project_id>`. */
  dekSealed: json<SealedValue>("dek_sealed").notNull(),
  ...timestamps,
});
