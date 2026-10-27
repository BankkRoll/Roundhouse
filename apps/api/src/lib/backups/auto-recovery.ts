/**
 * Automatic recovery (ADR 0004, "Automatic recovery"): an opt-in policy per
 * service and environment. When the node holding the service's volume stays
 * offline (or is removed) for the policy's grace period, the latest
 * succeeded backup is restored onto a healthy node, exactly as a person
 * would through "Recover on another server" (`./recovery`).
 *
 * The minute tick ({@link claimRecoveries}) walks enabled policies:
 * - while the node is reachable the policy is `idle`; while it is offline
 *   inside the grace period, `watching`;
 * - past the grace period it re-checks that the person who turned the
 *   policy on may still recover the service by hand (`backups:restore`,
 *   `services:manage`, `deployments:create` in that environment, which
 *   includes its protection rules), picks the newest succeeded backup and a
 *   target the scheduler would place the service on (online, not draining
 *   or in maintenance, with the volume's disk, labels and mesh span), and
 *   starts the recovery; the policy is then `recovering` until the restore
 *   ends (`recovered` or `failed`);
 * - when it can't start, the policy is `blocked` with the reason and an
 *   audit entry, and the next tick tries again.
 *
 * SECURITY: a policy never does more than its enabler could do by hand
 * right now: a person who lost access, or an environment that became
 * protected against their role, blocks it. A node in `maintenance` or
 * `draining` is an operator's decision and never counts as lost.
 *
 * @module
 */
import {
  backups,
  createDb,
  type Db,
  deployments,
  nodes,
  projects,
  recoveryPolicies,
  restores,
  serviceConfigs,
  services,
} from "@roundhouse/db";
import { REGISTRY_LISTEN, VOLUMES_PROTOCOL_VERSION } from "@roundhouse/protocol";
import {
  type Action,
  type RecoveryPolicyStatus,
  resolveAccess,
  schedule,
} from "@roundhouse/shared";
import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import type { Env } from "../../env";
import { loadWorkspaceAccess } from "../access";
import { recordAudit } from "../audit";
import { ApiError } from "../errors";
import { effectiveStatus } from "../nodes";
import { configuredOrigin } from "../origin";
import { builderOfDeployment, environmentNodeIds, schedulerSnapshot } from "../scheduling";
import { eligibilityContext, targetIneligibility } from "../volume-migrations";
import { type VolumeRow, volumeOf } from "../volumes";
import { beginVolumeRecovery } from "./recovery";
import { startRestoreWorkflow } from "./restores";

/** A `recovery_policies` row. */
export type RecoveryPolicyRow = typeof recoveryPolicies.$inferSelect;

/** What a recovery needs its enabler to be allowed, as a manual recovery does. */
export const RECOVERY_ACTIONS: readonly Action[] = [
  "backups:restore",
  "services:manage",
  "deployments:create",
];

/** Policies one tick walks. */
const CLAIM_BATCH = 100;

/**
 * Why `userId` may not recover the service in the environment right now, or
 * `null` when they may: the same checks a manual recovery runs, protection
 * rules included.
 *
 * @param db - Database client.
 * @param input - Workspace, project, environment and user.
 * @returns A sentence, or `null`.
 */
export async function enablerDenial(
  db: Db,
  input: { workspaceId: string; projectId: string; environmentId: string; userId: string | null },
): Promise<string | null> {
  if (!input.userId)
    return "Whoever turned automatic recovery on no longer exists; turn it on again";
  const loaded = await loadWorkspaceAccess(db, input.workspaceId, input.userId, input.projectId);
  if (!loaded.role) return "Whoever turned automatic recovery on is no longer a member";
  const access = resolveAccess(
    {
      userId: input.userId,
      workspaceRole: loaded.role,
      instanceAdmin: false,
      teamIds: loaded.teamIds,
      tokenScopes: null,
    },
    loaded.context,
  );
  for (const action of RECOVERY_ACTIONS) {
    const decision = access.check(action, {
      projectId: input.projectId,
      environmentId: input.environmentId,
    });
    if (!decision.allowed) {
      return decision.reason === "environment_protected"
        ? `The environment is protected and whoever turned automatic recovery on may no longer ${action} there`
        : `Whoever turned automatic recovery on may no longer ${action}`;
    }
  }
  return null;
}

