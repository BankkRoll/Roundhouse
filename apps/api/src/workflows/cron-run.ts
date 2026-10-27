/**
 * One cron run as a Cloudflare Workflow (ADR 0010, "Runner"); the instance
 * ID is the `crn_…` run ID, so starting one twice is a no-op.
 *
 * Steps:
 * 1. `load`: read the run and the config of its deployment. A retry first
 *    sleeps `retry_backoff_s × 2^(attempt − 2)` from when it was queued.
 * 2. `concurrency`: with other runs of the service and environment in
 *    progress, `forbid` records this one `skipped`; `replace` (or run now
 *    with `force`) sends them `job_cancel` and waits up to 30 s for them to
 *    end; `allow` (and plain run now) carries on.
 * 3. `place`: pick a node with `schedule()` at `JOBS_PROTOCOL_VERSION`,
 *    counting running jobs as allocated and keeping the run where its
 *    environment can reach it (the mesh span rule), and mark the run
 *    `starting` with a fresh `wl_…` workload ID and, on a meshed node, a
 *    mesh IP (ADR 0005). No node is a failure (`unschedulable: …`).
 * 4. `send`: open the deployment's sealed environment, seal it to the node
 *    as a `job-env` box bound to the run and workload, push the run's mesh
 *    address to the workspace's meshed nodes, and send a signed `job_run`
 *    (60 s credential TTL, `mesh_ip` and `private_dns` on a meshed node)
 *    through the node's Durable Object.
 * 5. Wait for the `job` event the Durable Object sends on a terminal
 *    `job_status`, until `timeout_s + 300 s`; without one the run is `lost`.
 * 6. `retry`: after `failed`, `timed_out` or `lost` with attempts left,
 *    queue attempt + 1 (`trigger: retry`, same slot) and start its workflow.
 * 7. `trim`: delete runs beyond `history_limit`, oldest first, with their logs.
 *
 * A `pre_deploy` run (a deployment's `pre_deploy_command`, for any service
 * kind) goes through the same steps with the deployment it belongs to
 * instead of the armed one: concurrency `allow`, no retries, the service's
 * `cron.timeout_s` or `PRE_DEPLOY_TIMEOUT_S`, and a `wake-deploy` step that
 * tells the waiting deploy workflow it ended.
 *
 * SECURITY: step results are persisted by the platform, so no step returns
 * an environment value or a sealed box; the step that seals also sends.
 *
 * @module
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  createDb,
  cronRuns,
  type Db,
  deployments,
  nodes,
  projects,
  services,
} from "@roundhouse/db";
import {
  computeSpecHash,
  environmentNetworkName,
  JOBS_PROTOCOL_VERSION,
  jobEnvAad,
  REGISTRY_LISTEN,
  type SealedWorkloadEnv,
  sealBox,
  type WorkloadSpec,
} from "@roundhouse/protocol";
import {
  type CronRunStatus,
  DEFAULT_CRON_CONFIG,
  DEFAULT_PIDS_LIMIT,
  isTerminalCronRunStatus,
  newId,
  PLACED_CRON_RUN_STATUSES,
  RETRYABLE_CRON_RUN_STATUSES,
  retryDelayS,
  schedule,
} from "@roundhouse/shared";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Env } from "../env";
import {
  CRON_EVENT,
  type CronRunParams,
  cancelRun,
  cronRunId,
  deploymentWithConfig,
  finishCronRun,
  KILL_GRACE_S,
  LOST_GRACE_S,
  PRE_DEPLOY_TIMEOUT_S,
  publishCronRunsById,
  REPLACE_WAIT_S,
  startCronRunWorkflow,
  trimCronHistory,
} from "../lib/cron/runs";
import type { Sealed } from "../lib/crypto";
import { disposeRpc, wakeWorkflow } from "../lib/deployments";
import { openDeploymentEnv, refreshNodes } from "../lib/desired-state";
import { assignRunMeshIp, isMeshed } from "../lib/mesh";
import { builderOfDeployment, environmentNodeIds, schedulerSnapshot } from "../lib/scheduling";
import { getMeshSettings } from "../lib/settings";
import { projectKey } from "../lib/variables";

/** How a cron run workflow ended. */
export interface CronRunOutput {
  status: CronRunStatus;
}

const DB_STEP = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

