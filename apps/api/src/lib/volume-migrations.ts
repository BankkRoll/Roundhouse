/**
 * Moving a volume between nodes (ADR 0004, "Volume migration between
 * nodes"): the decisions and D1 operations the route, the workflow, the node
 * Durable Object and the minute tick share.
 *
 * The copy goes through object storage as a quiesced snapshot backup
 * (`volume_copy_out` on the source, `volume_copy_in` on the target), so it
 * works between any two nodes, and every credential travels sealed to the
 * node that uses it. The volume keeps its ID on both nodes: the target lists
 * it from the start of the move, the source keeps its copy until the grace
 * period ends.
 *
 * Responsibilities:
 * - which nodes can take a volume, and the expected downtime
 *   ({@link migrationTargets}, {@link targetIneligibility});
 * - starting and waking the workflow ({@link startVolumeMigration},
 *   {@link wakeMigrationWorkflow});
 * - recording what the nodes report: the target's view of the volume
 *   ({@link onMigrationVolumeReports}), the copy-in result
 *   ({@link onMigrationCopyIn});
 * - deleting the copy left behind once the grace period ends
 *   ({@link claimMigrationCleanups}).
 *
 * SECURITY: a node's report counts only for a migration that names it as
 * target (or cleanup node), so an agent can't steer another node's move.
 *
 * @module
 */
