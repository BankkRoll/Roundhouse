/**
 * Database services and volumes (ADR 0004): adding a database to a project,
 * and reading, growing, deleting and undeleting a service's volume.
 *
 * A database is added through a change set (ADR 0006): the route opens one,
 * stages a `service.create` op with `database`, and applies it, so the
 * service, its config in every environment, its volume in every environment
 * and its generated credentials land through the same checks and audit as
 * any reviewed change. Credentials are `secret` variables: write-only from
 * the moment they exist, never part of any response.
 *
 * Moving a volume to another node, publishing a service's TCP port behind a
 * source allowlist, and rotating a database's credentials are served here
 * too. Each changes what is reachable or who can connect, so each needs a
 * fresh session, except turning the TCP proxy off.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import {
  CREDENTIAL_ROTATION_STATUSES,
  DATABASE_PRINCIPALS,
  MAX_TCP_PROXY_CIDRS,
  MAX_VOLUME_MB,
  MIN_VOLUME_MB,
  RESTORE_STATUSES,
  SERVICE_DATABASE_ENGINES,
  VOLUME_MIGRATION_PHASES,
  VOLUME_STATUSES,
} from "@roundhouse/shared";
import {
  body,
  errors,
  json,
  Millis,
  NameField,
  ServiceSchema,
  ServiceSlugField,
  sessionAuth,
} from "../schemas";
import { EnvironmentQuery, ProjectParams, ServiceParams } from "./params";
import { defineRoute, session } from "./policy";

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

/** A volume size in MiB within the protocol's bounds. */
const SizeMbField = z.number().int().min(MIN_VOLUME_MB).max(MAX_VOLUME_MB);

/** Which database to run; see `DATABASE_ENGINE_SPECS` for engines and versions. */
export const DatabaseChoiceSchema = z
  .object({
    engine: z.enum(SERVICE_DATABASE_ENGINES),
    /** A registry version, e.g. `18` or `valkey-9`; the engine's default when omitted. */
    version: z.string().min(1).max(32).optional(),
    /** Volume quota; 5120 MiB when omitted. */
    size_mb: SizeMbField.optional(),
  })
  .openapi("DatabaseChoice");

/** Body of `POST /v1/projects/{projectId}/databases`. */
export const CreateDatabaseBody = DatabaseChoiceSchema.extend({
  /** The environment the change set applies in (and deploys to). */
  environment_id: z.string(),
  /** Defaults to the engine's name. */
  name: NameField.optional(),
  slug: ServiceSlugField.optional(),
  /** Start the first deployment in `environment_id`; on by default. */
  deploy: z.boolean().default(true),
}).openapi("CreateDatabase");

/** A service's volume in one environment. */
export const VolumeSchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
    environment_id: z.string(),
    service_id: z.string(),
    mount_path: z.string(),
    size_mb: z.number().int(),
    /** The node holding the data; `null` until the first deployment places it. */
    node_id: z.string().nullable(),
    node_name: z.string().nullable(),
    status: z.enum(VOLUME_STATUSES),
    /** How the node enforces the quota; `none` means it isn't enforced. */
    quota_mode: z.enum(["xfs_project", "ext4_project", "loop", "none"]).nullable(),
    used_bytes: z.number().nullable(),
    /** The node's message for an `error` volume. */
    message: z.string().nullable(),
    reported_at: z.number().nullable(),
    /** While `pending_deletion`: when the data is removed. */
    delete_after: z.number().nullable(),
    created_at: z.number(),
    updated_at: z.number(),
  })
  .openapi("Volume");

/** What adding a database created. */
export const CreatedDatabaseSchema = z
  .object({
    /** The applied change set. */
    change_set_id: z.string(),
    service: ServiceSchema,
    engine: z.enum(SERVICE_DATABASE_ENGINES),
    version: z.string(),
    /** One per environment. */
    volumes: z.array(VolumeSchema),
    /** Keys of the variables created in each environment; values are never returned. */
    variables: z.array(z.object({ key: z.string(), secret: z.boolean() })),
    deployment_ids: z.array(z.string()),
    skipped: z.array(z.object({ service_id: z.string(), reason: z.string() })),
  })
  .openapi("CreatedDatabase");

