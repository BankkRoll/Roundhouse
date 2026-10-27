/**
 * Deleting the copy a recovery left on a lost node (ADR 0004, "Recovering
 * a volume"). A recovery marks the old volume `abandoned` and restores a
 * backup into a new volume on another node; the old node may come back
 * with the old data. Once it is reachable again and the grace period
 * (`delete_after`) has passed, the minute tick sends it a signed
 * `volume_delete` for the old volume, and its `volume_status` confirming the
 * deletion sets `cleaned_at`.
 *
 * Responsibilities:
 * - deciding whether an abandoned copy may go ({@link cleanupBlocker});
 * - the minute-tick claimer that sends `volume_delete`
 *   ({@link claimAbandonedCleanups});
 * - recording the node's confirmation ({@link onAbandonedCopiesReported});
 * - the dashboard's view of a service's abandoned copies
 *   ({@link abandonedCopies}).
 *
 * SECURITY: a copy is deleted only while the service's live volume is on
 * another node and ready, after a restore into it has succeeded, and with
 * no restore of the service running: until then the old copy may be the
 * only one with the data. The agent refuses on its own a volume its desired
 * state lists or a container mounts. Every request and confirmation is
 * audited as the system.
 *
 * @module
 */
import { createDb, type Db, nodes, projects, restores, volumes } from "@roundhouse/db";
import type { VolumeStatusReport } from "@roundhouse/protocol";
import { VOLUME_DELETE_GRACE_MS } from "@roundhouse/shared";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { Env } from "../env";
import { recordAudit } from "./audit";
import { disposeRpc } from "./deployments";
import { effectiveStatus } from "./nodes";
import { VOLUME_DELETE_RESEND_MS, type VolumeRow, volumeOf } from "./volumes";

/** Where an abandoned copy stands, for the dashboard. */
export type AbandonedCopyState =
  | "waiting_for_server"
  | "scheduled"
  | "kept"
  | "deleting"
  | "deleted";

/** Volume statuses the live replacement must have before the old copy goes. */
const SETTLED = ["ready", "degraded"] as const;

/** Abandoned copies one tick handles. */
const CLAIM_BATCH = 100;

/**
 * Why an abandoned copy must stay for now, or `null` when it may go.
 *
 * @param db - Database client.
 * @param v - An `abandoned` volume with a node.
 * @returns A sentence for the dashboard, or `null`.
 */
