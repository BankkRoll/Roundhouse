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
 * Volume migration and the TCP proxy are not served yet.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import {
  MAX_VOLUME_MB,
  MIN_VOLUME_MB,
  SERVICE_DATABASE_ENGINES,
  VOLUME_STATUSES,
} from "@roundhouse/shared";
import {
  body,
  errors,
  json,
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

/** Every database and volume route, by name. */
export const DATABASE_ROUTES = {
  createDatabase,
  getServiceVolume,
  resizeVolume,
  deleteVolume,
  undeleteVolume,
} as const;

/** A volume. */
export type Volume = z.infer<typeof VolumeSchema>;
/** What adding a database created. */
export type CreatedDatabase = z.infer<typeof CreatedDatabaseSchema>;