/** `{volumeId}` path param. */
export const VolumeParams = z.object({ volumeId: z.string() });

/** Body of `PATCH /v1/volumes/{volumeId}`. */
export const ResizeVolumeBody = z.object({ size_mb: SizeMbField }).openapi("ResizeVolume");

/** `{migrationId}` path param. */
export const MigrationParams = z.object({ migrationId: z.string() });

/** Body of `POST /v1/volumes/{volumeId}/migrate`. */
export const MigrateVolumeBody = z
  .object({
    target_node_id: z.string(),
    /** Must equal the service's slug: the service is down for the whole copy. */
    confirm: z.string().min(1).max(100),
  })
  .openapi("MigrateVolume");

/** One move of a volume to another node. */
export const VolumeMigrationSchema = z
  .object({
    id: z.string(),
    volume_id: z.string(),
    service_id: z.string(),
    environment_id: z.string(),
    source_node_id: z.string().nullable(),
    target_node_id: z.string().nullable(),
    status: z.enum(RESTORE_STATUSES),
    phase: z.enum(VOLUME_MIGRATION_PHASES),
    /** The snapshot backup that carried the data; kept for 72 hours. */
    backup_id: z.string().nullable(),
    /** The redeploy on the target node. */
    deployment_id: z.string().nullable(),
    copied_bytes: z.number().nullable(),
    error: z.string().nullable(),
    requested_by: z.string().nullable(),
    /** When the node left with an unused copy gets `volume_delete`. */
    cleanup_after: Millis.nullable(),
    started_at: Millis.nullable(),
    finished_at: Millis.nullable(),
    created_at: Millis,
  })
  .openapi("VolumeMigration");

/** A node a volume could move to, and why not when it can't. */
export const MigrationTargetSchema = z
  .object({
    node_id: z.string(),
    name: z.string(),
    eligible: z.boolean(),
    /** Why the node can't take the volume; `null` when eligible. */
    reason: z.string().nullable(),
    quota_mode: z.enum(["xfs_project", "ext4_project", "loop", "none"]).nullable(),
  })
  .openapi("MigrationTarget");

/** Nodes a volume can move to, with the expected downtime. */
export const MigrationTargetsSchema = z
  .object({
    volume_id: z.string(),
    source_node_id: z.string().nullable(),
    /**
     * Expected downtime in ms: the copy out and in at the last backup's
     * throughput (or a conservative default), plus a restart.
     */
    estimated_downtime_ms: z.number().int(),
    targets: z.array(MigrationTargetSchema),
  })
  .openapi("MigrationTargets");

/** Recent migrations of a volume, newest first. */
export const VolumeMigrationListSchema = z
  .object({ migrations: z.array(VolumeMigrationSchema) })
  .openapi("VolumeMigrationList");

/** An IPv4 or IPv6 CIDR (or a bare address, read as /32 or /128). */
const CidrField = z.string().min(2).max(64);

/** Body of `PUT /v1/services/{serviceId}/tcp-proxies`. */
export const PutTcpProxyBody = z
  .object({
    environment_id: z.string(),
    /** The port the service listens on; its `networking.port` by default. */
    container_port: z.number().int().min(1).max(65535).optional(),
    /** Sources allowed to connect; every other source is dropped on the node. */
    allowed_cidrs: z.array(CidrField).min(1).max(MAX_TCP_PROXY_CIDRS),
    /**
     * Required to admit every address (`0.0.0.0/0` or `::/0`): the
     * connection is then open to the internet and unencrypted unless the
     * client and the engine negotiate TLS.
     */
    acknowledge_open: z.boolean().optional(),
  })
  .openapi("PutTcpProxy");

