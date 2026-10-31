/**
 * Service health on the wire (ADR 0005, "Node lifecycle"): which server a
 * `degraded` service is waiting on.
 *
 * The services row stores only `health` and `health_reason`; the server is
 * read back from the placements that caused it, so nothing new is stored and
 * the answer can't go stale:
 * - `node_maintenance`: the server holding the service's `parked` replica.
 * - `node_offline`: an `offline` server still holding one of its replicas
 *   (stateful replicas stay put; only stateless ones are rescheduled).
 *
 * @module
 */
import { type Db, deployments, nodes, placements, type services } from "@roundhouse/db";
import type { ServiceHealthReason } from "@roundhouse/shared";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { MOVABLE_DEPLOYMENT_STATUSES } from "./moves";
import { toApiService } from "./serialize";

/** The server a degraded service waits on. */
export interface HealthNode {
  id: string;
  name: string;
}

type ServiceRow = typeof services.$inferSelect;

/** A service health worth looking up: degraded, with a reason. */
type Degraded = Pick<ServiceRow, "id" | "health" | "healthReason">;

// D1 caps bound parameters at 100 per statement.
const CHUNK = 50;

function causedBy(
  reason: ServiceHealthReason,
  row: { nodeStatus: string; placementState: string },
): boolean {
  return reason === "node_maintenance"
    ? row.placementState === "parked"
    : row.nodeStatus === "offline" && row.placementState !== "lost";
}

/**
 * Finds the server each degraded service waits on.
 *
 * @param db - Database client.
 * @param rows - Services; healthy ones are skipped without a query.
 * @returns Server per service ID, for those where one could be found.
 */
export async function healthNodesOf(
  db: Db,
  rows: readonly Degraded[],
): Promise<Map<string, HealthNode>> {
  const reasons = new Map(
    rows
      .filter((r) => r.health === "degraded" && r.healthReason)
      .map((r) => [r.id, r.healthReason!] as const),
  );
  const out = new Map<string, HealthNode>();
  const ids = [...reasons.keys()];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const found = await db
      .select({
        serviceId: deployments.serviceId,
        nodeId: nodes.id,
        nodeName: nodes.name,
        nodeStatus: nodes.status,
        placementState: placements.state,
      })
      .from(placements)
      .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
      .innerJoin(nodes, eq(nodes.id, placements.nodeId))
      .where(
        and(
          inArray(deployments.serviceId, ids.slice(i, i + CHUNK)),
          inArray(deployments.status, [...MOVABLE_DEPLOYMENT_STATUSES]),
          isNull(nodes.deletedAt),
        ),
      )
      .orderBy(asc(nodes.name));
    for (const row of found) {
      if (out.has(row.serviceId)) continue;
      if (causedBy(reasons.get(row.serviceId)!, row)) {
        out.set(row.serviceId, { id: row.nodeId, name: row.nodeName });
      }
    }
  }
  return out;
}

/**
 * Serialises services with the server each degraded one waits on.
 *
 * @param db - Database client.
 * @param rows - Service rows.
 * @returns `Service` wire shapes, in input order.
 */
export async function toApiServices(db: Db, rows: readonly ServiceRow[]) {
  const healthNodes = await healthNodesOf(db, rows);
  return rows.map((row) => toApiService(row, healthNodes.get(row.id) ?? null));
}

/**
 * Serialises one service with the server it waits on, when degraded.
 *
 * @param db - Database client.
 * @param row - Service row.
 * @returns The `Service` wire shape.
 */
export async function toApiServiceWithHealth(db: Db, row: ServiceRow) {
  const [service] = await toApiServices(db, [row]);
  return service!;
}
