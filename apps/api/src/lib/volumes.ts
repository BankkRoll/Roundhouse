/**
 * Volumes (ADR 0004): a service's persistent storage in one environment,
 * held by one node.
 *
 * Responsibilities:
 * - finding a service's volume and deciding whether a service is a volume
 *   service at all ({@link volumeOf}, {@link isVolumeService});
 * - creating the row a deployment needs ({@link volumeRowsFor},
 *   {@link ensureVolume}) and the replica rule ({@link assertSingleReplica});
 * - grow-only resize, soft delete with a grace period, and undelete;
 * - the minute-tick claimer that sends `volume_delete` once the grace has
 *   passed ({@link claimVolumeDeletions});
 * - mapping a node's `volume_status` report onto the control-plane status
 *   ({@link controlStatusOf}).
 *
 * SECURITY: only a signed `volume_delete` removes data, and only for a
 * volume that has been `pending_deletion` for `VOLUME_DELETE_GRACE_MS`.
 *
 * @module
 */
import {
  createDb,
  type Db,
  deployments,
  nodes,
  placements,
  type services,
  volumeMigrations,
  volumes,
} from "@roundhouse/db";
import type { VolumeState } from "@roundhouse/protocol";
import {
  DEFAULT_DATABASE_VOLUME_MB,
  databaseVersion,
  LIVE_VOLUME_STATUSES,
  MAX_VOLUME_MB,
  MIN_VOLUME_MB,
  newId,
  VOLUME_DELETE_GRACE_MS,
  type VolumeStatusName,
} from "@roundhouse/shared";
import { and, asc, desc, eq, inArray, isNull, lte, notInArray, or } from "drizzle-orm";
import type { Env } from "../env";
import { ApiError, conflict } from "./errors";
import { hasTcpProxy } from "./tcp-proxies";

/** A volume row. */
export type VolumeRow = typeof volumes.$inferSelect;

/** Statuses of a volume that no longer exists anywhere (or never will again). */
export const GONE_VOLUME_STATUSES: readonly VolumeStatusName[] = ["deleted", "abandoned"];

/** How long after a `volume_delete` the minute tick sends it again, if the node never confirmed. */
export const VOLUME_DELETE_RESEND_MS = 10 * 60 * 1000;

/**
 * Error for raising the replicas of a service that has a volume: two
 * containers on one data directory would corrupt it.
 */
export const singleReplicaError = () =>
  new ApiError(
    422,
    "volume_requires_single_replica",
    "A service with a volume runs at most one replica",
  );

// -----------------------------------------------------------------------------
// Lookups
// -----------------------------------------------------------------------------

/**
 * The service's volume in an environment that still holds data: live, or
 * `pending_deletion` (undeletable).
 *
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @returns The row, or `undefined` when there is none.
 */
export async function volumeOf(
  db: Db,
  serviceId: string,
  environmentId: string,
): Promise<VolumeRow | undefined> {
  const [row] = await db
    .select()
    .from(volumes)
    .where(
      and(
        eq(volumes.serviceId, serviceId),
        eq(volumes.environmentId, environmentId),
        notInArray(volumes.status, [...GONE_VOLUME_STATUSES]),
      ),
    )
    .orderBy(desc(volumes.id))
    .limit(1);
  return row;
}

/**
 * Whether a service keeps state on a volume: it is a database, or it has
 * (or had) a volume in any environment. Such services run one replica,
 * stop before they are replaced, and stay on their volume's node.
 *
 * @param db - Database client.
 * @param service - Its ID and database engine.
 * @returns `true` for a volume service.
 */
export async function isVolumeService(
  db: Db,
  service: { id: string; databaseEngine: string | null },
): Promise<boolean> {
  if (service.databaseEngine) return true;
  const [row] = await db
    .select({ id: volumes.id })
    .from(volumes)
    .where(and(eq(volumes.serviceId, service.id), notInArray(volumes.status, ["abandoned"])))
    .limit(1);
  return row !== undefined;
}