/** A service's published TCP port in one environment. */
export const TcpProxySchema = z
  .object({
    id: z.string(),
    service_id: z.string(),
    environment_id: z.string(),
    container_port: z.number().int(),
    public_port: z.number().int(),
    allowed_cidrs: z.array(z.string()),
    /** The node's public hostname or IP; `null` until the service is placed. */
    host: z.string().nullable(),
    node_id: z.string().nullable(),
    /**
     * `active`: published behind the allowlist. `pending`: not placed yet,
     * or waiting for a deploy. `unsupported`: the node's agent can't enforce
     * an allowlist, so nothing is published until it is upgraded.
     */
    status: z.enum(["active", "pending", "unsupported"]),
    /** Whether the allowlist admits every address. */
    open_to_all: z.boolean(),
    created_at: Millis,
    updated_at: Millis,
  })
  .openapi("TcpProxy");

/** Body of `POST /v1/services/{serviceId}/database/rotate-credentials`. */
export const RotateCredentialsBody = z
  .object({
    environment_id: z.string(),
    /** Principals to rotate; every one the engine has by default. */
    principals: z.array(z.enum(DATABASE_PRINCIPALS)).min(1).max(3).optional(),
    /** Must equal the service's slug. */
    confirm: z.string().min(1).max(100),
  })
  .openapi("RotateCredentials");

/** One credential rotation. Never carries a password. */
export const CredentialRotationSchema = z
  .object({
    id: z.string(),
    service_id: z.string(),
    environment_id: z.string(),
    status: z.enum(CREDENTIAL_ROTATION_STATUSES),
    principals: z.array(z.enum(DATABASE_PRINCIPALS)),
    /** Principals whose new password the database accepted. */
    applied: z.array(z.enum(DATABASE_PRINCIPALS)),
    /** The change set that stored the new passwords; `null` until then. */
    change_set_id: z.string().nullable(),
    deployment_ids: z.array(z.string()),
    error: z.string().nullable(),
    requested_by: z.string().nullable(),
    created_at: Millis,
    finished_at: Millis.nullable(),
  })
  .openapi("CredentialRotation");

/** Recent credential rotations, newest first. */
export const CredentialRotationListSchema = z
  .object({ rotations: z.array(CredentialRotationSchema) })
  .openapi("CredentialRotationList");

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

/**
 * Adds a database service: a pinned image, one replica, an `exec` health
 * probe, a volume in every environment, and freshly generated credentials
 * stored as write-only `secret` variables with reference-valued connection
 * variables (`DATABASE_URL`, …). Needs `services:manage`, `variables:manage`
 * and, with `deploy`, `deployments:create` in the environment.
 */
export const createDatabase = defineRoute(
  session("services:manage", [
    "change_set.created",
    "change_set.applied",
    "service.created",
    "variables.updated",
    "deployment.created",
  ]),
  {
    method: "post",
    path: "/v1/projects/{projectId}/databases",
    tags: ["databases"],
    summary: "Add a database",
    description:
      "Applies through a change set. 404 for an unknown engine version; 422 for more than one replica.",
    security: sessionAuth,
    request: { params: ProjectParams, ...body(CreateDatabaseBody) },
    responses: { 201: json(CreatedDatabaseSchema), ...errors(400, 401, 403, 404, 409, 422) },
  },
);

/** A service's volume in one environment. */
export const getServiceVolume = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/services/{serviceId}/volume",
  tags: ["volumes"],
  summary: "Get a service's volume",
  security: sessionAuth,
  request: { params: ServiceParams, query: EnvironmentQuery },
  responses: { 200: json(VolumeSchema), ...errors(401, 403, 404) },
});

