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
  ProtectionRules,
  ResourcesConfig,
  ServiceDatabaseEngine,
  ServiceKind,
  ServiceSource,
  VariableScope,
  VariableTier,
} from "@roundhouse/shared";
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { id, json, timestamp, timestamps } from "./columns";
import { workspaces } from "./workspaces";

/**
 * AES-256-GCM ciphertext as stored in JSON columns, version 1: sealed with
 * the single-key scheme of ADR 0003 and its short AADs. Still readable;
 * the key rotation workflow re-seals it to {@link SealedValueV2}.
 */
export interface SealedValueV1 {
  /** Format version. */
  v: 1;
  /** 96-bit nonce, base64. */
  iv: string;
  /** Ciphertext with the GCM tag appended, base64. */
  ct: string;
}

/**
 * AES-256-GCM ciphertext, version 2 (ADR 0014). `kid` names the key that
 * sealed it: a master-key KEK id for values sealed under the KEK (project
 * DEKs, instance secrets), or the project DEK id for values sealed under a
 * DEK. AADs are the long v2 forms that bind workspace, project and row.
 */
export interface SealedValueV2 {
  v: 2;
  /** 8 lowercase hex characters. */
  kid: string;
  /** 96-bit nonce, base64. */
  iv: string;
  /** Ciphertext with the GCM tag appended, base64. */
  ct: string;
}

/** Any stored ciphertext. Same shape as the API's `Sealed`. */
export type SealedValue = SealedValueV1 | SealedValueV2;

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
    /**
     * Whether {@link environments.protectionRules} apply. New `production`
     * environments start protected, and migration 0013 protected existing
     * ones named `production` or `prod` whose protection nobody had set.
     */
    protected: integer("protected", { mode: "boolean" }).notNull().default(false),
    /** `NULL` means `DEFAULT_PROTECTION_RULES`. */
    protectionRules: json<ProtectionRules>("protection_rules"),
    /**
     * While {@link environments.protected}, applying a change set also needs
     * an approval by someone with `changes:approve` who neither staged it nor
     * applies it (ADR 0006). Off by default; project admins opt in.
     */
    requireApproval: integer("require_approval", { mode: "boolean" }).notNull().default(false),
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
    /** Set for database services (ADR 0004): the registry engine it runs. */
    databaseEngine: text("database_engine").$type<ServiceDatabaseEngine>(),
    /** Registry version of {@link services.databaseEngine}, e.g. `18`. */
    databaseVersion: text("database_version"),
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
 * with the project's data key. `secret` values are write-only: no API ever
 * returns them (ADR 0014).
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
    /** Sealed under the project DEK; AAD `variableAad` (v1) or `variableAadV2` (v2) in the API. */
    valueSealed: json<SealedValue>("value_sealed").notNull(),
    /** `secret` values are never returned and are redacted from logs. */
    tier: text("tier").$type<VariableTier>().notNull().default("plain"),
    /** The classifier locked the tier (public prefix or recognised credential). */
    locked: integer("locked", { mode: "boolean" }).notNull().default(false),
    /**
     * First 8 hex of HMAC-SHA256(fingerprint key of the project, value), so
     * people can tell whether two values match without seeing either. `NULL`
     * until the rotation workflow backfills rows written before ADR 0014.
     */
    fingerprint: text("fingerprint"),
    /** Who last wrote the value or its flags. */
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    /**
     * Also delivered to builds: plain values as build args, secrets as
     * BuildKit secrets (`RUN --mount=type=secret,id=KEY`).
     */
    availableAtBuild: integer("available_at_build", { mode: "boolean" }).notNull().default(false),
    /**
     * Delivered as the file `/run/secrets/<KEY>` on a tmpfs instead of an
     * environment variable, so `docker inspect` doesn't show it.
     */
    mountAsFile: integer("mount_as_file", { mode: "boolean" }).notNull().default(false),
    /** Bumped on every write, for optimistic concurrency; part of the v2 AAD. */
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
export const projectKeys = sqliteTable(
  "project_keys",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The 256-bit DEK, sealed under the KEK; see `projectKeyAad` / `projectKeyAadV2`. */
    dekSealed: json<SealedValue>("dek_sealed").notNull(),
    /**
     * KEK id (`kid`) the DEK is sealed under, mirrored from `dek_sealed` so the
     * rotation workflow can find stale rows by index. `NULL` for v1 rows.
     */
    kekKid: text("kek_kid"),
    /** First 8 hex of SHA-256 of the raw DEK; the `kid` of values sealed under it. */
    dekId: text("dek_id"),
    /** The project's age X25519 recipient backups are encrypted to (ADR 0004). */
    backupRecipient: text("backup_recipient"),
    /** Its identity, sealed under the project DEK; AAD `backupIdentityAad` in the API. */
    backupIdentitySealed: json<SealedValue>("backup_identity_sealed"),
    ...timestamps,
  },
  (t) => [index("project_keys_kek_kid_idx").on(t.kekKid)],
);
