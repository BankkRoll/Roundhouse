/**
 * Settings → Platform → Registry: `REGISTRY_ROUTES` in `contracts/registry.ts`.
 *
 * - Setting S3 storage probes the bucket with both key pairs before sealing
 *   the secrets, then re-sends desired state everywhere: builders switch
 *   their primary to the bucket, other servers run read-only replicas.
 * - Going back to filesystem storage is refused while a workspace has more
 *   than one builder.
 *
 * @module
 */
import type { InstanceAction } from "@roundhouse/shared";
import { newId } from "@roundhouse/shared";
import { clientIp, createRouter, requireInstanceAction } from "../context";
import {
  deleteRegistryStorage,
  getRegistryStorage,
  policyOf,
  putRegistryStorage,
} from "../contracts";
import { auditInsert } from "../lib/audit";
import { DEFAULT_BACKUP_REGION, normalizeEndpoint } from "../lib/backups/storage";
import { refreshAllNodes } from "../lib/desired-state";
import { ApiError } from "../lib/errors";
import { requireFreshSession } from "../lib/fresh-session";
import {
  getRegistryStorageView,
  prepareRegistryStorage,
  registryRequiresS3,
  putRegistryStorage as storeRegistryStorage,
  workspacesWithSeveralBuilders,
} from "../lib/registry";
import { headObject, S3Error } from "../lib/s3";

/** Registry storage routes. */
export const registryRoutes = createRouter()
  .openapi(getRegistryStorage, async (c) => {
    await requireInstanceAction(c, policyOf(getRegistryStorage).action as InstanceAction);
    return c.json(await getRegistryStorageView(c.get("db")), 200);
  })
  .openapi(putRegistryStorage, async (c) => {
    const user = await requireInstanceAction(
      c,
      policyOf(putRegistryStorage).action as InstanceAction,
    );
    await requireFreshSession(c);
    const body = c.req.valid("json");
    const endpoint = normalizeEndpoint(body.endpoint, c.env.ROUNDHOUSE_DEV === "1");
    if (!endpoint) {
      throw new ApiError(
        400,
        "invalid_request",
        "endpoint must be an https:// origin with no path, query or credentials",
      );
    }
    const db = c.get("db");
    const before = await getRegistryStorageView(db);
    const { stored, s3 } = await prepareRegistryStorage(db, c.env, {
      ...body,
      endpoint,
      region: body.region ?? DEFAULT_BACKUP_REGION,
    });
    for (const [label, key] of [
      ["read-write", s3.readWrite],
      ["read-only", s3.readOnly],
    ] as const) {
      try {
        // Any answer but 403/5xx proves the endpoint, bucket and key work together.
        await headObject(
          { endpoint, bucket: s3.bucket, region: s3.region, ...key },
          `roundhouse-probe/${newId("message")}`,
        );
      } catch (err) {
        throw new ApiError(
          422,
          "registry_storage_unreachable",
          `The ${label} key can't reach the bucket: ${
            err instanceof S3Error ? err.message : "the bucket could not be reached"
          }`,
        );
      }
    }
    const changed: string[] = (
      ["endpoint", "bucket", "region", "access_key_id", "readonly_access_key_id"] as const
    ).filter((k) => before[k] !== stored[k]);
    if (body.secret_access_key !== undefined) changed.push("secret_access_key");
    if (body.readonly_secret_access_key !== undefined) changed.push("readonly_secret_access_key");
    await db.batch([
      storeRegistryStorage(db, stored),
      auditInsert(db, {
        workspaceId: null,
        actorType: "user",
        actorId: user.id,
        action: "instance.settings_updated",
        targetType: "instance",
        metadata: { setting: "registry_storage", type: "s3", changed },
        ip: clientIp(c),
      }),
    ]);
    await refreshAllNodes(c.env, db);
    return c.json(await getRegistryStorageView(db), 200);
  })
  .openapi(deleteRegistryStorage, async (c) => {
    const user = await requireInstanceAction(
      c,
      policyOf(deleteRegistryStorage).action as InstanceAction,
    );
    await requireFreshSession(c);
    const db = c.get("db");
    const before = await getRegistryStorageView(db);
    if (before.type === "filesystem") return c.json(before, 200);
    if ((await workspacesWithSeveralBuilders(db)).length) {
      throw registryRequiresS3("A workspace has more than one builder.");
    }
    await db.batch([
      storeRegistryStorage(db, null),
      auditInsert(db, {
        workspaceId: null,
        actorType: "user",
        actorId: user.id,
        action: "instance.settings_updated",
        targetType: "instance",
        metadata: { setting: "registry_storage", type: "filesystem" },
        ip: clientIp(c),
      }),
    ]);
    await refreshAllNodes(c.env, db);
    return c.json(await getRegistryStorageView(db), 200);
  });