/**
 * The newest succeeded backup a recovery can restore: a dump or base backup
 * of a database, a snapshot of anything else; never a migration's copy.
 *
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @returns The backup, or `undefined`.
 */
export async function latestRecoverableBackup(db: Db, serviceId: string, environmentId: string) {
  const [row] = await db
    .select()
    .from(backups)
    .where(
      and(
        eq(backups.serviceId, serviceId),
        eq(backups.environmentId, environmentId),
        eq(backups.status, "succeeded"),
        ne(backups.trigger, "migration"),
        isNotNull(backups.finishedAt),
      ),
    )
    .orderBy(desc(backups.finishedAt))
    .limit(1);
  return row;
}

/**
 * Where the scheduler would put the service if its volume had to move off
 * `lost`: a node that passes the volume move rules and has room for the
 * replica, its labels and the environment's mesh span.
 *
 * @param db - Database client.
 * @param input - The volume, the workspace and the lost node.
 * @returns The node's ID, or why there is none.
 */
export async function pickRecoveryTarget(
  db: Db,
  input: { volume: VolumeRow; workspaceId: string; lostNodeId: string },
): Promise<{ ok: true; nodeId: string } | { ok: false; reason: string }> {
  const { volume } = input;
  const [last] = await db
    .select({ deployment: deployments, config: serviceConfigs })
    .from(deployments)
    .innerJoin(
      serviceConfigs,
      and(
        eq(serviceConfigs.serviceId, deployments.serviceId),
        eq(serviceConfigs.environmentId, deployments.environmentId),
        eq(serviceConfigs.version, deployments.configVersion),
      ),
    )
    .where(
      and(
        eq(deployments.serviceId, volume.serviceId),
        eq(deployments.environmentId, volume.environmentId),
        inArray(deployments.status, ["active", "crashed"]),
      ),
    )
    .orderBy(desc(deployments.id))
    .limit(1);
  if (!last?.deployment.image) {
    return { ok: false, reason: "The service has no active deployment to start elsewhere" };
  }
  const candidates = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.workspaceId, input.workspaceId), ne(nodes.id, input.lostNodeId)));
  const ctx = await eligibilityContext(db, { ...volume, nodeId: input.lostNodeId });
  const eligible = new Set<string>();
  const why: string[] = [];
  for (const n of candidates) {
    if (n.deletedAt) continue;
    const reason = targetIneligibility(n, ctx);
    if (reason) why.push(`${n.name}: ${reason}`);
    else eligible.add(n.id);
  }
  if (!eligible.size) {
    return {
      ok: false,
      reason: why.length
        ? `No server can take the volume (${why.slice(0, 3).join("; ")})`
        : "There is no other server to recover onto",
    };
  }
  const local = last.deployment.image.startsWith(`${REGISTRY_LISTEN}/`);
  const { nodes: snapshot } = await schedulerSnapshot(db, {
    workspaceId: input.workspaceId,
    excludeDeploymentId: last.deployment.id,
    registryNodeId: local ? await builderOfDeployment(db, last.deployment.id) : null,
  });
  const result = schedule(
    {
      serviceId: volume.serviceId,
      replicas: 1,
      cpuMillis: last.config.resources.cpu_millis,
      memoryMb: last.config.resources.memory_mb,
      nodeSelector: last.config.placement.node_selector,
      requiresRegistry: local,
      excludeNodeIds: [input.lostNodeId],
      minProtocolVersion: VOLUMES_PROTOCOL_VERSION,
      diskMb: volume.sizeMb,
      environmentNodeIds: (
        await environmentNodeIds(db, volume.environmentId, volume.serviceId)
      ).filter((id) => id !== input.lostNodeId),
    },
    snapshot.filter((n) => eligible.has(n.id)),
  );
  if (!result.ok) {
    return {
      ok: false,
      reason: `The scheduler found no server for the service: ${result.reason.replace(/_/g, " ")}`,
    };
  }
  return { ok: true, nodeId: result.placements[0]!.nodeId };
}

/** What one policy's tick decided; for logs and tests. */
export type RecoveryOutcome =
  | "idle"
  | "watching"
  | "recovering"
  | "triggered"
  | "blocked"
  | "settled";