/**
 * Refuses more than one replica for a volume service (ADR 0004,
 * "Placement affinity"), or for a service publishing a TCP port: one host
 * port can be published once per node, and the allowlist follows one
 * replica.
 *
 * @param db - Database client.
 * @param service - Its ID and database engine.
 * @param replicas - The replica count about to be stored.
 * @throws {ApiError} 422 `volume_requires_single_replica`.
 */
export async function assertSingleReplica(
  db: Db,
  service: { id: string; databaseEngine: string | null },
  replicas: number | undefined,
): Promise<void> {
  if (replicas === undefined || replicas <= 1) return;
  if (await isVolumeService(db, service)) throw singleReplicaError();
  if (await hasTcpProxy(db, service.id)) {
    throw new ApiError(
      422,
      "volume_requires_single_replica",
      "A service with a TCP proxy runs at most one replica; turn the proxy off first",
    );
  }
}

// -----------------------------------------------------------------------------
// Creation
// -----------------------------------------------------------------------------

/**
 * Rows of a new service's volume, one per environment, each pending with no
 * node until its first deployment places it.
 *
 * @param input - Project, service, environments, mount path and size.
 * @returns Rows to insert in the same batch as the service.
 */
export function volumeRowsFor(input: {
  projectId: string;
  serviceId: string;
  environmentIds: readonly string[];
  mountPath: string;
  sizeMb: number;
}): (typeof volumes.$inferInsert)[] {
  return input.environmentIds.map((environmentId) => ({
    id: newId("volume"),
    projectId: input.projectId,
    environmentId,
    serviceId: input.serviceId,
    mountPath: input.mountPath,
    sizeMb: clampVolumeMb(input.sizeMb),
    status: "pending" as const,
  }));
}

/**
 * A volume size within the protocol's bounds.
 *
 * @param sizeMb - Requested size.
 * @returns The size, raised to `MIN_VOLUME_MB` or lowered to `MAX_VOLUME_MB`.
 */
export function clampVolumeMb(sizeMb: number): number {
  return Math.min(MAX_VOLUME_MB, Math.max(MIN_VOLUME_MB, Math.round(sizeMb)));
}

/**
 * The volume a deployment of a volume service mounts, created when the
 * environment has none yet (an environment added after the service, whose
 * volume rows were written for the environments of the time). The new row
 * copies the mount path and largest size of the service's other volumes.
 *
 * @param db - Database client.
 * @param service - The service row.
 * @param environmentId - Where the deployment runs.
 * @returns The volume, or `null` for a service without volumes.
 * @throws {ApiError} 409 when the volume is scheduled for deletion.
 */
export async function ensureVolume(
  db: Db,
  service: Pick<
    typeof services.$inferSelect,
    "id" | "projectId" | "databaseEngine" | "databaseVersion"
  >,
  environmentId: string,
): Promise<VolumeRow | null> {
  const existing = await volumeOf(db, service.id, environmentId);
  if (existing) {
    if (existing.status === "pending_deletion") {
      throw conflict("The service's volume is scheduled for deletion; undelete it to deploy");
    }
    return existing;
  }
  const others = await db
    .select({ mountPath: volumes.mountPath, sizeMb: volumes.sizeMb })
    .from(volumes)
    .where(eq(volumes.serviceId, service.id))
    .orderBy(desc(volumes.sizeMb))
    .limit(1);
  let mountPath = others[0]?.mountPath;
  let sizeMb = others[0]?.sizeMb ?? DEFAULT_DATABASE_VOLUME_MB;
  if (!mountPath && service.databaseEngine) {
    const v = databaseVersion(service.databaseEngine, service.databaseVersion);
    mountPath = v?.mountPath;
    sizeMb = DEFAULT_DATABASE_VOLUME_MB;
  }
  if (!mountPath) return null;
  const [row] = volumeRowsFor({
    projectId: service.projectId,
    serviceId: service.id,
    environmentIds: [environmentId],
    mountPath,
    sizeMb,
  });
  try {
    await db.insert(volumes).values(row!);
  } catch (err) {
    // A concurrent deployment created it first; the partial unique index decided.
    const raced = await volumeOf(db, service.id, environmentId);
    if (raced) return raced;
    throw err;
  }
  return (await volumeOf(db, service.id, environmentId)) ?? null;
}

