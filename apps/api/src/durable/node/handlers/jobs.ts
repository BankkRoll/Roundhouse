/**
 * The node Durable Object's job frames (ADR 0010):
 *
 * - `job_status`: moves the run to `running` or its terminal status and,
 *   once terminal, wakes the run's workflow, which reads it back from D1,
 *   and re-sends the meshed nodes their addresses when the run held a mesh IP;
 * - {@link jobLogOwner}: where a `job` log source's lines belong.
 *
 * SECURITY: every report is checked against the run's `node_id` and
 * `workload_id`, so an agent can only report on runs sent to it. A report
 * for a run that already ended (cancelled by the control plane, `lost`
 * after its deadline) is dropped, so a late agent can't rewrite history.
 *
 * @module
 */
import { cronRuns, type Db, services } from "@roundhouse/db";
import type { JobStatus } from "@roundhouse/protocol";
import { type CronRunStatus, PLACED_CRON_RUN_STATUSES } from "@roundhouse/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Env } from "../../../env";
import { scrubError } from "../../../lib/backups/backups";
import { publishCronRuns, wakeCronRunWorkflow } from "../../../lib/cron/runs";
import { refreshNodes } from "../../../lib/desired-state";
import { meshRefreshTargets } from "../../../lib/mesh";
import { getMeshSettings } from "../../../lib/settings";

/** What the handlers need from the Durable Object. */
export interface JobFrameContext {
  db: Db;
  env: Env;
  /** The reporting node, as authenticated at connect. */
  nodeId: string;
}

const TERMINAL: Partial<Record<JobStatus["state"], CronRunStatus>> = {
  succeeded: "succeeded",
  failed: "failed",
  timed_out: "timed_out",
  cancelled: "cancelled",
};

/**
 * Applies one `job_status`.
 *
 * @param ctx - Database, bindings and node.
 * @param frame - The validated frame.
 */
export async function onJobStatus(ctx: JobFrameContext, frame: JobStatus): Promise<void> {
  const mine = and(
    eq(cronRuns.id, frame.run_id),
    eq(cronRuns.nodeId, ctx.nodeId),
    eq(cronRuns.workloadId, frame.workload_id),
  );
  const now = new Date();
  const terminal = TERMINAL[frame.state];
  let updated: (typeof cronRuns.$inferSelect)[];
  if (terminal) {
    updated = await ctx.db
      .update(cronRuns)
      .set({
        status: terminal,
        exitCode: frame.exit_code ?? null,
        error:
          terminal === "succeeded"
            ? null
            : scrubError(frame.message ?? defaultMessage(terminal, frame.exit_code)),
        ...(frame.started_at !== undefined ? { startedAt: new Date(frame.started_at) } : {}),
        finishedAt: frame.finished_at !== undefined ? new Date(frame.finished_at) : now,
        updatedAt: now,
      })
      .where(and(mine, inArray(cronRuns.status, [...PLACED_CRON_RUN_STATUSES])))
      .returning();
  } else if (frame.state === "running") {
    updated = await ctx.db
      .update(cronRuns)
      .set({
        status: "running",
        startedAt: frame.started_at !== undefined ? new Date(frame.started_at) : now,
        updatedAt: now,
      })
      .where(and(mine, eq(cronRuns.status, "starting")))
      .returning();
  } else {
    return;
  }
  const [run] = updated;
  if (!run) return;
  const [owner] = await ctx.db
    .select({ projectId: services.projectId })
    .from(services)
    .where(eq(services.id, run.serviceId))
    .limit(1);
  if (owner) await publishCronRuns(ctx.env, owner.projectId, [run]);
  if (terminal) await wakeCronRunWorkflow(ctx.env, run.id);
  if (terminal && run.meshIp) {
    try {
      // The run's address is free again; peers drop it from their rules.
      // This node's own frame follows its next change: calling its own
      // Durable Object from inside it would wait on itself.
      const mesh = await getMeshSettings(ctx.db);
      const peers = (await meshRefreshTargets(ctx.db, [ctx.nodeId], mesh)).filter(
        (id) => id !== ctx.nodeId,
      );
      if (peers.length) await refreshNodes(ctx.env, ctx.db, peers);
    } catch (err) {
      console.error("mesh refresh failed", err instanceof Error ? err.message : "error");
    }
  }
}

function defaultMessage(status: CronRunStatus, exitCode: number | undefined): string {
  if (status === "failed") return exitCode === undefined ? "failed" : `exited with ${exitCode}`;
  return status.replace("_", " ");
}

/** Where a job's lines go, as the node DO files them. */
export interface JobLogOwner {
  projectId: string;
  serviceId: string;
  environmentId: string;
  cronRunId: string;
  /** Deployment whose frozen secret set redacts the lines. */
  redactionDeploymentId: string;
}

/**
 * The owner of a `job` log source, accepting only runs sent to this node.
 * Lines that arrive after the run ended are still filed: the agent ships
 * the tail after the terminal status.
 *
 * @param db - Database client.
 * @param nodeId - The reporting node.
 * @param source - The frame's source.
 * @returns The owner, or `null` to drop the lines.
 */
export async function jobLogOwner(
  db: Db,
  nodeId: string,
  source: { run_id: string; workload_id: string },
): Promise<JobLogOwner | null> {
  const [row] = await db
    .select({
      projectId: services.projectId,
      serviceId: cronRuns.serviceId,
      environmentId: cronRuns.environmentId,
      deploymentId: cronRuns.deploymentId,
    })
    .from(cronRuns)
    .innerJoin(services, eq(services.id, cronRuns.serviceId))
    .where(
      and(
        eq(cronRuns.id, source.run_id),
        eq(cronRuns.nodeId, nodeId),
        eq(cronRuns.workloadId, source.workload_id),
      ),
    )
    .limit(1);
  if (!row?.deploymentId) return null;
  return {
    projectId: row.projectId,
    serviceId: row.serviceId,
    environmentId: row.environmentId,
    cronRunId: source.run_id,
    redactionDeploymentId: row.deploymentId,
  };
}