/**
 * Minute-tick claimer: walks enabled recovery policies and starts the
 * recoveries whose grace period ended.
 *
 * @param env - Worker bindings.
 * @param now - The tick's time, unix ms.
 * @returns How many recoveries were started.
 */
export async function claimRecoveries(env: Env, now: number): Promise<number> {
  const db = createDb(env.DB);
  const rows = await db
    .select({ policy: recoveryPolicies, service: services, project: projects })
    .from(recoveryPolicies)
    .innerJoin(services, eq(services.id, recoveryPolicies.serviceId))
    .innerJoin(projects, eq(projects.id, recoveryPolicies.projectId))
    .where(eq(recoveryPolicies.enabled, true))
    .orderBy(recoveryPolicies.id)
    .limit(CLAIM_BATCH);
  let started = 0;
  for (const row of rows) {
    if (row.service.deletedAt || row.project.deletedAt) continue;
    try {
      if ((await tickPolicy(env, db, row, now)) === "triggered") started++;
    } catch (err) {
      console.error(
        "automatic recovery failed",
        row.policy.id,
        err instanceof Error ? err.message : "error",
      );
    }
  }
  return started;
}

async function setStatus(
  db: Db,
  policy: RecoveryPolicyRow,
  status: RecoveryPolicyStatus,
  message: string | null,
  extra: Partial<typeof recoveryPolicies.$inferInsert> = {},
  now = Date.now(),
): Promise<boolean> {
  if (
    policy.status === status &&
    policy.message === message &&
    Object.keys(extra).every(
      (k) => (policy as Record<string, unknown>)[k] === (extra as Record<string, unknown>)[k],
    )
  ) {
    return false;
  }
  const [row] = await db
    .update(recoveryPolicies)
    .set({ status, message, ...extra, updatedAt: new Date(now) })
    .where(and(eq(recoveryPolicies.id, policy.id), eq(recoveryPolicies.status, policy.status)))
    .returning({ id: recoveryPolicies.id });
  return row !== undefined;
}