// -----------------------------------------------------------------------------
// Resize, delete, undelete
// -----------------------------------------------------------------------------

/**
 * Grows a volume. The node applies the new quota online when it next
 * receives its desired state.
 *
 * @param db - Database client.
 * @param volume - The volume.
 * @param sizeMb - New size; must not be smaller.
 * @returns The updated row.
 * @throws {ApiError} 422 `volume_shrink_unsupported`, 409 when not live.
 */
export async function resizeVolume(db: Db, volume: VolumeRow, sizeMb: number): Promise<VolumeRow> {
  if (!(LIVE_VOLUME_STATUSES as readonly string[]).includes(volume.status)) {
    throw conflict(`The volume is ${volume.status.replace(/_/g, " ")}`);
  }
  await assertNotMoving(db, volume);
  if (sizeMb < volume.sizeMb) {
    throw new ApiError(
      422,
      "volume_shrink_unsupported",
      `Volumes only grow; it is ${volume.sizeMb} MiB`,
    );
  }
  const [row] = await db
    .update(volumes)
    .set({ sizeMb, updatedAt: new Date() })
    .where(and(eq(volumes.id, volume.id), lte(volumes.sizeMb, sizeMb)))
    .returning();
  if (!row) throw conflict("The volume changed at the same time; reload and retry");
  return row;
}

/**
 * Refuses a change to a volume that is moving to another node: its service
 * is stopped for the copy, and the copy was sized and placed for the volume
 * as it was.
 *
 * @param db - Database client.
 * @param volume - The volume.
 * @throws {ApiError} 409 while a migration is queued or running.
 */