export async function cleanupBlocker(db: Db, v: VolumeRow): Promise<string | null> {
  const live = await volumeOf(db, v.serviceId, v.environmentId);
  if (!live?.nodeId || !(SETTLED as readonly string[]).includes(live.status)) {
    return "The service has no ready volume on another server yet; the old copy is kept";
  }
  if (live.nodeId === v.nodeId) {
    return "The service's volume lives on this server again; the old copy is kept";
  }
  const [busy] = await db
    .select({ id: restores.id })
    .from(restores)
    .where(
      and(
        eq(restores.targetServiceId, v.serviceId),
        eq(restores.targetEnvironmentId, v.environmentId),
        inArray(restores.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (busy) return "A restore of the service is running; the old copy is kept until it ends";
  const since = v.abandonedAt ?? v.updatedAt;
  const [restored] = await db
    .select({ id: restores.id })
    .from(restores)
    .where(
      and(
        eq(restores.targetServiceId, v.serviceId),
        eq(restores.targetEnvironmentId, v.environmentId),
        eq(restores.status, "succeeded"),
        or(eq(restores.abandonedVolumeId, v.id), gte(restores.createdAt, since)),
      ),
    )
    .limit(1);
  if (!restored) {
    return "No restore into the replacement volume has succeeded; the old copy may hold the only data and is kept";
  }
  return null;
}

/**
 * Minute-tick claimer: sends `volume_delete` to each reachable node holding
 * an abandoned copy whose grace period ended and which {@link cleanupBlocker}
 * lets go. A node that never confirms gets it again after
 * `VOLUME_DELETE_RESEND_MS`; a removed node's copy is gone with it.
 *
 * @param env - Worker bindings.
 * @param now - The tick's time, unix ms.
 * @returns How many copies were handled.
 */
export async function claimAbandonedCleanups(env: Env, now: number): Promise<number> {
  const db = createDb(env.DB);
  const due = await db
    .select()
    .from(volumes)
    .where(
      and(
        eq(volumes.status, "abandoned"),
        isNull(volumes.cleanedAt),
        isNotNull(volumes.nodeId),
        lte(volumes.deleteAfter, new Date(now)),
        or(
          isNull(volumes.deleteSentAt),
          lte(volumes.deleteSentAt, new Date(now - VOLUME_DELETE_RESEND_MS)),
        ),
      ),
    )
    .orderBy(volumes.deleteAfter)
    .limit(CLAIM_BATCH);
  let handled = 0;
  for (const v of due) {
    const [node] = await db.select().from(nodes).where(eq(nodes.id, v.nodeId!)).limit(1);
    if (!node || node.deletedAt) {
      if (await markCleaned(db, v, now, "node_removed")) handled++;
      continue;
    }
    // A lost node gets the frame when it is back; until then nothing is sent.
    if (effectiveStatus(node, now) === "offline") continue;
    if (await cleanupBlocker(db, v)) continue;
    const [claimed] = await db
      .update(volumes)
      .set({ deleteSentAt: new Date(now), updatedAt: new Date(now) })
      .where(
        and(
          eq(volumes.id, v.id),
          eq(volumes.status, "abandoned"),
          isNull(volumes.cleanedAt),
          v.deleteSentAt ? eq(volumes.deleteSentAt, v.deleteSentAt) : isNull(volumes.deleteSentAt),
        ),
      )
      .returning({ id: volumes.id });
    if (!claimed) continue;
    let sent = false;
    try {
      const stub = env.NODE_CONNECTION.get(env.NODE_CONNECTION.idFromName(node.id));
      const result = await stub.sendVolumeDelete(v.id);
      sent = result.sent;
      disposeRpc(result);
    } catch (err) {
      console.warn("abandoned copy delete failed", v.id, err instanceof Error ? err.name : "error");
    }
    if (!sent) {
      // Not delivered: unclaim, so the first real send is the audited one.
      await db
        .update(volumes)
        .set({ deleteSentAt: v.deleteSentAt, updatedAt: new Date(now) })
        .where(and(eq(volumes.id, v.id), eq(volumes.deleteSentAt, new Date(now))));
      continue;
    }
    handled++;
    if (!v.deleteSentAt)
      await auditCopy(db, v, "volume.copy_cleanup_requested", { node_id: node.id });
  }
  return handled;
}

async function markCleaned(db: Db, v: VolumeRow, now: number, reason: string): Promise<boolean> {
  const [row] = await db
    .update(volumes)
    .set({ cleanedAt: new Date(now), updatedAt: new Date(now) })
    .where(and(eq(volumes.id, v.id), eq(volumes.status, "abandoned"), isNull(volumes.cleanedAt)))
    .returning({ id: volumes.id });
  if (!row) return false;
  await auditCopy(db, v, "volume.copy_deleted", { node_id: v.nodeId, reason });
  return true;
}

/**
 * Applies a node's `volume_status` to the abandoned copies it holds: a
 * `deleted` report finishes the cleanup; any other report keeps the agent's
 * message (a refusal says why) for the dashboard.
 *
 * SECURITY: only copies pinned to the reporting node count.
 *
 * @param db - Database client.
 * @param nodeId - The reporting node.
 * @param reports - Its volumes.
 * @param now - Receive time, unix ms.
 * @returns How many copies were confirmed deleted.
 */
export async function onAbandonedCopiesReported(
  db: Db,
  nodeId: string,
  reports: readonly VolumeStatusReport[],
  now = Date.now(),
): Promise<number> {
  const deleted = reports.filter((r) => r.state === "deleted").map((r) => r.volume_id);
  if (!deleted.length) return 0;
  const rows = await db
    .select()
    .from(volumes)
    .where(
      and(
        eq(volumes.nodeId, nodeId),
        eq(volumes.status, "abandoned"),
        isNull(volumes.cleanedAt),
        inArray(volumes.id, deleted.slice(0, 90)),
      ),
    );
  let n = 0;
  for (const v of rows) {
    if (await markCleaned(db, v, now, v.deleteSentAt ? "confirmed" : "reported")) n++;
  }
  return n;
}

async function auditCopy(
  db: Db,
  v: VolumeRow,
  action: "volume.copy_cleanup_requested" | "volume.copy_deleted",
  extra: Record<string, unknown>,
): Promise<void> {
  const [owner] = await db
    .select({ workspaceId: projects.workspaceId })
    .from(projects)
    .where(eq(projects.id, v.projectId))
    .limit(1);
  if (!owner) return;
  await recordAudit(db, {
    workspaceId: owner.workspaceId,
    actorType: "system",
    actorId: null,
    action,
    targetType: "volume",
    targetId: v.id,
    metadata: {
      project_id: v.projectId,
      service_id: v.serviceId,
      environment_id: v.environmentId,
      ...extra,
    },
  });
}

/** An abandoned copy as the API returns it; see `AbandonedCopySchema`. */
export interface ApiAbandonedCopy {
  volume_id: string;
  node_id: string | null;
  node_name: string | null;
  state: AbandonedCopyState;
  /** The agent's last message, or why the copy is kept. */
  message: string | null;
  size_mb: number;
  used_bytes: number | null;
  abandoned_at: number | null;
  delete_after: number | null;
  delete_sent_at: number | null;
  cleaned_at: number | null;
}

/** Abandoned copies one service lists. */
const LISTED = 20;

/**
 * A service's abandoned copies in an environment, newest first, with where
 * each one's cleanup stands.
 *
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @param now - Unix ms.
 * @returns At most 20 copies.
 */
export async function abandonedCopies(
  db: Db,
  serviceId: string,
  environmentId: string,
  now = Date.now(),
): Promise<ApiAbandonedCopy[]> {
  const rows = await db
    .select({ volume: volumes, node: nodes })
    .from(volumes)
    .leftJoin(nodes, eq(nodes.id, volumes.nodeId))
    .where(
      and(
        eq(volumes.serviceId, serviceId),
        eq(volumes.environmentId, environmentId),
        eq(volumes.status, "abandoned"),
      ),
    )
    .orderBy(desc(volumes.id))
    .limit(LISTED);
  const out: ApiAbandonedCopy[] = [];
  for (const { volume: v, node } of rows) {
    let state: AbandonedCopyState;
    let message = v.message ?? null;
    if (v.cleanedAt) {
      state = "deleted";
      message = node && !node.deletedAt ? null : "The server was removed, and its disk with it";
    } else if (!node || node.deletedAt || !v.nodeId) {
      state = "deleted";
      message = "The server was removed, and its disk with it";
    } else if (v.deleteSentAt) {
      state = "deleting";
    } else if (effectiveStatus(node, now) === "offline") {
      state = "waiting_for_server";
      message = `${node.name} is offline; the copy is deleted once it is back`;
    } else {
      const blocker = await cleanupBlocker(db, v);
      state = blocker ? "kept" : "scheduled";
      message = blocker;
    }
    out.push({
      volume_id: v.id,
      node_id: v.nodeId,
      node_name: node?.name ?? null,
      state,
      message,
      size_mb: v.sizeMb,
      used_bytes: v.usedBytes ?? null,
      abandoned_at: v.abandonedAt ? +v.abandonedAt : null,
      delete_after: v.deleteAfter ? +v.deleteAfter : null,
      delete_sent_at: v.deleteSentAt ? +v.deleteSentAt : null,
      cleaned_at: v.cleanedAt ? +v.cleanedAt : null,
    });
  }
  return out;
}

/**
 * When a copy abandoned at `now` may be deleted from its node: after the
 * same grace a soft-deleted volume gets, so an operator has three days to
 * pull anything off a returning server by hand.
 *
 * @param now - Unix ms of the recovery.
 * @returns The volume's `delete_after`.
 */
export function abandonedCopyDeleteAfter(now: number): Date {
  return new Date(now + VOLUME_DELETE_GRACE_MS);
}
