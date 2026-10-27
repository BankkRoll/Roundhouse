/**
 * Settings → Platform → Registry (ADR 0005, "Registry over the mesh"):
 * where the build registry keeps blobs. Filesystem (the default) serves one
 * builder per workspace, which every other server pulls from over the
 * mesh; S3 storage serves any number of builders and needs no mesh.
 * Instance admins only, from a browser session; changes need a fresh one.
 * Secrets are write-only.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { body, errors, json, Millis, sessionOnlyAuth } from "../schemas";
import { defineRoute, sessionOnly } from "./policy";

/** The registry storage setting; secrets are never returned. */
export const RegistryStorageSchema = z
  .object({
    /** `filesystem` (each workspace's builder disk) until a bucket is set. */
    type: z.enum(["filesystem", "s3"]),
    endpoint: z.string().nullable(),
    bucket: z.string().nullable(),
    region: z.string().nullable(),
    /** Read-write key, used by builders only. */
    access_key_id: z.string().nullable(),
    /** Read-only key, used by every other server. */
    readonly_access_key_id: z.string().nullable(),
    /** Both secrets are stored (sealed); they are never returned. */
    secrets_set: z.boolean(),
    updated_at: Millis.nullable(),
  })
  .openapi("RegistryStorage");

/** Body of `PUT /v1/instance/registry-storage`. */
export const PutRegistryStorageBody = z
  .object({
    /** S3 API origin, e.g. `https://<account>.r2.cloudflarestorage.com`. */
    endpoint: z.string().min(1).max(300),
    bucket: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "expected an S3 bucket name")
      .openapi({ example: "roundhouse-registry" }),
    /** `auto` for R2 (the default). */
    region: z
      .string()
      .regex(/^[a-z0-9-]{1,32}$/)
      .optional(),
    access_key_id: z.string().min(1).max(128),
    /** Write-only. Omit to keep the stored one. */
    secret_access_key: z.string().min(1).max(256).optional(),
    /** A key that can only read the bucket (an R2 "Object Read only" token). */
    readonly_access_key_id: z.string().min(1).max(128),
    /** Write-only. Omit to keep the stored one. */
    readonly_secret_access_key: z.string().min(1).max(256).optional(),
  })
  .openapi("PutRegistryStorage");

/** Where builds are stored. */
export const getRegistryStorage = defineRoute(sessionOnly("instance:manage"), {
  method: "get",
  path: "/v1/instance/registry-storage",
  tags: ["instance"],
  summary: "Get registry storage",
  security: sessionOnlyAuth,
  responses: { 200: json(RegistryStorageSchema), ...errors(401, 403) },
});

/**
 * Stores builds in an S3 bucket from now on, after checking both key pairs
 * reach it (422 `registry_storage_unreachable`). Builds made before stay on
 * the builders' disks: redeploy to move a service's image into the bucket.
 * Every server gets the new registry with its next desired state. Audited
 * as `instance.settings_updated`, never with a secret.
 */
export const putRegistryStorage = defineRoute(
  sessionOnly("instance:manage", ["instance.settings_updated"], { reauth: true }),
  {
    method: "put",
    path: "/v1/instance/registry-storage",
    tags: ["instance"],
    summary: "Set registry storage",
    security: sessionOnlyAuth,
    request: body(PutRegistryStorageBody),
    responses: { 200: json(RegistryStorageSchema), ...errors(400, 401, 403, 422) },
  },
);

/**
 * Goes back to filesystem storage. 409 `registry_requires_s3` while a
 * workspace has more than one builder: filesystem storage serves one.
 */
export const deleteRegistryStorage = defineRoute(
  sessionOnly("instance:manage", ["instance.settings_updated"], { reauth: true }),
  {
    method: "delete",
    path: "/v1/instance/registry-storage",
    tags: ["instance"],
    summary: "Use filesystem registry storage",
    security: sessionOnlyAuth,
    responses: { 200: json(RegistryStorageSchema), ...errors(401, 403, 409) },
  },
);

/** Every registry route, by name. */
export const REGISTRY_ROUTES = {
  getRegistryStorage,
  putRegistryStorage,
  deleteRegistryStorage,
} as const;

/** The registry storage setting. */
export type RegistryStorage = z.infer<typeof RegistryStorageSchema>;