/** Grows a volume; the node applies it online. Shrinking is refused with 422. */
export const resizeVolume = defineRoute(session("services:manage", ["volume.resized"]), {
  method: "patch",
  path: "/v1/volumes/{volumeId}",
  tags: ["volumes"],
  summary: "Grow a volume",
  security: sessionAuth,
  request: { params: VolumeParams, ...body(ResizeVolumeBody) },
  responses: { 200: json(VolumeSchema), ...errors(400, 401, 403, 404, 409, 422) },
});

/**
 * Deletes a volume: its data is removed from the node after 72 hours unless
 * it is undeleted first. Refused while the service still runs there.
 */
export const deleteVolume = defineRoute(session("services:manage", ["volume.deleted"]), {
  method: "delete",
  path: "/v1/volumes/{volumeId}",
  tags: ["volumes"],
  summary: "Delete a volume",
  security: sessionAuth,
  request: { params: VolumeParams },
  responses: { 200: json(VolumeSchema), ...errors(401, 403, 404, 409) },
});

/** Undoes a delete within its 72-hour grace period. */
export const undeleteVolume = defineRoute(session("services:manage", ["volume.undeleted"]), {
  method: "post",
  path: "/v1/volumes/{volumeId}/undelete",
  tags: ["volumes"],
  summary: "Undelete a volume",
  security: sessionAuth,
  request: { params: VolumeParams },
  responses: { 200: json(VolumeSchema), ...errors(401, 403, 404, 409) },
});

/**
 * Nodes the volume could move to, each with why it can't when it can't, and
 * the expected downtime.
 */
export const listMigrationTargets = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/volumes/{volumeId}/migration-targets",
  tags: ["volumes"],
  summary: "List nodes a volume can move to",
  security: sessionAuth,
  request: { params: VolumeParams },
  responses: { 200: json(MigrationTargetsSchema), ...errors(401, 403, 404) },
});

/**
 * Moves a volume to another node through object storage (ADR 0004): the
 * service stops, a quiesced snapshot is copied out and into the volume on
 * the target, checked against its SHA-256, and the service is redeployed
 * there. Any failure before the redeploy puts it back on the source. The
 * service is down for the whole copy. 422 `migration_target_ineligible`.
 */
export const migrateVolume = defineRoute(
  session("services:manage", ["volume.migration_started"], { reauth: true }),
  {
    method: "post",
    path: "/v1/volumes/{volumeId}/migrate",
    tags: ["volumes"],
    summary: "Move a volume to another node",
    security: sessionAuth,
    request: { params: VolumeParams, ...body(MigrateVolumeBody) },
    responses: {
      202: json(VolumeMigrationSchema, "Started"),
      ...errors(400, 401, 403, 404, 409, 422),
    },
  },
);

/** Recent migrations of a volume. */
export const listVolumeMigrations = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/volumes/{volumeId}/migrations",
  tags: ["volumes"],
  summary: "List a volume's migrations",
  security: sessionAuth,
  request: { params: VolumeParams },
  responses: { 200: json(VolumeMigrationListSchema), ...errors(401, 403, 404) },
});

/** One volume migration. */
export const getVolumeMigration = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/volume-migrations/{migrationId}",
  tags: ["volumes"],
  summary: "Get a volume migration",
  security: sessionAuth,
  request: { params: MigrationParams },
  responses: { 200: json(VolumeMigrationSchema), ...errors(401, 403, 404) },
});

/** A service's TCP proxy in one environment; 404 when it has none. */
export const getTcpProxy = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/services/{serviceId}/tcp-proxies",
  tags: ["services"],
  summary: "Get a service's TCP proxy",
  security: sessionAuth,
  request: { params: ServiceParams, query: EnvironmentQuery },
  responses: { 200: json(TcpProxySchema), ...errors(401, 403, 404) },
});

/**
 * Publishes a single-replica service's TCP port on its node (ADR 0004, "TCP
 * proxy"), or changes the allowlist of one already published. The node
 * drops every source outside `allowed_cidrs`. Publishing recreates the
 * container once; allowlist changes apply in place. Off by default.
 */