async function tickPolicy(
  env: Env,
  db: Db,
  row: {
    policy: RecoveryPolicyRow;
    service: typeof services.$inferSelect;
    project: typeof projects.$inferSelect;
  },
  now: number,
): Promise<RecoveryOutcome> {
  const { policy, service, project } = row;
  if (policy.status === "recovering" && policy.restoreId) {
    const [restore] = await db
      .select({ status: restores.status, error: restores.error })
      .from(restores)
      .where(eq(restores.id, policy.restoreId))
      .limit(1);
    if (!restore || restore.status === "queued" || restore.status === "running")
      return "recovering";
    await setStatus(
      db,
      policy,
      restore.status === "succeeded" ? "recovered" : "failed",
      restore.status === "succeeded" ? null : (restore.error ?? "The recovery restore failed"),
      {},
      now,
    );
    return "settled";
  }
  const volume = await volumeOf(db, service.id, policy.environmentId);
  if (!volume?.nodeId) {
    await setStatus(db, policy, "idle", null, { lostNodeId: null }, now);
    return "idle";
  }
  const [node] = await db.select().from(nodes).where(eq(nodes.id, volume.nodeId)).limit(1);
  const lost = !node || node.deletedAt !== null || effectiveStatus(node, now) === "offline";
  if (!lost) {
    // A recovered or failed outcome stays shown until the next outage.
    if (policy.status === "watching" || policy.status === "blocked") {
      await setStatus(db, policy, "idle", null, { lostNodeId: null }, now);
    }
    return "idle";
  }
  const since = node?.lastHeartbeatAt
    ? +node.lastHeartbeatAt
    : node?.deletedAt
      ? +node.deletedAt
      : now;
  const due = since + policy.graceMinutes * 60_000;
  if (node && !node.deletedAt && now < due) {
    await setStatus(
      db,
      policy,
      "watching",
      `${node.name} is offline; recovery starts at ${new Date(due).toISOString()} unless it comes back`,
      { lostNodeId: node.id },
      now,
    );
    return "watching";
  }
  const [busy] = await db
    .select({ id: restores.id })
    .from(restores)
    .where(
      and(
        eq(restores.targetServiceId, service.id),
        eq(restores.targetEnvironmentId, policy.environmentId),
        inArray(restores.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (busy) return "recovering";

  const block = async (reason: string): Promise<RecoveryOutcome> => {
    const changed = await setStatus(
      db,
      policy,
      "blocked",
      reason,
      { lostNodeId: volume.nodeId },
      now,
    );
    if (changed) {
      await recordAudit(db, {
        workspaceId: project.workspaceId,
        actorType: "system",
        actorId: null,
        action: "recovery.blocked",
        targetType: "service",
        targetId: service.id,
        metadata: {
          project_id: project.id,
          environment_id: policy.environmentId,
          policy_id: policy.id,
          lost_node_id: volume.nodeId,
          reason,
        },
      });
    }
    return "blocked";
  };

  const denied = await enablerDenial(db, {
    workspaceId: project.workspaceId,
    projectId: project.id,
    environmentId: policy.environmentId,
    userId: policy.enabledBy,
  });
  if (denied) return block(denied);
  const backup = await latestRecoverableBackup(db, service.id, policy.environmentId);
  if (!backup) return block("The service has no succeeded backup to recover from");
  const target = await pickRecoveryTarget(db, {
    volume,
    workspaceId: project.workspaceId,
    lostNodeId: volume.nodeId,
  });
  if (!target.ok) return block(target.reason);
  const origin = configuredOrigin(env);
  if (!origin) return block("PUBLIC_ORIGIN is not configured, so the service can't be redeployed");

  // Claimed before starting, so two overlapping ticks never both recover.
  const [claimed] = await db
    .update(recoveryPolicies)
    .set({
      status: "recovering",
      message: null,
      lostNodeId: volume.nodeId,
      triggeredAt: new Date(now),
      updatedAt: new Date(now),
    })
    .where(and(eq(recoveryPolicies.id, policy.id), ne(recoveryPolicies.status, "recovering")))
    .returning({ id: recoveryPolicies.id });
  if (!claimed) return "recovering";
  let restoreId: string;
  try {
    const restore = await beginVolumeRecovery(
      { db, env },
      {
        backup,
        service,
        project,
        targetNodeId: target.nodeId,
        actor: { actorType: "system", actorId: null },
        requestedBy: policy.enabledBy,
        trigger: "automatic",
        ip: null,
        origin,
        auditExtra: { policy_id: policy.id },
      },
    );
    restoreId = restore.id;
    await startRestoreWorkflow(env, restore.id);
  } catch (err) {
    const reason =
      err instanceof ApiError || err instanceof Error ? err.message : "Recovery failed to start";
    await db
      .update(recoveryPolicies)
      .set({ status: "idle", updatedAt: new Date(now) })
      .where(eq(recoveryPolicies.id, policy.id));
    return block(reason);
  }
  await db
    .update(recoveryPolicies)
    .set({ restoreId, updatedAt: new Date(now) })
    .where(eq(recoveryPolicies.id, policy.id));
  await recordAudit(db, {
    workspaceId: project.workspaceId,
    actorType: "system",
    actorId: null,
    action: "recovery.triggered",
    targetType: "service",
    targetId: service.id,
    metadata: {
      project_id: project.id,
      environment_id: policy.environmentId,
      policy_id: policy.id,
      enabled_by: policy.enabledBy,
      lost_node_id: volume.nodeId,
      target_node_id: target.nodeId,
      backup_id: backup.id,
      restore_id: restoreId,
      offline_since: since,
    },
  });
  return "triggered";
}

/**
 * @param p - A policy row, or `undefined` for the defaults.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @param defaultGrace - Grace period shown when none is saved, in minutes.
 * @returns The `RecoveryPolicy` wire shape.
 */
export function toApiRecoveryPolicy(
  p: RecoveryPolicyRow | undefined,
  serviceId: string,
  environmentId: string,
  defaultGrace: number,
) {
  return {
    id: p?.id ?? null,
    service_id: serviceId,
    environment_id: environmentId,
    enabled: p?.enabled ?? false,
    grace_minutes: p?.graceMinutes ?? defaultGrace,
    enabled_by: p?.enabledBy ?? null,
    status: p?.enabled ? p.status : ("idle" as const),
    message: p?.enabled ? (p.message ?? null) : null,
    lost_node_id: p?.enabled ? (p.lostNodeId ?? null) : null,
    restore_id: p?.restoreId ?? null,
    triggered_at: p?.triggeredAt ? +p.triggeredAt : null,
    updated_at: p ? +p.updatedAt : null,
  };
}