import {
  backups,
  createDb,
  type Db,
  deployments,
  nodes,
  placements,
  projects,
  serviceConfigs,
  services,
  tcpProxies,
  volumeMigrations,
  volumes,
} from "@roundhouse/db";
import {
  BACKUPS_PROTOCOL_VERSION,
  type RestoreResult,
  VOLUMES_PROTOCOL_VERSION,
  type VolumeStatusReport,
} from "@roundhouse/protocol";
import {
  LIVE_VOLUME_STATUSES,
  newId,
  VOLUME_MIGRATION_KEEP_MS,
  type VolumeStatusName,
} from "@roundhouse/shared";
import { and, desc, eq, inArray, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
import type { Env } from "../env";
import { auditInsert } from "./audit";
import { deleteBackup, scrubError } from "./backups/backups";
import { loadBackupStorage } from "./backups/storage";
import { disposeRpc } from "./deployments";
import { MIGRATION_TARGET_PHASES, runsSealedWorkloads } from "./desired-state";
import { effectiveStatus } from "./nodes";
import { enforcesTcpProxy } from "./tcp-proxies";
import type { VolumeRow } from "./volumes";

/** A `volume_migrations` row. */
export type MigrationRow = typeof volumeMigrations.$inferSelect;

type NodeRow = typeof nodes.$inferSelect;

/** Workflow event the node Durable Object sends when a node answers for a migration. */
export const MIGRATION_EVENT = "migration";

/** Volume statuses a migration may start from. */
export const MIGRATABLE_VOLUME_STATUSES: readonly VolumeStatusName[] = ["ready", "degraded"];

/** Throughput assumed for the downtime estimate without a finished backup to go by. */
export const DEFAULT_COPY_BYTES_PER_S = 20 * 1024 * 1024;

/** Restart and health-check allowance in the downtime estimate. */
export const RESTART_ALLOWANCE_MS = 60_000;

/** How long after a `volume_delete` the minute tick sends it again. */
export const CLEANUP_RESEND_MS = 10 * 60 * 1000;

// -----------------------------------------------------------------------------
// Eligibility and estimate
// -----------------------------------------------------------------------------

/** What deciding whether a node can take a volume needs to know. */
export interface EligibilityContext {
  volume: VolumeRow;
  /** The service's placement labels (`placement.node_selector`). */
  nodeSelector: Readonly<Record<string, string>>;
  /** The quota mode the volume is enforced with now; `null` when unknown. */
  sourceQuota: string | null;
  /** MiB allocated to volumes (held or arriving) per node. */
  allocatedMb: ReadonlyMap<string, number>;
  /** Whether the service publishes a TCP port. */
  hasTcpProxy: boolean;
  /** Nodes deleting an old copy of this volume right now. */
  cleaningUp: ReadonlySet<string>;
  now: number;
}

/**
 * Why a node can't take the volume, or `null` when it can.
 *
 * @param node - The candidate.
 * @param ctx - The volume and what else decides it.
 * @returns A sentence for the dashboard, or `null`.
 */
export function targetIneligibility(node: NodeRow, ctx: EligibilityContext): string | null {
  const { volume } = ctx;
  if (node.id === volume.nodeId) return "It already holds the volume";
  if (node.deletedAt) return "It was removed";
  if (effectiveStatus(node, ctx.now) !== "online") return "It isn't online";
  if (node.protocolVersion < Math.max(VOLUMES_PROTOCOL_VERSION, BACKUPS_PROTOCOL_VERSION)) {
    return "Its agent is too old for volumes; upgrade it";
  }
  if (!runsSealedWorkloads(node)) return "It has no encryption key registered";
  if (!node.capabilities?.docker) return "It doesn't run Docker workloads";
  for (const [key, value] of Object.entries(ctx.nodeSelector)) {
    if (node.labels[key] !== value) return `It lacks the label ${key}=${value}`;
  }
  if (!node.volumeQuota) return "Its agent hasn't reported how it enforces volume quotas yet";
  if (node.volumeQuota === "none" && ctx.sourceQuota && ctx.sourceQuota !== "none") {
    return "It doesn't enforce volume quotas, and the volume's current node does";
  }
  if (ctx.hasTcpProxy && !enforcesTcpProxy(node)) {
    return "Its agent can't enforce the service's TCP proxy allowlist";
  }
  if (ctx.cleaningUp.has(node.id)) {
    return "It is still deleting an earlier copy of this volume; try again shortly";
  }
  if (node.diskTotal) {
    const freeMb = Math.floor(node.diskTotal / 2 ** 20) - (ctx.allocatedMb.get(node.id) ?? 0);
    if (freeMb < volume.sizeMb) return `It has ${Math.max(0, freeMb)} MiB unallocated`;
  }
  return null;
}

/**
 * Expected downtime of a move: the copy out and in at the throughput of the
 * service's last finished backup, plus a restart.
 *
 * @param usedBytes - The volume's last reported usage.
 * @param lastBackup - Raw bytes and duration of the last succeeded backup, if any.
 * @returns Milliseconds.
 */
export function estimateDowntimeMs(
  usedBytes: number,
  lastBackup: { bytesRaw: number; durationMs: number } | null,
): number {
  const rate =
    lastBackup && lastBackup.durationMs > 0 && lastBackup.bytesRaw > 0
      ? Math.max(1024 * 1024, (lastBackup.bytesRaw * 1000) / lastBackup.durationMs)
      : DEFAULT_COPY_BYTES_PER_S;
  return Math.round((2 * Math.max(0, usedBytes) * 1000) / rate) + RESTART_ALLOWANCE_MS;
}

/**
 * Loads what {@link targetIneligibility} needs for a volume.
 *
 * @param db - Database client.
 * @param volume - The volume.
 * @param now - Unix ms.
 * @returns The context.
 */
export async function eligibilityContext(
  db: Db,
  volume: VolumeRow,
  now = Date.now(),
): Promise<EligibilityContext> {
  const [config] = await db
    .select({ placement: serviceConfigs.placement })
    .from(serviceConfigs)
    .where(
      and(
        eq(serviceConfigs.serviceId, volume.serviceId),
        eq(serviceConfigs.environmentId, volume.environmentId),
      ),
    )
    .orderBy(desc(serviceConfigs.version))
    .limit(1);
  const [source] = volume.nodeId
    ? await db
        .select({ quota: nodes.volumeQuota })
        .from(nodes)
        .where(eq(nodes.id, volume.nodeId))
        .limit(1)
    : [];
  const held = await db
    .select({ nodeId: volumes.nodeId, sizeMb: volumes.sizeMb })
    .from(volumes)
    .where(and(isNotNull(volumes.nodeId), inArray(volumes.status, [...LIVE_VOLUME_STATUSES])));
  const arriving = await db
    .select({ nodeId: volumeMigrations.targetNodeId, sizeMb: volumes.sizeMb })
    .from(volumeMigrations)
    .innerJoin(volumes, eq(volumes.id, volumeMigrations.volumeId))
    .where(inArray(volumeMigrations.status, ["queued", "running"]));
  const allocatedMb = new Map<string, number>();
  for (const r of [...held, ...arriving]) {
    if (r.nodeId) allocatedMb.set(r.nodeId, (allocatedMb.get(r.nodeId) ?? 0) + r.sizeMb);
  }
  const cleaning = await db
    .select({ nodeId: volumeMigrations.cleanupNodeId })
    .from(volumeMigrations)
    .where(
      and(
        eq(volumeMigrations.volumeId, volume.id),
        isNotNull(volumeMigrations.cleanupSentAt),
        isNull(volumeMigrations.cleanedAt),
      ),
    );
  const [proxy] = await db
    .select({ id: tcpProxies.id })
    .from(tcpProxies)
    .where(
      and(
        eq(tcpProxies.serviceId, volume.serviceId),
        eq(tcpProxies.environmentId, volume.environmentId),
      ),
    )
    .limit(1);
  return {
    volume,
    nodeSelector: config?.placement.node_selector ?? {},
    sourceQuota: volume.quotaMode ?? source?.quota ?? null,
    allocatedMb,
    hasTcpProxy: proxy !== undefined,
    cleaningUp: new Set(cleaning.flatMap((r) => (r.nodeId ? [r.nodeId] : []))),
    now,
  };
}

/**
 * Every node of the volume's workspace with whether it can take the volume,
 * and the expected downtime.
 *
 * @param db - Database client.
 * @param volume - The volume.
 * @param workspaceId - The project's workspace; only its nodes are offered.
 * @returns See `MigrationTargetsSchema`.
 */
export async function migrationTargets(db: Db, volume: VolumeRow, workspaceId: string) {
  const ctx = await eligibilityContext(db, volume);
  const rows = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.workspaceId, workspaceId), isNull(nodes.deletedAt)))
    .orderBy(nodes.name);
  const [last] = await db
    .select({ bytesRaw: backups.bytesRaw, startedAt: backups.startedAt, finishedAt: backups.finishedAt })
    .from(backups)
    .where(
      and(
        eq(backups.serviceId, volume.serviceId),
        eq(backups.environmentId, volume.environmentId),
        eq(backups.status, "succeeded"),
      ),
    )
    .orderBy(desc(backups.id))
    .limit(1);
  const lastBackup =
    last?.bytesRaw && last.startedAt && last.finishedAt
      ? { bytesRaw: last.bytesRaw, durationMs: +last.finishedAt - +last.startedAt }
      : null;
  return {
    volume_id: volume.id,
    source_node_id: volume.nodeId,
    estimated_downtime_ms: estimateDowntimeMs(volume.usedBytes ?? 0, lastBackup),
    targets: rows
      .filter((n) => n.id !== volume.nodeId)
      .map((n) => {
        const reason = targetIneligibility(n, ctx);
        return {
          node_id: n.id,
          name: n.name,
          eligible: reason === null,
          reason,
          quota_mode: n.volumeQuota ?? null,
        };
      }),
  };
}