export const putTcpProxy = defineRoute(
  session("services:manage", ["tcp_proxy.enabled", "tcp_proxy.updated"], { reauth: true }),
  {
    method: "put",
    path: "/v1/services/{serviceId}/tcp-proxies",
    tags: ["services"],
    summary: "Publish a TCP port",
    security: sessionAuth,
    request: { params: ServiceParams, ...body(PutTcpProxyBody) },
    responses: { 200: json(TcpProxySchema), ...errors(400, 401, 403, 404, 409, 422) },
  },
);

/** Stops publishing a service's TCP port. */
export const deleteTcpProxy = defineRoute(session("services:manage", ["tcp_proxy.disabled"]), {
  method: "delete",
  path: "/v1/services/{serviceId}/tcp-proxies",
  tags: ["services"],
  summary: "Stop publishing a TCP port",
  security: sessionAuth,
  request: { params: ServiceParams, query: EnvironmentQuery },
  responses: { 204: { description: "Removed" }, ...errors(401, 403, 404) },
});

/**
 * Rotates a database's passwords: new ones are generated, set in the engine
 * through the node's query channel (sealed to the node, never in a
 * statement), stored as write-only secret variables in a change set, and
 * every service using them redeployed, the database included: a restore and
 * a Redis restart take the passwords from its container's environment, so
 * that must match the engine. Needs `data:write`, `variables:manage` and
 * `deployments:create`. A rotation interrupted after the engine accepted a
 * password is finished by the next call (409 while another call runs it).
 */
export const rotateDatabaseCredentials = defineRoute(
  session(
    "data:write",
    [
      "database.credentials_rotated",
      "database.credentials_rotation_failed",
      "change_set.created",
      "change_set.applied",
    ],
    { reauth: true },
  ),
  {
    method: "post",
    path: "/v1/services/{serviceId}/database/rotate-credentials",
    tags: ["databases"],
    summary: "Rotate a database's credentials",
    security: sessionAuth,
    request: { params: ServiceParams, ...body(RotateCredentialsBody) },
    responses: {
      200: json(CredentialRotationSchema),
      ...errors(400, 401, 403, 404, 409, 422, 502, 503, 504),
    },
  },
);

/** Recent credential rotations of a database. */
export const listCredentialRotations = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/services/{serviceId}/database/credential-rotations",
  tags: ["databases"],
  summary: "List a database's credential rotations",
  security: sessionAuth,
  request: { params: ServiceParams, query: EnvironmentQuery },
  responses: { 200: json(CredentialRotationListSchema), ...errors(401, 403, 404) },
});

/** Every database and volume route, by name. */
export const DATABASE_ROUTES = {
  createDatabase,
  getServiceVolume,
  resizeVolume,
  deleteVolume,
  undeleteVolume,
  listMigrationTargets,
  migrateVolume,
  listVolumeMigrations,
  getVolumeMigration,
  getTcpProxy,
  putTcpProxy,
  deleteTcpProxy,
} as const;

/** Credential routes of a database, by name. */
export const CREDENTIAL_ROUTES = {
  rotateDatabaseCredentials,
  listCredentialRotations,
} as const;

/** A volume. */
export type Volume = z.infer<typeof VolumeSchema>;
/** What adding a database created. */
export type CreatedDatabase = z.infer<typeof CreatedDatabaseSchema>;
/** A volume migration. */
export type VolumeMigration = z.infer<typeof VolumeMigrationSchema>;
/** Nodes a volume can move to. */
export type MigrationTargets = z.infer<typeof MigrationTargetsSchema>;
/** A service's TCP proxy. */
export type TcpProxy = z.infer<typeof TcpProxySchema>;
/** A credential rotation. */
export type CredentialRotation = z.infer<typeof CredentialRotationSchema>;
