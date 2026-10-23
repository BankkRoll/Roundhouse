/**
 * Where a backup is taken from, or a restore written to: the service's
 * volume in the environment, the node holding it, and (for dumps, and for
 * quiesced snapshots) the replica running on it.
 *
 * @module
 */
import { type Db, deployments, nodes, placements, volumes } from "@roundhouse/db";
import { BACKUPS_PROTOCOL_VERSION } from "@roundhouse/protocol";
import type { BackupMethodName } from "@roundhouse/shared";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { LIVE_DEPLOYMENT_STATUSES } from "../desired-state";

/** Volume statuses a backup or restore may run against. */
export const BACKUPABLE_VOLUME_STATUSES = ["ready", "degraded"] as const;

/** A volume ready for a backup or restore job. */
export interface DataTarget {
  volumeId: string;
  nodeId: string;
  /** The node's X25519 key, to seal credentials to. */
  nodePublicKey: string;
  /** The running replica; always set for `dump`. */
  workloadId: string | null;
  /** Last reported usage, for the part size. */
  usedBytes: number;
}

/** Why {@link findDataTarget} found nowhere to run. */
export type DataTargetFailure =
  | "no_volume"
  | "volume_not_ready"
  | "node_unavailable"
  | "agent_outdated"
  | "service_not_running";

/**
 * Finds the volume, node and replica of a service in an environment.
 *
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @param method - `dump` needs a running replica; `snapshot` uses one when there is.
 * @returns The target, or why there is none.
 */
export async function findDataTarget(
  db: Db,
  serviceId: string,
  environmentId: string,
  method: BackupMethodName,
): Promise<{ ok: true; target: DataTarget } | { ok: false; reason: DataTargetFailure }> {
  const [volume] = await db
    .select()
    .from(volumes)
    .where(
      and(
        eq(volumes.serviceId, serviceId),
        eq(volumes.environmentId, environmentId),
        inArray(volumes.status, ["pending", ...BACKUPABLE_VOLUME_STATUSES, "migrating", "error"]),
      ),
    )
    .orderBy(desc(volumes.id))
    .limit(1);
  if (!volume) return { ok: false, reason: "no_volume" };
  if (
    !volume.nodeId ||
    !(BACKUPABLE_VOLUME_STATUSES as readonly string[]).includes(volume.status)
  ) {
    return { ok: false, reason: "volume_not_ready" };
  }
  const [node] = await db
    .select({ key: nodes.encryptionPublicKey, protocolVersion: nodes.protocolVersion })
    .from(nodes)
    .where(and(eq(nodes.id, volume.nodeId), isNull(nodes.deletedAt)))
    .limit(1);
  if (!node?.key) return { ok: false, reason: "node_unavailable" };
  if (node.protocolVersion < BACKUPS_PROTOCOL_VERSION)
    return { ok: false, reason: "agent_outdated" };
  const [replica] = await db
    .select({ workloadId: placements.workloadId })
    .from(placements)
    .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
    .where(
      and(
        eq(placements.nodeId, volume.nodeId),
        eq(deployments.serviceId, serviceId),
        eq(deployments.environmentId, environmentId),
        inArray(deployments.status, [...LIVE_DEPLOYMENT_STATUSES]),
        inArray(placements.state, ["healthy", "running"]),
      ),
    )
    .orderBy(asc(placements.state))
    .limit(1);
  if (method === "dump" && !replica) return { ok: false, reason: "service_not_running" };
  return {
    ok: true,
    target: {
      volumeId: volume.id,
      nodeId: volume.nodeId,
      nodePublicKey: node.key,
      workloadId: replica?.workloadId ?? null,
      usedBytes: volume.usedBytes ?? 0,
    },
  };
}

/** Human text for each {@link DataTargetFailure}, stored as the error. */
export const DATA_TARGET_MESSAGES: Record<DataTargetFailure, string> = {
  no_volume: "no_volume: the service has no volume in this environment",
  volume_not_ready: "volume_not_ready: the volume isn't placed and ready",
  node_unavailable: "node_offline: the volume's node is gone or has no encryption key",
  agent_outdated: "agent_outdated: the volume's node runs an agent without backups",
  service_not_running: "service_not_running: a dump needs the database running",
};
