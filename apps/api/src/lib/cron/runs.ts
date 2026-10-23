/**
 * Cron runs (ADR 0010): their IDs, wire shape, workflow plumbing, the armed
 * deployment a run uses, and history trimming.
 *
 * Scheduled and retry runs get deterministic IDs ({@link cronRunId}): a
 * ULID whose time part is the slot and whose random part is a hash of the
 * service, environment, slot and attempt. Two ticks that both believed they
 * owned a slot would mint the same ID, so the insert, the workflow instance
 * (named after the run) and the unique slot index all collapse them into
 * one run.
 *
 * @module
 */
import {
  cronRuns,
  type Db,
  deployments,
  environments,
  logChunks,
  projects,
  serviceConfigs,
  services,
} from "@roundhouse/db";
import {
  type CronConfig,
  type CronRunStatus,
  ID_PREFIXES,
  isTerminalCronRunStatus,
  type ServiceConfigSpec,
} from "@roundhouse/shared";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { Env } from "../../env";
import type { ApiCronRun } from "../../schemas/cron";
import { disposeRpc } from "../deployments";
import { publish } from "../realtime";

/** Workflow event the node's Durable Object sends when a run reports a terminal status. */
export const CRON_EVENT = "job";

/** Seconds past `timeout_s` a run may stay without a terminal report before it is `lost`. */
export const LOST_GRACE_S = 300;

/** SIGTERM → SIGKILL grace sent in every `job_run`. */
export const KILL_GRACE_S = 10;

/** How long `replace` waits for the run it cancels to report `cancelled`. */
export const REPLACE_WAIT_S = 30;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(ms: number): string {
  let out = "";
  let t = Math.max(0, Math.floor(ms));
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32]! + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function encodeBits(bytes: Uint8Array, chars: number): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
    if (out.length === chars) break;
  }
  return out;
}

/** What a deterministic run ID is derived from. */
export interface CronRunKey {
  serviceId: string;
  environmentId: string;
  /** The slot, unix ms. */
  scheduledFor: number;
  attempt: number;
  /** `run` for a run of the slot, `missed` for a record of missed slots starting there. */
  kind: "run" | "missed";
}

/**
 * The ID of a scheduled or retry run, or of a missed record.
 *
 * @param key - Service, environment, slot, attempt and kind.
 * @returns `crn_<ULID>` sortable by slot.
 * @example
 * await cronRunId({ serviceId: "svc_1", environmentId: "env_1", scheduledFor: 0, attempt: 1, kind: "run" });
 */
