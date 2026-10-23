/**
 * The node Durable Object's `volume_status` handler (ADR 0004): stores what
 * the node reports about each volume it holds (state, usage, quota
 * mechanism, message) and finalises soft-deleted volumes the node has
 * removed.
 *
 * SECURITY: a report counts only for a volume pinned to the reporting node,
 * so an agent can't rewrite (or "delete") another node's volumes.
 *
 * @module
 */
import { type Db, volumes } from "@roundhouse/db";
import type { VolumeStatus } from "@roundhouse/protocol";
import { and, eq, inArray } from "drizzle-orm";
import type { Env } from "../../../env";
import { controlStatusOf } from "../../../lib/volumes";

/** D1 binds at most 100 parameters per statement; one goes to the node ID. */
const MAX_IDS_PER_LOOKUP = 90;

/**
 * Handles one `volume_status` frame.
 *
 * @param db - Control-plane database.
 * @param _env - Worker bindings (unused; kept for the handler signature).
 * @param nodeId - The reporting node.
 * @param frame - The validated frame.
 * @param now - Receive time, unix ms.
 * @returns How many volumes were updated.
 */
export async function onVolumeStatus(
  db: Db,
  _env: Env,
  nodeId: string,
  frame: VolumeStatus,
  now = Date.now(),
): Promise<number> {
  const reports = new Map(frame.volumes.map((v) => [v.volume_id, v]));
  const ids = [...reports.keys()];
  const writes = [];
  for (let i = 0; i < ids.length; i += MAX_IDS_PER_LOOKUP) {
    const rows = await db
      .select({ id: volumes.id, status: volumes.status })
      .from(volumes)
      .where(
        and(eq(volumes.nodeId, nodeId), inArray(volumes.id, ids.slice(i, i + MAX_IDS_PER_LOOKUP))),
      );
    for (const row of rows) {
      const r = reports.get(row.id)!;
      const status = controlStatusOf(row.status, r.state);
      writes.push(
        db
          .update(volumes)
          .set({
            status,
            usedBytes: r.used_bytes,
            quotaMode: r.quota,
            message:
              r.message ?? (r.state === "orphaned" ? "held by the node but not listed" : null),
            reportedAt: new Date(now),
            updatedAt: new Date(now),
          })
          // Guarded on the status read, so a concurrent delete or undelete wins.
          .where(and(eq(volumes.id, row.id), eq(volumes.status, row.status))),
      );
    }
  }
  if (writes.length) await db.batch(writes as [(typeof writes)[number], ...typeof writes]);
  return writes.length;
}