export async function assertNotMoving(db: Db, volume: VolumeRow): Promise<void> {
  const [moving] = await db
    .select({ id: volumeMigrations.id })
    .from(volumeMigrations)
    .where(
      and(
        eq(volumeMigrations.volumeId, volume.id),
        inArray(volumeMigrations.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (moving || volume.status === "migrating") {
    throw conflict("The volume is moving to another server; wait for the move to end");
  }
}

/**
 * Whether the service still runs replicas in the volume's environment.
 *
 * @param db - Database client.
 * @param volume - The volume.
 * @returns `true` while a live deployment has placements.
 */
export async function volumeInUse(db: Db, volume: VolumeRow): Promise<boolean> {
  const [row] = await db
    .select({ id: placements.id })
    .from(placements)
    .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
    .where(
      and(
        eq(deployments.serviceId, volume.serviceId),
        eq(deployments.environmentId, volume.environmentId),
        inArray(deployments.status, ["deploying", "active", "crashed"]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Soft-deletes a volume: it leaves its node's desired state (the agent keeps
 * the data and reports it `orphaned`) and its data is removed after
 * `VOLUME_DELETE_GRACE_MS` unless undeleted first.
 *
 * @param db - Database client.
 * @param volume - The volume.
 * @param now - Unix ms.
 * @returns The updated row.
 * @throws {ApiError} 409 while the service still runs in the environment.
 */
export async function deleteVolume(
  db: Db,
  volume: VolumeRow,
  now = Date.now(),
): Promise<VolumeRow> {
  if (!(LIVE_VOLUME_STATUSES as readonly string[]).includes(volume.status)) {
    throw conflict(`The volume is ${volume.status.replace(/_/g, " ")}`);
  }
  await assertNotMoving(db, volume);
  if (await volumeInUse(db, volume)) {
    throw conflict("The service still runs here; scale it to 0 or delete it first");
  }
  const [row] = await db
    .update(volumes)
    .set({
      status: "pending_deletion",
      deleteAfter: new Date(now + VOLUME_DELETE_GRACE_MS),
      deleteSentAt: null,
      updatedAt: new Date(now),
    })
    .where(and(eq(volumes.id, volume.id), eq(volumes.status, volume.status)))
    .returning();
  if (!row) throw conflict("The volume changed at the same time; reload and retry");
  return row;
}

/**
 * Undoes a soft delete within the grace period. The volume comes back as
 * `ready` when a node holds it, else `pending`; the next report corrects it.
 *
 * @param db - Database client.
 * @param volume - The volume.
 * @param now - Unix ms.
 * @returns The updated row.
 * @throws {ApiError} 409 when it isn't pending deletion or its data is being removed.
 */
export async function undeleteVolume(
  db: Db,
  volume: VolumeRow,
  now = Date.now(),
): Promise<VolumeRow> {
  if (volume.status !== "pending_deletion") throw conflict("The volume is not deleted");
  if (volume.deleteSentAt) {
    throw conflict("The volume's data is already being removed from its node");
  }
  const live = await volumeOf(db, volume.serviceId, volume.environmentId);
  if (live && live.id !== volume.id) {
    throw conflict("The service already has another volume in this environment");
  }
  const [row] = await db
    .update(volumes)
    .set({
      status: volume.nodeId ? "ready" : "pending",
      deleteAfter: null,
      updatedAt: new Date(now),
    })
    .where(
      and(
        eq(volumes.id, volume.id),
        eq(volumes.status, "pending_deletion"),
        isNull(volumes.deleteSentAt),
      ),
    )
    .returning();
  if (!row) throw conflict("The volume's data is already being removed from its node");
  return row;
}

/**
 * Soft-deletes every live volume of the given services, as part of
 * deleting them.
 *
 * @param db - Database client.
 * @param serviceIds - Services being deleted.
 * @param now - Unix ms.
 * @returns Nodes that held one, whose desired state changes.
 */
export async function retireServiceVolumes(
  db: Db,
  serviceIds: readonly string[],
  now = Date.now(),
): Promise<string[]> {
  if (!serviceIds.length) return [];
  const rows = await db
    .update(volumes)
    .set({
      status: "pending_deletion",
      deleteAfter: new Date(now + VOLUME_DELETE_GRACE_MS),
      deleteSentAt: null,
      updatedAt: new Date(now),
    })
    .where(
      and(
        inArray(volumes.serviceId, [...serviceIds]),
        inArray(volumes.status, [...LIVE_VOLUME_STATUSES]),
      ),
    )
    .returning({ nodeId: volumes.nodeId });
  return [...new Set(rows.flatMap((r) => (r.nodeId ? [r.nodeId] : [])))];
}

// -----------------------------------------------------------------------------
// Minute tick
// -----------------------------------------------------------------------------

/**
 * Sends `volume_delete` for volumes past their grace period (ADR 0004).
 *
 * A volume never placed has no data anywhere and is marked `deleted` at
 * once. Otherwise each row is claimed by setting `delete_sent_at` with a
 * conditional update, so overlapping ticks send once; a node that never
 * confirms gets the frame again after {@link VOLUME_DELETE_RESEND_MS}. The
 * row becomes `deleted` when the node reports the volume `deleted`.
 *
 * @param env - Worker bindings.
 * @param now - The tick's time, unix ms.
 * @returns How many volumes were handled.
 */
export async function claimVolumeDeletions(env: Env, now: number): Promise<number> {
  const db = createDb(env.DB);
  const resendBefore = new Date(now - VOLUME_DELETE_RESEND_MS);
  const due = await db
    .select()
    .from(volumes)
    .where(
      and(
        eq(volumes.status, "pending_deletion"),
        lte(volumes.deleteAfter, new Date(now)),
        or(isNull(volumes.deleteSentAt), lte(volumes.deleteSentAt, resendBefore)),
      ),
    )
    .orderBy(asc(volumes.deleteAfter))
    .limit(100);
  let handled = 0;
  for (const v of due) {
    if (!v.nodeId) {
      await db
        .update(volumes)
        .set({ status: "deleted", updatedAt: new Date(now) })
        .where(and(eq(volumes.id, v.id), eq(volumes.status, "pending_deletion")));
      handled++;
      continue;
    }
    const [claimed] = await db
      .update(volumes)
      .set({ deleteSentAt: new Date(now), updatedAt: new Date(now) })
      .where(
        and(
          eq(volumes.id, v.id),
          eq(volumes.status, "pending_deletion"),
          v.deleteSentAt ? eq(volumes.deleteSentAt, v.deleteSentAt) : isNull(volumes.deleteSentAt),
        ),
      )
      .returning({ id: volumes.id });
    if (!claimed) continue;
    const node = await db.query.nodes.findFirst({
      where: and(eq(nodes.id, v.nodeId), isNull(nodes.deletedAt)),
      columns: { id: true },
    });
    if (!node) {
      // The node is gone and its disk with it.
      await db
        .update(volumes)
        .set({ status: "deleted", updatedAt: new Date(now) })
        .where(eq(volumes.id, v.id));
      handled++;
      continue;
    }
    try {
      const stub = env.NODE_CONNECTION.get(env.NODE_CONNECTION.idFromName(v.nodeId));
      await stub.sendVolumeDelete(v.id);
    } catch (err) {
      // `delete_sent_at` is set, so the resend interval paces the retry.
      console.warn("volume_delete failed", v.id, err instanceof Error ? err.name : "error");
    }
    handled++;
  }
  return handled;
}

// -----------------------------------------------------------------------------
// Node reports
// -----------------------------------------------------------------------------

/** Statuses only the control plane sets, which a node report never overrides. */
const CONTROL_OWNED: readonly VolumeStatusName[] = [
  "pending_deletion",
  "migrating",
  "deleted",
  "abandoned",
];

/**
 * The control-plane status a node's report implies.
 *
 * - `creating` → `pending`, `ready`/`resizing` → `ready`, `error` → `error`;
 * - `orphaned` (held but no longer listed) changes nothing: the desired
 *   state that lists it may not have arrived yet;
 * - `deleted` finalises a `pending_deletion` volume, and is an `error` for
 *   one the control plane still considers live.
 *
 * @param current - The stored status.
 * @param state - The node's state for it.
 * @returns The status to store.
 */
export function controlStatusOf(current: VolumeStatusName, state: VolumeState): VolumeStatusName {
  if (state === "deleted") {
    if (current === "pending_deletion" || current === "deleted") return "deleted";
    return CONTROL_OWNED.includes(current) ? current : "error";
  }
  if (CONTROL_OWNED.includes(current)) return current;
  switch (state) {
    case "creating":
      return "pending";
    case "ready":
    case "resizing":
      return "ready";
    case "error":
      return "error";
    case "orphaned":
      return current;
  }
}

/**
 * @param v - Volume row.
 * @param nodeName - Name of the node holding it, when known.
 * @returns The `Volume` wire shape; see `VolumeSchema`.
 */
export function toApiVolume(v: VolumeRow, nodeName: string | null = null) {
  return {
    id: v.id,
    project_id: v.projectId,
    environment_id: v.environmentId,
    service_id: v.serviceId,
    mount_path: v.mountPath,
    size_mb: v.sizeMb,
    node_id: v.nodeId,
    node_name: nodeName,
    status: v.status,
    quota_mode: v.quotaMode ?? null,
    used_bytes: v.usedBytes ?? null,
    message: v.message ?? null,
    reported_at: v.reportedAt ? +v.reportedAt : null,
    delete_after: v.deleteAfter ? +v.deleteAfter : null,
    created_at: +v.createdAt,
    updated_at: +v.updatedAt,
  };
}