const NETWORK_STEP = {
  retries: { limit: 4, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

/** Wake-ups one wait tolerates; a run reports a handful of statuses. */
const MAX_WAKEUPS = 20;

/** Polls while `replace` waits for the runs it cancelled. */
const REPLACE_POLLS = 6;

/** Everything later steps need, captured once. Serialisable and secret-free. */
interface Plan {
  runId: string;
  projectId: string;
  workspaceId: string;
  serviceId: string;
  environmentId: string;
  deploymentId: string;
  trigger: string;
  attempt: number;
  scheduledFor: number;
  triggeredBy: string | null;
  image: string;
  registryNodeId: string | null;
  command: string | null;
  cpuMillis: number;
  memoryMb: number;
  nodeSelector: Record<string, string>;
  concurrency: "forbid" | "replace" | "allow";
  timeoutS: number;
  retries: number;
  historyLimit: number;
  /** Milliseconds to sleep before the attempt (retries only). */
  backoffMs: number;
}

type Verdict<T = object> = ({ kind: "ok" } & T) | { kind: "done"; status: CronRunStatus };

/** Runs one cron run. */
export class CronRunWorkflow extends WorkflowEntrypoint<Env, CronRunParams> {
  override async run(
    event: Readonly<WorkflowEvent<CronRunParams>>,
    step: WorkflowStep,
  ): Promise<CronRunOutput> {
    const { runId, replace = false } = event.payload;
    const loaded = await step.do("load", DB_STEP, () => this.load(runId));
    if (loaded.kind !== "ok") {
      await step.do("wake-deploy", DB_STEP, () => this.wakeDeploy(runId));
      return { status: loaded.status };
    }
    const plan = loaded.plan;
    if (plan.backoffMs > 0) await step.sleep("backoff", plan.backoffMs);

    let status: CronRunStatus;
    try {
      status = await this.pipeline(step, plan, replace);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      status = await step.do("fail", DB_STEP, async () => {
        const row = await finishCronRun(this.db(), runId, "failed", ["queued", "starting"], {
          error: reason.slice(0, 1000),
        });
        await publishCronRunsById(this.env, this.db(), [runId]);
        return row?.status ?? (await this.statusOf(runId));
      });
    }
    if ((RETRYABLE_CRON_RUN_STATUSES as readonly string[]).includes(status)) {
      if (plan.attempt <= plan.retries) {
        await step.do("retry", DB_STEP, () => this.retry(plan));
      }
    }
    if (plan.trigger === "pre_deploy") {
      await step.do("wake-deploy", DB_STEP, () => this.wakeDeploy(runId));
    }
    await step.do("trim", NETWORK_STEP, () =>
      trimCronHistory(
        this.db(),
        this.env.LOGS,
        plan.serviceId,
        plan.environmentId,
        plan.historyLimit,
      ),
    );
    return { status };
  }

  private db(): Db {
    return createDb(this.env.DB);
  }

  /** Tells the deploy workflow waiting on a `pre_deploy` run that the run ended. */
  private async wakeDeploy(runId: string): Promise<void> {
    const [row] = await this.db()
      .select({ trigger: cronRuns.trigger, workflowInstanceId: deployments.workflowInstanceId })
      .from(cronRuns)
      .innerJoin(deployments, eq(deployments.id, cronRuns.deploymentId))
      .where(eq(cronRuns.id, runId))
      .limit(1);
    if (row?.trigger !== "pre_deploy") return;
    await wakeWorkflow(this.env, row, "pre_deploy", { run_id: runId });
  }

  private async pipeline(step: WorkflowStep, plan: Plan, replace: boolean): Promise<CronRunStatus> {
    const gate = await step.do("concurrency", DB_STEP, () => this.concurrency(plan, replace));
    if (gate.kind === "done") return gate.status;
    if (gate.cancelled.length) {
      for (let i = 0; i < REPLACE_POLLS; i++) {
        const left = await step.do(`replaced-${i}`, DB_STEP, () =>
          this.stillRunning(gate.cancelled),
        );
        if (!left) break;
        await step.sleep(`replace-wait-${i}`, (REPLACE_WAIT_S * 1000) / REPLACE_POLLS);
      }
    }

    const placed = await step.do("place", DB_STEP, () => this.place(plan));
    if (placed.kind === "done") return placed.status;

    const sent = await step.do("send", NETWORK_STEP, () =>
      this.send(plan, placed.nodeId, placed.workloadId),
    );
    if (sent.kind === "done") return sent.status;

    const deadline = await step.do(
      "deadline",
      async () => Date.now() + (plan.timeoutS + LOST_GRACE_S) * 1000,
    );
    for (let i = 0; i < MAX_WAKEUPS; i++) {
      const status = await step.do(`check-${i}`, DB_STEP, () => this.statusOf(plan.runId));
      if (isTerminalCronRunStatus(status)) return status;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        await step.waitForEvent(`${CRON_EVENT}-${i}`, { type: CRON_EVENT, timeout: remaining });
      } catch {
        break;
      }
    }
    return step.do("lost", DB_STEP, async () => {
      const row = await finishCronRun(
        this.db(),
        plan.runId,
        "lost",
        [...PLACED_CRON_RUN_STATUSES],
        {
          error: `no result from the node within ${plan.timeoutS + LOST_GRACE_S} seconds`,
        },
      );
      await publishCronRunsById(this.env, this.db(), [plan.runId]);
      return row?.status ?? (await this.statusOf(plan.runId));
    });
  }

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  private async statusOf(runId: string): Promise<CronRunStatus> {
    const [row] = await this.db()
      .select({ status: cronRuns.status })
      .from(cronRuns)
      .where(eq(cronRuns.id, runId))
      .limit(1);
    return row?.status ?? "cancelled";
  }

  private async load(
    runId: string,
  ): Promise<{ kind: "ok"; plan: Plan } | { kind: "done"; status: CronRunStatus }> {
    const db = this.db();
    const [row] = await db
      .select({ run: cronRuns, service: services, project: projects })
      .from(cronRuns)
      .innerJoin(services, eq(services.id, cronRuns.serviceId))
      .innerJoin(projects, eq(projects.id, services.projectId))
      .where(eq(cronRuns.id, runId))
      .limit(1);
    if (!row) return { kind: "done", status: "cancelled" };
    const { run, service, project } = row;
    if (run.status !== "queued") return { kind: "done", status: run.status };
    const fail = async (error: string) => {
      const done = await finishCronRun(db, runId, "failed", ["queued"], { error });
      await publishCronRunsById(this.env, db, [runId]);
      return { kind: "done" as const, status: done?.status ?? "failed" };
    };
    if (service.deletedAt || project.deletedAt) return fail("the service was deleted");
    if (!run.deploymentId) return fail("the deployment the run belongs to was removed");
    const preDeploy = run.trigger === "pre_deploy";
    const found = await deploymentWithConfig(db, run.deploymentId);
    if (!found?.deployment.image) return fail("the deployment has no image");
    const { deployment, spec } = found;
    // A pre-deploy run takes the cron settings it has (a cron service's) or the defaults.
    const cron = found.cron ?? (preDeploy ? { schedule: "", ...DEFAULT_CRON_CONFIG } : null);
    if (!cron) return fail("the deployment's config has no cron part");
    const command = preDeploy ? spec.deploy.pre_deploy_command : spec.deploy.start_command;
    if (preDeploy && !command) return fail("the deployment's config has no pre-deploy command");
    const delayMs = retryDelayS(cron, run.attempt) * 1000;
    return {
      kind: "ok",
      plan: {
        runId,
        projectId: project.id,
        workspaceId: project.workspaceId,
        serviceId: service.id,
        environmentId: run.environmentId,
        deploymentId: deployment.id,
        trigger: run.trigger,
        attempt: run.attempt,
        scheduledFor: +run.scheduledFor,
        triggeredBy: run.triggeredBy,
        image: deployment.image!,
        registryNodeId: deployment.image!.startsWith(`${REGISTRY_LISTEN}/`)
          ? await builderOfDeployment(db, deployment.id)
          : null,
        command: command ?? null,
        cpuMillis: spec.resources.cpu_millis,
        memoryMb: spec.resources.memory_mb,
        nodeSelector: spec.placement.node_selector,
        // A pre-deploy run is never held back by, nor replaces, the service's own runs.
        concurrency: preDeploy ? "allow" : cron.concurrency,
        timeoutS: preDeploy ? (found.cron?.timeout_s ?? PRE_DEPLOY_TIMEOUT_S) : cron.timeout_s,
        retries: preDeploy ? 0 : cron.retries,
        historyLimit: cron.history_limit,
        backoffMs: Math.max(0, +run.createdAt + delayMs - Date.now()),
      },
    };
  }

  private async concurrency(
    plan: Plan,
    replace: boolean,
  ): Promise<{ kind: "ok"; cancelled: string[] } | { kind: "done"; status: CronRunStatus }> {
    const db = this.db();
    const busy = await db
      .select({ id: cronRuns.id, nodeId: cronRuns.nodeId })
      .from(cronRuns)
      .where(
        and(
          eq(cronRuns.serviceId, plan.serviceId),
          eq(cronRuns.environmentId, plan.environmentId),
          inArray(cronRuns.status, [...PLACED_CRON_RUN_STATUSES]),
          ne(cronRuns.id, plan.runId),
        ),
      );
    if (!busy.length) return { kind: "ok", cancelled: [] };
    // Run now ignores `forbid` (ADR 0010); with `force` it replaces.
    const policy = replace ? "replace" : plan.trigger === "manual" ? "allow" : plan.concurrency;
    if (policy === "allow") return { kind: "ok", cancelled: [] };
    if (policy === "forbid") {
      const row = await finishCronRun(db, plan.runId, "skipped", ["queued"], {
        error: `previous run ${busy[0]!.id} still running`,
      });
      await publishCronRunsById(this.env, db, [plan.runId]);
      return { kind: "done", status: row?.status ?? (await this.statusOf(plan.runId)) };
    }
    for (const other of busy) {
      await cancelRun(this.env, db, other, `replaced by ${plan.runId}`);
    }
    return { kind: "ok", cancelled: busy.map((b) => b.id) };
  }

  private async stillRunning(runIds: string[]): Promise<boolean> {
    const rows = await this.db()
      .select({ id: cronRuns.id })
      .from(cronRuns)
      .where(
        and(inArray(cronRuns.id, runIds), inArray(cronRuns.status, [...PLACED_CRON_RUN_STATUSES])),
      );
    return rows.length > 0;
  }

  private async place(
    plan: Plan,
  ): Promise<
    { kind: "ok"; nodeId: string; workloadId: string } | { kind: "done"; status: CronRunStatus }
  > {
    const db = this.db();
    const [current] = await db.select().from(cronRuns).where(eq(cronRuns.id, plan.runId)).limit(1);
    if (!current) return { kind: "done", status: "cancelled" };
    // A replayed step finds its own earlier placement.
    if (current.status === "starting" && current.nodeId && current.workloadId) {
      return { kind: "ok", nodeId: current.nodeId, workloadId: current.workloadId };
    }
    if (current.status !== "queued") return { kind: "done", status: current.status };
    const { nodes: candidates } = await schedulerSnapshot(db, {
      workspaceId: plan.workspaceId,
      registryNodeId: plan.registryNodeId,
    });
    const result = schedule(
      {
        serviceId: plan.serviceId,
        replicas: 1,
        cpuMillis: plan.cpuMillis,
        memoryMb: plan.memoryMb,
        nodeSelector: plan.nodeSelector,
        requiresRegistry: plan.registryNodeId !== null,
        minProtocolVersion: JOBS_PROTOCOL_VERSION,
        // A run reaches its environment's services like a replica does, so
        // it spans servers only over a ready mesh (ADR 0005).
        environmentNodeIds: await environmentNodeIds(db, plan.environmentId, plan.serviceId),
      },
      candidates,
    );
    if (!result.ok) {
      const row = await finishCronRun(db, plan.runId, "failed", ["queued"], {
        error: `unschedulable: ${result.reason}`,
      });
      await publishCronRunsById(this.env, db, [plan.runId]);
      return { kind: "done", status: row?.status ?? (await this.statusOf(plan.runId)) };
    }
    const nodeId = result.placements[0]!.nodeId;
    const workloadId = newId("workload");
    const [claimed] = await db
      .update(cronRuns)
      .set({ status: "starting", nodeId, workloadId, updatedAt: new Date() })
      .where(and(eq(cronRuns.id, plan.runId), eq(cronRuns.status, "queued")))
      .returning();
    if (!claimed) return { kind: "done", status: await this.statusOf(plan.runId) };
    await this.assignMeshIp(db, plan.runId, nodeId);
    await publishCronRunsById(this.env, db, [plan.runId]);
    return { kind: "ok", nodeId, workloadId };
  }

  /**
   * On a meshed node, gives the run a mesh IP from the node's /24 (ADR
   * 0005), so it reaches its environment's replicas on other nodes and they
   * admit it. Best effort: without one the job still runs, reaching only
   * replicas on its own node.
   */
  private async assignMeshIp(db: Db, runId: string, nodeId: string): Promise<void> {
    const mesh = await getMeshSettings(db);
    if (!mesh.enabled) return;
    const [node] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!node || !isMeshed(node, mesh)) return;
    await assignRunMeshIp(db, { id: node.id, meshIndex: node.meshIndex! }, mesh.supernet, runId);
  }

  private async send(plan: Plan, nodeId: string, workloadId: string): Promise<Verdict> {
    const db = this.db();
    const status = await this.statusOf(plan.runId);
    if (status !== "starting") return { kind: "done", status };
    const [node] = await db
      .select({ key: nodes.encryptionPublicKey })
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), isNull(nodes.deletedAt)))
      .limit(1);
    const [placed] = await db
      .select({ meshIp: cronRuns.meshIp })
      .from(cronRuns)
      .where(eq(cronRuns.id, plan.runId))
      .limit(1);
    const meshIp = placed?.meshIp ?? null;
    const [deployment] = await db
      .select({ envSealed: deployments.envSealed })
      .from(deployments)
      .where(eq(deployments.id, plan.deploymentId))
      .limit(1);
    const failRun = async (error: string): Promise<Verdict> => {
      const row = await finishCronRun(db, plan.runId, "failed", ["starting"], { error });
      await publishCronRunsById(this.env, db, [plan.runId]);
      return { kind: "done", status: row?.status ?? (await this.statusOf(plan.runId)) };
    };
    if (!node?.key) return failRun("unschedulable: the node has no encryption key");
    if (!deployment?.envSealed) return failRun("the deployment has no resolved environment");
    if (!this.env.MASTER_KEY?.trim()) throw new Error("MASTER_KEY is not configured");
    const key = await projectKey(db, this.env, plan.projectId);
    const payload: SealedWorkloadEnv = await openDeploymentEnv(
      key,
      deployment.envSealed as Sealed,
      { workspaceId: plan.workspaceId, projectId: plan.projectId, deploymentId: plan.deploymentId },
    );
    const spec: Omit<WorkloadSpec, "spec_hash"> = {
      id: workloadId,
      kind: "job",
      project_id: plan.projectId,
      environment_id: plan.environmentId,
      service_id: plan.serviceId,
      deployment_id: plan.deploymentId,
      replica: 0,
      image: plan.image,
      registry_auth: null,
      ...(plan.command ? { command: ["/bin/sh", "-c", plan.command] } : {}),
      env_sealed: await sealBox(
        node.key,
        JSON.stringify(payload),
        "job-env",
        jobEnvAad(nodeId, plan.runId, workloadId),
      ),
      ports: [],
      routes: [],
      healthcheck: null,
      resources: { cpu_millis: plan.cpuMillis, memory_mb: plan.memoryMb, pids: DEFAULT_PIDS_LIMIT },
      restart: { policy: "never", max_retries: 0 },
      // SECURITY: the environment's own network, as its replicas get, so a
      // job reaches exactly what its service can.
      network: await environmentNetworkName(plan.projectId, plan.environmentId),
      labels: {},
      drain_s: 0,
      ...(meshIp ? { mesh_ip: meshIp, private_dns: true } : {}),
    };
    if (meshIp) {
      // Every meshed node of the workspace lists the run's address before
      // the job starts, so its first connection is admitted.
      await refreshNodes(this.env, db, [nodeId]);
    }
    const stub = this.env.NODE_CONNECTION.get(this.env.NODE_CONNECTION.idFromName(nodeId));
    const result = await stub.sendJobRun({
      run_id: plan.runId,
      workload: { ...spec, spec_hash: await computeSpecHash(spec) },
      timeout_s: plan.timeoutS,
      kill_grace_s: KILL_GRACE_S,
    });
    const sent = result.sent;
    const reason = result.sent ? null : result.reason;
    disposeRpc(result);
    if (sent) return { kind: "ok" };
    return failRun(
      reason === "not_connected"
        ? "node_offline: the node the run was placed on is not connected"
        : "unschedulable: agent_outdated",
    );
  }

  private async retry(plan: Plan): Promise<string> {
    const db = this.db();
    const attempt = plan.attempt + 1;
    const id = await cronRunId({
      serviceId: plan.serviceId,
      environmentId: plan.environmentId,
      scheduledFor: plan.scheduledFor,
      attempt,
      kind: "run",
    });
    await db
      .insert(cronRuns)
      .values({
        id,
        serviceId: plan.serviceId,
        environmentId: plan.environmentId,
        deploymentId: plan.deploymentId,
        trigger: "retry",
        scheduledFor: new Date(plan.scheduledFor),
        attempt,
        status: "queued",
        triggeredBy: plan.triggeredBy,
        workflowInstanceId: id,
      })
      .onConflictDoNothing();
    await publishCronRunsById(this.env, db, [id]);
    await startCronRunWorkflow(this.env, { runId: id });
    return id;
  }
}