export async function cronRunId(key: CronRunKey): Promise<string> {
  const material = `${key.kind}:${key.serviceId}:${key.environmentId}:${key.scheduledFor}:${key.attempt}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material)),
  );
  return `${ID_PREFIXES.cronRun}_${encodeTime(key.scheduledFor)}${encodeBits(digest, 16)}`;
}

/** A `cron_runs` row. */
export type CronRunRow = typeof cronRuns.$inferSelect;

/**
 * @param r - Run row.
 * @param projectId - The service's project.
 * @returns The `CronRun` wire shape.
 */
export function toApiCronRun(r: CronRunRow, projectId: string): ApiCronRun {
  return {
    id: r.id,
    project_id: projectId,
    service_id: r.serviceId,
    environment_id: r.environmentId,
    deployment_id: r.deploymentId,
    trigger: r.trigger,
    scheduled_for: +r.scheduledFor,
    attempt: r.attempt,
    status: r.status,
    node_id: r.nodeId,
    exit_code: r.exitCode,
    missed_count: r.missedCount,
    error: r.error,
    triggered_by: r.triggeredBy,
    started_at: r.startedAt ? +r.startedAt : null,
    finished_at: r.finishedAt ? +r.finishedAt : null,
    created_at: +r.createdAt,
    updated_at: +r.updatedAt,
  };
}

/**
 * Sends `cron_run.updated` for runs to their project's sockets. Best effort.
 *
 * @param env - Bindings with the room namespace.
 * @param projectId - The project.
 * @param runs - Rows as they are now.
 */
export async function publishCronRuns(
  env: Pick<Env, "PROJECT_ROOM">,
  projectId: string,
  runs: readonly CronRunRow[],
): Promise<void> {
  for (const run of runs) {
    await publish(env, projectId, { type: "cron_run.updated", run: toApiCronRun(run, projectId) });
  }
}

/**
 * Re-reads runs and publishes them.
 *
 * @param env - Bindings.
 * @param db - Database client.
 * @param runIds - Runs to publish; missing ones are skipped.
 */
export async function publishCronRunsById(
  env: Pick<Env, "PROJECT_ROOM">,
  db: Db,
  runIds: readonly string[],
): Promise<void> {
  if (!runIds.length) return;
  const rows = await db
    .select({ run: cronRuns, projectId: services.projectId })
    .from(cronRuns)
    .innerJoin(services, eq(services.id, cronRuns.serviceId))
    .where(inArray(cronRuns.id, [...runIds]));
  for (const { run, projectId } of rows) await publishCronRuns(env, projectId, [run]);
}

/** Parameters of a cron run workflow instance. */
export interface CronRunParams {
  runId: string;
  /** Run now with `force`: cancel runs in progress first, whatever the policy. */
  replace?: boolean;
}

/**
 * Starts the workflow of a run; starting one that exists is a no-op.
 *
 * @param env - Bindings with `CRON_RUN_WORKFLOW`.
 * @param params - The run.
 */
export async function startCronRunWorkflow(
  env: Pick<Env, "CRON_RUN_WORKFLOW">,
  params: CronRunParams,
): Promise<void> {
  try {
    disposeRpc(await env.CRON_RUN_WORKFLOW.create({ id: params.runId, params }));
  } catch (err) {
    // An existing instance means a previous attempt got there first.
    try {
      disposeRpc(await env.CRON_RUN_WORKFLOW.get(params.runId));
    } catch {
      throw err;
    }
  }
}

/**
 * Wakes a run's workflow after its status changed. Best effort: the
 * workflow re-reads D1 and has its own deadline.
 *
 * @param env - Bindings with `CRON_RUN_WORKFLOW`.
 * @param runId - The run (its workflow's instance ID).
 */
export async function wakeCronRunWorkflow(
  env: Pick<Env, "CRON_RUN_WORKFLOW">,
  runId: string,
): Promise<void> {
  try {
    const instance = await env.CRON_RUN_WORKFLOW.get(runId);
    try {
      await instance.sendEvent({ type: CRON_EVENT, payload: {} });
    } finally {
      disposeRpc(instance);
    }
  } catch (err) {
    console.warn("cron run wake-up failed", runId, err instanceof Error ? err.name : "error");
  }
}

/** A run with everything that owns it. */
export interface OwnedCronRun {
  run: CronRunRow;
  service: typeof services.$inferSelect;
  project: typeof projects.$inferSelect;
  environment: typeof environments.$inferSelect;
}

/**
 * Loads a run with its service, project and environment.
 *
 * @param db - Database client.
 * @param runId - The run.
 * @returns The rows, or `undefined` when the run is gone.
 */
export async function cronRunWithOwners(db: Db, runId: string): Promise<OwnedCronRun | undefined> {
  const [row] = await db
    .select({ run: cronRuns, service: services, project: projects, environment: environments })
    .from(cronRuns)
    .innerJoin(services, eq(services.id, cronRuns.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .innerJoin(environments, eq(environments.id, cronRuns.environmentId))
    .where(eq(cronRuns.id, runId))
    .limit(1);
  return row;
}

/** The armed deployment of a cron service and its config version. */
export interface ArmedDeployment {
  deployment: typeof deployments.$inferSelect;
  spec: ServiceConfigSpec;
  cron: CronConfig;
}

/**
 * The deployment every run of a cron service in an environment uses: its
 * `active` one, which a cron deploy leaves without replicas.
 *
 * @param db - Database client.
 * @param serviceId - The cron service.
 * @param environmentId - The environment.
 * @returns The deployment and its config, or `null` when none is armed or
 *   its config has no `cron` part.
 */
export async function armedDeployment(
  db: Db,
  serviceId: string,
  environmentId: string,
): Promise<ArmedDeployment | null> {
  const [row] = await db
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
        eq(deployments.serviceId, serviceId),
        eq(deployments.environmentId, environmentId),
        eq(deployments.status, "active"),
      ),
    )
    .orderBy(desc(deployments.id))
    .limit(1);
  if (!row?.config.cron) return null;
  return { deployment: row.deployment, spec: specFromRow(row.config), cron: row.config.cron };
}

/**
 * The config a run's deployment ran with.
 *
 * @param db - Database client.
 * @param deploymentId - The run's deployment.
 * @returns Deployment and config, or `null` when either is gone or has no `cron` part.
 */
export async function runDeployment(db: Db, deploymentId: string): Promise<ArmedDeployment | null> {
  const [row] = await db
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
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!row?.config.cron) return null;
  return { deployment: row.deployment, spec: specFromRow(row.config), cron: row.config.cron };
}

function specFromRow(row: typeof serviceConfigs.$inferSelect): ServiceConfigSpec {
  return {
    source: row.source,
    build: row.build,
    deploy: row.deploy,
    resources: row.resources,
    healthcheck: row.healthcheck ?? null,
    networking: row.networking,
    placement: row.placement,
    cron: row.cron ?? null,
  };
}

/**
 * Moves a run to a terminal status if it is still in one of `from`.
 *
 * @param db - Database client.
 * @param runId - The run.
 * @param status - Terminal status.
 * @param from - Statuses it may leave.
 * @param fields - Error text and exit code.
 * @returns The updated row, or `undefined` when it had moved on.
 */
export async function finishCronRun(
  db: Db,
  runId: string,
  status: CronRunStatus,
  from: readonly CronRunStatus[],
  fields: { error?: string | null; exitCode?: number | null } = {},
): Promise<CronRunRow | undefined> {
  if (!isTerminalCronRunStatus(status)) throw new Error(`${status} is not terminal`);
  const now = new Date();
  const [row] = await db
    .update(cronRuns)
    .set({
      status,
      finishedAt: now,
      updatedAt: now,
      ...(fields.error !== undefined ? { error: fields.error } : {}),
      ...(fields.exitCode !== undefined ? { exitCode: fields.exitCode } : {}),
    })
    .where(and(eq(cronRuns.id, runId), inArray(cronRuns.status, [...from])))
    .returning();
  return row;
}

/** Runs one trim deletes at most; the rest go with the next run's trim. */
const TRIM_BATCH = 100;

/**
 * Deletes the oldest finished runs of a service in an environment beyond
 * `limit`, with their log objects; the `log_chunks` rows go with the runs
 * through the foreign key.
 *
 * @param db - Database client.
 * @param bucket - The `LOGS` bucket.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @param limit - Runs to keep.
 * @returns How many runs were deleted.
 */
export async function trimCronHistory(
  db: Db,
  bucket: R2Bucket,
  serviceId: string,
  environmentId: string,
  limit: number,
): Promise<number> {
  const scope = and(eq(cronRuns.serviceId, serviceId), eq(cronRuns.environmentId, environmentId));
  const [boundary] = await db
    .select({ id: cronRuns.id })
    .from(cronRuns)
    .where(scope)
    .orderBy(desc(cronRuns.id))
    .limit(1)
    .offset(limit - 1);
  if (!boundary) return 0;
  const doomed = await db
    .select({ id: cronRuns.id, status: cronRuns.status })
    .from(cronRuns)
    .where(and(scope, lt(cronRuns.id, boundary.id)))
    .orderBy(cronRuns.id)
    .limit(TRIM_BATCH);
  const ids = doomed.filter((r) => isTerminalCronRunStatus(r.status)).map((r) => r.id);
  if (!ids.length) return 0;
  const chunks = await db
    .select({ r2Key: logChunks.r2Key })
    .from(logChunks)
    .where(inArray(logChunks.cronRunId, ids));
  // R2 deletes at most 1,000 keys per call.
  for (let i = 0; i < chunks.length; i += 1000) {
    await bucket.delete(chunks.slice(i, i + 1000).map((c) => c.r2Key));
  }
  await db.delete(cronRuns).where(inArray(cronRuns.id, ids));
  return ids.length;
}