// -----------------------------------------------------------------------------
// Starting and waking
// -----------------------------------------------------------------------------

/** Parameters of a volume migration workflow instance. */
export interface VolumeMigrationParams {
  migrationId: string;
  /** The control plane's public origin, for the redeploy's links. */
  origin: string;
}

/**
 * Inserts a `queued` migration. The partial unique index allows one active
 * migration per volume; a concurrent second one gets 409.
 *
 * @param db - Database client.
 * @param input - The volume, both nodes and who asked.
 * @returns The row.
 * @throws When the index refuses it (the route maps that to 409).
 */
export async function createMigrationRow(
  db: Db,
  input: { volume: VolumeRow; targetNodeId: string; requestedBy: string | null },
): Promise<MigrationRow> {
  const now = new Date();
  const [row] = await db
    .insert(volumeMigrations)
    .values({
      id: newId("volumeMigration"),
      volumeId: input.volume.id,
      sourceNodeId: input.volume.nodeId,
      targetNodeId: input.targetNodeId,
      status: "queued",
      phase: "queued",
      priorStatus: input.volume.status,
      requestedBy: input.requestedBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row!;
}

/**
 * Starts a migration's workflow (instance ID = migration ID).
 *
 * @param env - Bindings with `VOLUME_MIGRATION_WORKFLOW`.
 * @param params - The migration and the public origin.
 */
export async function startVolumeMigration(
  env: Pick<Env, "VOLUME_MIGRATION_WORKFLOW">,
  params: VolumeMigrationParams,
): Promise<void> {
  disposeRpc(await env.VOLUME_MIGRATION_WORKFLOW.create({ id: params.migrationId, params }));
}

/**
 * Wakes a migration's workflow so it re-reads D1. Lost wake-ups are harmless:
 * it checks D1 before every wait and on every timeout.
 *
 * @param env - Bindings with `VOLUME_MIGRATION_WORKFLOW`.
 * @param migrationId - The migration (its workflow instance ID).
 */
export async function wakeMigrationWorkflow(
  env: Pick<Env, "VOLUME_MIGRATION_WORKFLOW">,
  migrationId: string,
): Promise<void> {
  try {
    const instance = await env.VOLUME_MIGRATION_WORKFLOW.get(migrationId);
    try {
      await instance.sendEvent({ type: MIGRATION_EVENT, payload: {} });
    } finally {
      disposeRpc(instance);
    }
  } catch (err) {
    console.warn("migration wake-up failed", migrationId, err instanceof Error ? err.name : "error");
  }
}

/**
 * Wakes the migration whose copy-out is the given backup, if any.
 *
 * @param env - Bindings.
 * @param db - Database client.
 * @param backupId - A `migration` backup the source just answered for.
 */
export async function wakeMigrationOfBackup(env: Env, db: Db, backupId: string): Promise<void> {
  const [row] = await db
    .select({ id: volumeMigrations.id })
    .from(volumeMigrations)
    .where(and(eq(volumeMigrations.backupId, backupId), eq(volumeMigrations.status, "running")))
    .limit(1);
  if (row) await wakeMigrationWorkflow(env, row.id);
}

// -----------------------------------------------------------------------------
// Node reports
// -----------------------------------------------------------------------------

/**
 * Records a `restore_result` that answers a `volume_copy_in` (its
 * `restore_id` is the migration ID) and wakes the workflow.
 *
 * @param env - Bindings.
 * @param db - Database client.
 * @param nodeId - The reporting node.
 * @param frame - The result.
 * @returns Whether it answered a migration of this node's.
 */
export async function onMigrationCopyIn(
  env: Env,
  db: Db,
  nodeId: string,
  frame: RestoreResult,
): Promise<boolean> {
  const now = new Date();
  const [row] = await db
    .update(volumeMigrations)
    .set({
      copyFinishedAt: now,
      copyError: frame.ok ? null : scrubError(frame.error ?? "copy failed"),
      copiedBytes: frame.ok ? (frame.bytes ?? null) : null,
      updatedAt: now,
    })
    .where(
      and(
        eq(volumeMigrations.id, frame.restore_id),
        eq(volumeMigrations.targetNodeId, nodeId),
        eq(volumeMigrations.status, "running"),
        eq(volumeMigrations.phase, "copying_in"),
        isNull(volumeMigrations.copyFinishedAt),
      ),
    )
    .returning({ id: volumeMigrations.id });
  if (!row) return false;
  await wakeMigrationWorkflow(env, row.id);
  return true;
}

/**
 * Applies a node's `volume_status` to migrations: the target's state of a
 * volume moving to it (waking the workflow when it changes), and the
 * cleanup node confirming it deleted its old copy.
 *
 * @param env - Bindings.
 * @param db - Database client.
 * @param nodeId - The reporting node.
 * @param reports - The node's volumes.
 * @param now - Receive time, unix ms.
 */
export async function onMigrationVolumeReports(
  env: Env,
  db: Db,
  nodeId: string,
  reports: readonly VolumeStatusReport[],
  now = Date.now(),
): Promise<void> {
  if (!reports.length) return;
  const byId = new Map(reports.map((r) => [r.volume_id, r]));
  const ids = [...byId.keys()].slice(0, 90);
  const arriving = await db
    .select({ id: volumeMigrations.id, volumeId: volumeMigrations.volumeId, state: volumeMigrations.targetState })
    .from(volumeMigrations)
    .where(
      and(
        eq(volumeMigrations.targetNodeId, nodeId),
        eq(volumeMigrations.status, "running"),
        inArray(volumeMigrations.phase, [...MIGRATION_TARGET_PHASES]),
        inArray(volumeMigrations.volumeId, ids),
      ),
    );
  for (const m of arriving) {
    const state = byId.get(m.volumeId)!.state;
    if (state === m.state) continue;
    await db
      .update(volumeMigrations)
      .set({ targetState: state, updatedAt: new Date(now) })
      .where(eq(volumeMigrations.id, m.id));
    await wakeMigrationWorkflow(env, m.id);
  }
  const deleted = ids.filter((id) => byId.get(id)!.state === "deleted");
  if (deleted.length) {
    await db
      .update(volumeMigrations)
      .set({ cleanedAt: new Date(now), updatedAt: new Date(now) })
      .where(
        and(
          eq(volumeMigrations.cleanupNodeId, nodeId),
          inArray(volumeMigrations.volumeId, deleted),
          isNotNull(volumeMigrations.cleanupSentAt),
          isNull(volumeMigrations.cleanedAt),
        ),
      );
  }
}

// -----------------------------------------------------------------------------
// Cleanup
// -----------------------------------------------------------------------------

/**
 * Cancels pending deletions of a volume's old copy on a node it is moving
 * back to: the copy-in replaces that data, and deleting it afterwards would
 * remove the live volume (the agent refuses that while it is listed, but
 * the control plane must not ask).
 *
 * @param db - Database client.
 * @param volumeId - The volume.
 * @param nodeId - The node it moves to.
 */
export async function cancelCleanupOn(db: Db, volumeId: string, nodeId: string): Promise<void> {
  await db
    .update(volumeMigrations)
    .set({ cleanupNodeId: null, cleanupAfter: null, updatedAt: new Date() })
    .where(
      and(
        eq(volumeMigrations.volumeId, volumeId),
        eq(volumeMigrations.cleanupNodeId, nodeId),
        isNull(volumeMigrations.cleanupSentAt),
        isNull(volumeMigrations.cleanedAt),
      ),
    );
}

/**
 * Sends `volume_delete` for copies left behind by migrations whose grace
 * period ended, and deletes the migration's snapshot backup the first time.
 * A copy is never deleted from the node that holds the live volume or one
 * it is moving to. A gone node is marked cleaned at once.
 *
 * @param env - Worker bindings.
 * @param now - The tick's time, unix ms.
 * @returns How many copies were handled.
 */
export async function claimMigrationCleanups(env: Env, now: number): Promise<number> {
  const db = createDb(env.DB);
  const due = await db
    .select({ migration: volumeMigrations, volume: volumes })
    .from(volumeMigrations)
    .innerJoin(volumes, eq(volumes.id, volumeMigrations.volumeId))
    .where(
      and(
        isNull(volumeMigrations.cleanedAt),
        isNotNull(volumeMigrations.cleanupNodeId),
        lte(volumeMigrations.cleanupAfter, new Date(now)),
        or(
          isNull(volumeMigrations.cleanupSentAt),
          lte(volumeMigrations.cleanupSentAt, new Date(now - CLEANUP_RESEND_MS)),
        ),
      ),
    )
    .limit(100);
  let handled = 0;
  for (const { migration: m, volume } of due) {
    const nodeId = m.cleanupNodeId!;
    if (volume.nodeId === nodeId) {
      // The volume lives there again; its old copy is the live one now.
      await db
        .update(volumeMigrations)
        .set({ cleanupNodeId: null, cleanupAfter: null, updatedAt: new Date(now) })
        .where(eq(volumeMigrations.id, m.id));
      continue;
    }
    const [inbound] = await db
      .select({ id: volumeMigrations.id })
      .from(volumeMigrations)
      .where(
        and(
          eq(volumeMigrations.volumeId, volume.id),
          eq(volumeMigrations.targetNodeId, nodeId),
          inArray(volumeMigrations.status, ["queued", "running"]),
          ne(volumeMigrations.id, m.id),
        ),
      )
      .limit(1);
    if (inbound) continue;
    const [claimed] = await db
      .update(volumeMigrations)
      .set({ cleanupSentAt: new Date(now), updatedAt: new Date(now) })
      .where(
        and(
          eq(volumeMigrations.id, m.id),
          isNull(volumeMigrations.cleanedAt),
          m.cleanupSentAt
            ? eq(volumeMigrations.cleanupSentAt, m.cleanupSentAt)
            : isNull(volumeMigrations.cleanupSentAt),
        ),
      )
      .returning({ id: volumeMigrations.id });
    if (!claimed) continue;
    handled++;
    if (!m.cleanupSentAt && m.backupId) await dropMigrationBackup(env, db, m.backupId);
    const node = await db.query.nodes.findFirst({
      where: and(eq(nodes.id, nodeId), isNull(nodes.deletedAt)),
      columns: { id: true },
    });
    if (!node) {
      await db
        .update(volumeMigrations)
        .set({ cleanedAt: new Date(now), updatedAt: new Date(now) })
        .where(eq(volumeMigrations.id, m.id));
      continue;
    }
    try {
      const stub = env.NODE_CONNECTION.get(env.NODE_CONNECTION.idFromName(nodeId));
      disposeRpc(await stub.sendVolumeDelete(volume.id));
    } catch (err) {
      // `cleanup_sent_at` is set, so the resend interval paces the retry.
      console.warn("migration cleanup failed", m.id, err instanceof Error ? err.name : "error");
    }
  }
  return handled;
}

async function dropMigrationBackup(env: Env, db: Db, backupId: string): Promise<void> {
  try {
    const [b] = await db.select().from(backups).where(eq(backups.id, backupId)).limit(1);
    if (!b || b.trigger !== "migration") return;
    const s3 = await loadBackupStorage(db, env);
    if (s3) await deleteBackup(db, s3, b);
  } catch (err) {
    // NOTE: the backup stays listed and can be deleted by hand; the copy's cleanup goes on.
    console.warn("migration backup delete failed", err instanceof Error ? err.message : "error");
  }
}

// -----------------------------------------------------------------------------
// Presentation and audit
// -----------------------------------------------------------------------------

/**
 * @param m - Migration row.
 * @param volume - Its volume (for the service and environment).
 * @returns The `VolumeMigration` wire shape.
 */
export function toApiMigration(m: MigrationRow, volume: Pick<VolumeRow, "serviceId" | "environmentId">) {
  return {
    id: m.id,
    volume_id: m.volumeId,
    service_id: volume.serviceId,
    environment_id: volume.environmentId,
    source_node_id: m.sourceNodeId,
    target_node_id: m.targetNodeId,
    status: m.status,
    phase: m.phase,
    backup_id: m.backupId,
    deployment_id: m.deploymentId,
    copied_bytes: m.copiedBytes,
    error: m.error,
    requested_by: m.requestedBy,
    cleanup_after: m.cleanupAfter ? +m.cleanupAfter : null,
    started_at: m.startedAt ? +m.startedAt : null,
    finished_at: m.finishedAt ? +m.finishedAt : null,
    created_at: +m.createdAt,
  };
}

/**
 * Records a system audit entry about a migration's outcome.
 *
 * @param db - Database client.
 * @param m - The migration.
 * @param action - `volume.migrated` or `volume.migration_failed`.
 * @param extra - More metadata; never a URL or key.
 */
export async function auditMigration(
  db: Db,
  m: MigrationRow,
  action: "volume.migrated" | "volume.migration_failed",
  extra: Record<string, unknown> = {},
): Promise<void> {
  const [owner] = await db
    .select({
      workspaceId: projects.workspaceId,
      projectId: volumes.projectId,
      serviceId: volumes.serviceId,
      environmentId: volumes.environmentId,
    })
    .from(volumes)
    .innerJoin(projects, eq(projects.id, volumes.projectId))
    .where(eq(volumes.id, m.volumeId))
    .limit(1);
  if (!owner) return;
  await auditInsert(db, {
    workspaceId: owner.workspaceId,
    actorType: "system",
    actorId: null,
    action,
    targetType: "volume",
    targetId: m.volumeId,
    metadata: {
      project_id: owner.projectId,
      service_id: owner.serviceId,
      environment_id: owner.environmentId,
      migration_id: m.id,
      source_node_id: m.sourceNodeId,
      target_node_id: m.targetNodeId,
      ...extra,
    },
  });
}

/**
 * The service's live replica on a node, if one runs there.
 *
 * @param db - Database client.
 * @param volume - The volume (its service and environment).
 * @param nodeId - The node.
 * @returns The workload ID, or `null`.
 */
export async function replicaOn(
  db: Db,
  volume: Pick<VolumeRow, "serviceId" | "environmentId">,
  nodeId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ workloadId: placements.workloadId })
    .from(placements)
    .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
    .where(
      and(
        eq(placements.nodeId, nodeId),
        eq(deployments.serviceId, volume.serviceId),
        eq(deployments.environmentId, volume.environmentId),
        inArray(deployments.status, ["deploying", "active", "crashed"]),
      ),
    )
    .orderBy(desc(placements.id))
    .limit(1);
  return row?.workloadId ?? null;
}

