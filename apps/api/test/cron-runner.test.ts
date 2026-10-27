/**
 * Cron runs end to end (ADR 0010, "Runner") against a simulated protocol 6
 * agent: a cron deploy arms the schedule without running it; run now sends
 * a signed `job_run` whose environment opens only as the run's `job-env`
 * box; terminal `job_status` ends the run with its exit code; logs are filed
 * under the run and redacted; every concurrency policy; retries; `lost`
 * after the deadline; history trimming; reports from the wrong node; and
 * `pre_deploy_command` gating a rollout. No secret value reaches a run, an
 * audit entry or the frame's plaintext.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { createDb, cronRuns } from "@roundhouse/db";
import {
  type ControlMessage,
  type JobRun,
  jobEnvAad,
  openBox,
  PROTOCOL_VERSION,
  SealedWorkloadEnvSchema,
  verifyEnvelope,
} from "@roundhouse/protocol";
import { newId } from "@roundhouse/shared";
import { eq, isNotNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCronRunWorkflow } from "../src/lib/cron/runs";
import { allAuditText, auditRows } from "./backups-helpers";
import {
  addMember,
  type Client,
  eventually,
  hello,
  install,
  joinNode,
  NODE_ENCRYPTION_PRIVATE_KEY,
} from "./helpers";
import {
  connectWorkloadAgent,
  createProject,
  createService,
  deploy,
  type FakeWorkloadAgent,
  settleDeployments,
  waitForStatus,
} from "./pipeline-helpers";

const SECRET = "sk-live-cron-0123456789";

let introspectors: { dispose(): Promise<void> }[] = [];
let runIntrospector: Awaited<ReturnType<typeof introspectWorkflow>>;

beforeEach(async () => {
  const runs = await introspectWorkflow(env.CRON_RUN_WORKFLOW);
  runIntrospector = runs;
  await runs.modifyAll(async (m) => {
    await m.disableSleeps();
  });
  introspectors = [await introspectWorkflow(env.DEPLOY_WORKFLOW), runs];
});

afterEach(async () => {
  await settleRuns();
  await settleDeployments();
  for (const i of introspectors) await i.dispose();
});

/** What the fake agent does with a `job_run`. */
type JobScript =
  | { kind: "exit"; code: number; logs?: string[] }
  /** Reports `running`, then waits for a `job_cancel`. */
  | { kind: "hang" }
  /** Never answers. */
  | { kind: "silent" };

interface JobAgent {
  agent: FakeWorkloadAgent;
  nodeId: string;
  /** Every verified `job_run`, with its opened environment and raw frame. */
  jobs: { frame: JobRun; raw: string; env: Record<string, string> }[];
  /** `job_cancel`s, by run. */
  cancels: string[];
  script: (run: JobRun) => JobScript;
  send(frame: unknown): void;
}

/**
 * Wraps a protocol 6 workload agent so it also plays jobs: it verifies each
 * `job_run`, opens its environment under the run's `job-env` AAD (a box that
 * fails to open is a rejection), and answers per `script`.
 */
async function connectJobAgent(
  owner: Client,
  workspaceId: string,
  script: JobAgent["script"],
): Promise<JobAgent> {
  const joined = await joinNode(owner, workspaceId);
  const agent = await connectWorkloadAgent(
    joined,
    { health: "healthy" },
    { protocol_version: PROTOCOL_VERSION },
  );
  const job: JobAgent = {
    agent,
    nodeId: joined.node_id,
    jobs: [],
    cancels: [],
    script,
    send: (frame) => agent.ws.send(JSON.stringify(frame)),
  };
  const workloadOf = new Map<string, string>();
  const status = (run: string, state: string, extra: Record<string, unknown> = {}) =>
    job.send({
      type: "job_status",
      run_id: run,
      workload_id: workloadOf.get(run)!,
      state,
      ...extra,
    });
  agent.ws.addEventListener("message", (e) => {
    void (async () => {
      const raw = e.data as string;
      const verified = await verifyEnvelope(
        JSON.parse(raw),
        joined.control_public_key,
        joined.node_id,
      );
      if (!verified.ok) return;
      const m = verified.message as ControlMessage;
      if (m.type === "job_cancel") {
        job.cancels.push(m.run_id);
        if (workloadOf.has(m.run_id)) {
          status(m.run_id, "cancelled", { finished_at: Date.now(), exit_code: 143 });
        }
        return;
      }
      if (m.type !== "job_run") return;
      let opened: Record<string, string>;
      try {
        const pt = await openBox(
          NODE_ENCRYPTION_PRIVATE_KEY,
          m.workload.env_sealed!,
          "job-env",
          jobEnvAad(joined.node_id, m.run_id, m.workload.id),
        );
        opened = SealedWorkloadEnvSchema.parse(JSON.parse(new TextDecoder().decode(pt))).env;
      } catch {
        agent.rejected.push(`job-env:${m.run_id}`);
        return;
      }
      job.jobs.push({ frame: m, raw, env: opened });
      workloadOf.set(m.run_id, m.workload.id);
      const plan = job.script(m);
      if (plan.kind === "silent") return;
      const startedAt = Date.now();
      status(m.run_id, "pulling");
      status(m.run_id, "running", { started_at: startedAt });
      if (plan.kind === "hang") return;
      if (plan.logs?.length) {
        job.send({
          type: "logs",
          source: { type: "job", run_id: m.run_id, workload_id: m.workload.id },
          lines: plan.logs.map((text) => ({ ts: Date.now(), stream: "stdout", text })),
        });
      }
      status(m.run_id, plan.code === 0 ? "succeeded" : "failed", {
        exit_code: plan.code,
        started_at: startedAt,
        finished_at: Date.now(),
      });
    })();
  });
  return job;
}

interface RunBody {
  id: string;
  status: string;
  trigger: string;
  attempt: number;
  exit_code: number | null;
  error: string | null;
  node_id: string | null;
  scheduled_for: number;
  started_at: number | null;
}

interface CronStage {
  owner: Client;
  workspaceId: string;
  projectId: string;
  envId: string;
  serviceId: string;
  deploymentId: string;
  job: JobAgent;
}

/**
 * A deployed (armed) cron service with a secret variable, on a connected
 * protocol 6 node that answers jobs with `script`.
 */
async function armedCronStage(
  script: JobAgent["script"],
  cron: Record<string, unknown> = {},
): Promise<CronStage> {
  const { owner, workspaceId } = await install();
  const job = await connectJobAgent(owner, workspaceId, script);
  const project = await createProject(owner, workspaceId);
  const envId = project.environments[0]!.id;
  const created = await createService(owner, project.id, {
    name: "report",
    kind: "cron",
    source: { type: "image", image: "busybox:1.37" },
    config: { cron: { schedule: "0 3 * * *", ...cron }, deploy: { start_command: "echo hi" } },
  });
  const serviceId = created.service.id;
  const put = await owner.json(`/v1/services/${serviceId}/variables?environment_id=${envId}`, {
    method: "PUT",
    json: {
      set: [
        { key: "API_KEY", value: SECRET, tier: "secret" },
        { key: "GREETING", value: "hello", tier: "plain" },
      ],
      confirm_write_only: true,
    },
  });
  expect(put.status).toBe(200);
  const d = await deploy(owner, serviceId, envId);
  const active = await waitForStatus(owner, d.id, ["active", "failed"]);
  expect(active.failure_reason).toBeNull();
  expect(active.status).toBe("active");
  return { owner, workspaceId, projectId: project.id, envId, serviceId, deploymentId: d.id, job };
}

const runNow = (s: CronStage, force = false) =>
  s.owner.json<RunBody & { error: { code: string } }>(`/v1/services/${s.serviceId}/cron-runs`, {
    method: "POST",
    json: { environment_id: s.envId, ...(force ? { force: true } : {}) },
  });

async function waitRun(c: Client, runId: string, statuses: string[], timeoutMs = 15_000) {
  return eventually(async () => {
    const res = await c.json<RunBody>(`/v1/cron-runs/${runId}`);
    return statuses.includes(res.body.status) ? res.body : undefined;
  }, timeoutMs);
}

async function runsOf(serviceId: string) {
  return createDb(env.DB)
    .select()
    .from(cronRuns)
    .where(eq(cronRuns.serviceId, serviceId))
    .orderBy(cronRuns.id);
}

/** Inserts a queued scheduled run of the armed deployment and starts its workflow. */
async function scheduledRun(s: CronStage, id = newId("cronRun")): Promise<string> {
  await createDb(env.DB).insert(cronRuns).values({
    id,
    serviceId: s.serviceId,
    environmentId: s.envId,
    deploymentId: s.deploymentId,
    trigger: "schedule",
    scheduledFor: new Date(),
    status: "queued",
    workflowInstanceId: id,
  });
  await startCronRunWorkflow(env, { runId: id });
  return id;
}

const INSTANCE_DONE = new Set(["complete", "errored", "terminated"]);

/**
 * Ends every run still in progress and waits for each run workflow to finish,
 * so no instance outlives its test (see `settleDeployments`).
 */
async function settleRuns(): Promise<void> {
  const db = createDb(env.DB);
  await env.DB.prepare(
    "UPDATE cron_runs SET status = 'cancelled', finished_at = ?1 WHERE status IN ('queued', 'starting', 'running')",
  )
    .bind(Date.now())
    .run();
  const all = await db
    .select({ id: cronRuns.id })
    .from(cronRuns)
    .where(isNotNull(cronRuns.workflowInstanceId));
  for (const { id } of all) {
    try {
      const instance = await env.CRON_RUN_WORKFLOW.get(id);
      await instance.sendEvent({ type: "job", payload: {} }).catch(() => {});
    } catch {
      // No instance.
    }
  }
  await Promise.all(
    all.map(({ id }) =>
      eventually(async () => {
        try {
          const instance = await env.CRON_RUN_WORKFLOW.get(id);
          return INSTANCE_DONE.has((await instance.status()).status) ? true : undefined;
        } catch {
          return true;
        }
      }, 15_000),
    ),
  );
}

describe("cron deploy", () => {
  it("arms the schedule without placing replicas or running anything", async () => {
    const s = await armedCronStage(() => ({ kind: "exit", code: 0 }));
    const state = await s.owner.json<{
      armed_deployment_id: string;
      next_run_at: number;
      schedule: string;
    }>(`/v1/services/${s.serviceId}/cron?environment_id=${s.envId}`);
    expect(state.body).toMatchObject({
      armed_deployment_id: s.deploymentId,
      schedule: "0 3 * * *",
    });
    expect(state.body.next_run_at).toBeGreaterThan(Date.now());
    expect(await runsOf(s.serviceId)).toHaveLength(0);
    expect(s.job.jobs).toHaveLength(0);
    const workloads = s.job.agent.desired()?.workloads ?? [];
    expect(workloads.filter((w) => w.service_id === s.serviceId)).toEqual([]);
  });
});

describe("cron runner", () => {
  it("runs a job with its sealed environment, files its redacted logs, and leaks no secret", async () => {
    const s = await armedCronStage(() => ({
      kind: "exit",
      code: 0,
      logs: ["hello", `token=${SECRET}`],
    }));
    const queued = await runNow(s);
    expect(queued.status).toBe(201);
    expect(queued.body).toMatchObject({ trigger: "manual", status: "queued", attempt: 1 });
    const run = await waitRun(s.owner, queued.body.id, ["succeeded", "failed"]);
    expect(run).toMatchObject({ status: "succeeded", exit_code: 0, node_id: s.job.nodeId });
    expect(run.started_at).not.toBeNull();

    expect(s.job.agent.rejected).toEqual([]);
    const [sent] = s.job.jobs;
    expect(sent!.frame.run_id).toBe(run.id);
    expect(sent!.frame.workload).toMatchObject({
      kind: "job",
      service_id: s.serviceId,
      deployment_id: s.deploymentId,
      image: "busybox:1.37",
      command: ["/bin/sh", "-c", "echo hi"],
      ports: [],
      routes: [],
      healthcheck: null,
      restart: { policy: "never", max_retries: 0 },
    });
    expect(sent!.frame.timeout_s).toBe(3600);
    // A credential frame: short-lived.
    expect(sent!.frame.exp - sent!.frame.iat).toBeLessThanOrEqual(60_000);
    expect(sent!.env).toMatchObject({ API_KEY: SECRET, GREETING: "hello" });
    expect(sent!.raw).not.toContain(SECRET);

    const logs = await eventually(async () => {
      const page = await s.owner.json<{ lines: { text: string }[] }>(
        `/v1/cron-runs/${run.id}/logs`,
      );
      return page.body.lines.length === 2 ? page.body.lines : undefined;
    }, 10_000);
    expect(logs[0]!.text).toBe("hello");
    expect(logs[1]!.text).not.toContain(SECRET);

    const listed = await s.owner.json(
      `/v1/services/${s.serviceId}/cron-runs?environment_id=${s.envId}`,
    );
    expect(JSON.stringify(listed.body)).not.toContain(SECRET);
    expect(await auditRows("cron.run_triggered")).toHaveLength(1);
    expect(await allAuditText()).not.toContain(SECRET);
  });

  it("records the exit code of a failed run and retries it with backoff", async () => {
    const s = await armedCronStage(() => ({ kind: "exit", code: 3 }), { retries: 1 });
    const queued = await runNow(s);
    await waitRun(s.owner, queued.body.id, ["failed"]);
    const retried = await eventually(async () => {
      const runs = await runsOf(s.serviceId);
      const retry = runs.find((r) => r.attempt === 2);
      return retry && retry.status === "failed" ? runs : undefined;
    });
    expect(retried).toHaveLength(2);
    const [first, second] = [...retried].sort((a, b) => a.attempt - b.attempt);
    expect(first).toMatchObject({ status: "failed", exitCode: 3, error: "exited with 3" });
    expect(second).toMatchObject({ trigger: "retry", status: "failed", exitCode: 3 });
    expect(+second!.scheduledFor).toBe(+first!.scheduledFor);
    // retries: 1 means one extra attempt, never a third.
    await settleRuns();
    expect(await runsOf(s.serviceId)).toHaveLength(2);
  });

  it("skips a slot under forbid while a run is in progress", async () => {
    const s = await armedCronStage(() => ({ kind: "hang" }));
    const first = await runNow(s);
    await waitRun(s.owner, first.body.id, ["running"]);
    const second = await scheduledRun(s);
    const skipped = await waitRun(s.owner, second, ["skipped"]);
    expect(skipped.error).toBe(`previous run ${first.body.id} still running`);
    expect(s.job.cancels).toEqual([]);
  });

  it("cancels the running run under replace, then starts the new one", async () => {
    const s = await armedCronStage(() => ({ kind: "hang" }), { concurrency: "replace" });
    const first = await runNow(s);
    await waitRun(s.owner, first.body.id, ["running"]);
    const second = await scheduledRun(s);
    await waitRun(s.owner, first.body.id, ["cancelled"]);
    await waitRun(s.owner, second, ["running"]);
    expect(s.job.cancels).toEqual([first.body.id]);
  });

  it("runs both under allow", async () => {
    const s = await armedCronStage(() => ({ kind: "hang" }), { concurrency: "allow" });
    const first = await runNow(s);
    await waitRun(s.owner, first.body.id, ["running"]);
    const second = await scheduledRun(s);
    await waitRun(s.owner, second, ["running"]);
    expect((await waitRun(s.owner, first.body.id, ["running"])).status).toBe("running");
  });

  it("answers run now with 409 while a run is in progress, and replaces it with force", async () => {
    const s = await armedCronStage(() => ({ kind: "hang" }));
    const first = await runNow(s);
    await waitRun(s.owner, first.body.id, ["running"]);
    const refused = await runNow(s);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("run_in_progress");
    const forced = await runNow(s, true);
    expect(forced.status).toBe(201);
    await waitRun(s.owner, first.body.id, ["cancelled"]);
    await waitRun(s.owner, forced.body.id, ["running"]);

    const cancelled = await s.owner.json<RunBody>(`/v1/cron-runs/${forced.body.id}/cancel`, {
      method: "POST",
    });
    expect(cancelled.status).toBe(200);
    await waitRun(s.owner, forced.body.id, ["cancelled"]);
    expect(s.job.cancels).toEqual([first.body.id, forced.body.id]);
    const audit = await auditRows("cron.run_cancelled");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.target_id).toBe(forced.body.id);
  });

  it("marks a run lost when its node never reports", async () => {
    const s = await armedCronStage(() => ({ kind: "silent" }));
    // The wait's deadline is timeout_s + 300 s; time it out at once instead.
    await runIntrospector.modifyAll(async (m) => {
      await m.disableSleeps();
      await m.forceEventTimeout({ name: "job-0" });
    });
    const id = await scheduledRun(s);
    const lost = await waitRun(s.owner, id, ["lost"]);
    expect(lost.error).toBe("no result from the node within 3900 seconds");
    expect(s.job.jobs).toHaveLength(1);
  });

  it("fails a run no node can take, naming the reason", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    // A protocol 5 agent runs services but not jobs.
    await connectWorkloadAgent(joined, { health: "healthy" }, { protocol_version: 5 });
    const project = await createProject(owner, workspaceId);
    const envId = project.environments[0]!.id;
    const created = await createService(owner, project.id, {
      name: "nightly",
      kind: "cron",
      source: { type: "image", image: "busybox:1.37" },
      config: { cron: { schedule: "@daily" } },
    });
    const d = await deploy(owner, created.service.id, envId);
    await waitForStatus(owner, d.id, ["active"]);
    const run = await owner.json<RunBody>(`/v1/services/${created.service.id}/cron-runs`, {
      method: "POST",
      json: { environment_id: envId },
    });
    const failed = await waitRun(owner, run.body.id, ["failed"]);
    expect(failed.error).toBe("unschedulable: agent_outdated");
  });

  it("trims history beyond history_limit, oldest first", async () => {
    const s = await armedCronStage(() => ({ kind: "exit", code: 0 }), { history_limit: 10 });
    const db = createDb(env.DB);
    const old = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 12; i++) {
      await db.insert(cronRuns).values({
        id: `crn_00${String(i).padStart(2, "0")}${"0".repeat(20)}`,
        serviceId: s.serviceId,
        environmentId: s.envId,
        deploymentId: s.deploymentId,
        trigger: "schedule",
        scheduledFor: new Date(old + i * 60_000),
        status: "succeeded",
      });
    }
    const run = await runNow(s);
    await waitRun(s.owner, run.body.id, ["succeeded"]);
    const kept = await eventually(async () => {
      const runs = await runsOf(s.serviceId);
      return runs.length === 10 ? runs : undefined;
    });
    expect(kept.map((r) => r.id)).toContain(run.body.id);
    expect(kept.map((r) => r.id)).not.toContain(`crn_0000${"0".repeat(20)}`);
  });

  it("ignores job_status from another node and late reports for a finished run", async () => {
    const s = await armedCronStage(() => ({ kind: "exit", code: 0 }));
    const run = await runNow(s);
    const done = await waitRun(s.owner, run.body.id, ["succeeded"]);
    const workloadId = s.job.jobs[0]!.frame.workload.id;

    const strangerJoin = await joinNode(s.owner, s.workspaceId, {
      name: "hel-2",
      hostname: "hel-2",
    });
    const stranger = await connectWorkloadAgent(
      strangerJoin,
      {},
      { protocol_version: PROTOCOL_VERSION },
    );
    const report = {
      type: "job_status",
      run_id: run.body.id,
      workload_id: workloadId,
      state: "failed",
      exit_code: 9,
      finished_at: Date.now(),
    };
    stranger.send(report);
    s.job.send(report);
    // Give both frames time to be handled before checking nothing moved.
    stranger.send(hello(strangerJoin.node_id, { protocol_version: PROTOCOL_VERSION }));
    await new Promise((r) => setTimeout(r, 300));
    const after = await s.owner.json<RunBody>(`/v1/cron-runs/${run.body.id}`);
    expect(after.body).toMatchObject({ status: "succeeded", exit_code: 0 });
    expect(after.body.started_at).toBe(done.started_at);
  });
});

describe("pre-deploy command", () => {
  async function appStage(script: JobAgent["script"]) {
    const { owner, workspaceId } = await install();
    const job = await connectJobAgent(owner, workspaceId, script);
    const project = await createProject(owner, workspaceId);
    const envId = project.environments[0]!.id;
    const created = await createService(owner, project.id, {
      name: "web",
      source: { type: "image", image: "nginx:1.27" },
      config: { deploy: { pre_deploy_command: "node migrate.js" } },
    });
    return { owner, workspaceId, envId, serviceId: created.service.id, job };
  }

  it("runs before the rollout and lets it continue once it succeeds", async () => {
    const s = await appStage(() => ({ kind: "exit", code: 0, logs: ["migrated"] }));
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const active = await waitForStatus(s.owner, d.id, ["active", "failed"]);
    expect(active.status).toBe("active");
    expect(s.job.jobs).toHaveLength(1);
    expect(s.job.jobs[0]!.frame.workload).toMatchObject({
      kind: "job",
      deployment_id: d.id,
      image: "nginx:1.27",
      command: ["/bin/sh", "-c", "node migrate.js"],
    });
    const [run] = await runsOf(s.serviceId);
    expect(run).toMatchObject({ trigger: "pre_deploy", status: "succeeded", deploymentId: d.id });
    const detail = await s.owner.json<{ events: { type: string; data: { run_id?: string } }[] }>(
      `/v1/deployments/${d.id}`,
    );
    const types = detail.body.events.map((e) => e.type);
    expect(types).toContain("pre_deploy_started");
    expect(types).toContain("pre_deploy_finished");
    expect(detail.body.events.find((e) => e.type === "pre_deploy_started")!.data.run_id).toBe(
      run!.id,
    );
    expect(types.indexOf("pre_deploy_finished")).toBeLessThan(types.indexOf("scheduled"));
  });

  it("fails the deployment with pre_deploy_failed and places nothing when it fails", async () => {
    const s = await appStage(() => ({ kind: "exit", code: 1 }));
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const failed = await waitForStatus(s.owner, d.id, ["active", "failed"]);
    expect(failed.status).toBe("failed");
    expect(failed.failure_reason).toBe("pre_deploy_failed: the pre-deploy command exited with 1");
    const workloads = s.job.agent.desired()?.workloads ?? [];
    expect(workloads.filter((w) => w.deployment_id === d.id)).toEqual([]);
    const [run] = await runsOf(s.serviceId);
    expect(run).toMatchObject({ trigger: "pre_deploy", status: "failed", exitCode: 1 });
  });

  it("cancels its run when the deployment is cancelled", async () => {
    const s = await appStage(() => ({ kind: "hang" }));
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const running = await eventually(async () => {
      const [run] = await runsOf(s.serviceId);
      return run?.status === "running" ? run : undefined;
    }, 15_000);
    const cancel = await s.owner.json(`/v1/deployments/${d.id}/cancel`, { method: "POST" });
    expect(cancel.status).toBe(200);
    await waitForStatus(s.owner, d.id, ["cancelled"]);
    await waitRun(s.owner, running.id, ["cancelled"]);
    expect(s.job.cancels).toEqual([running.id]);
  });
});

describe("protected environments", () => {
  it("applies the deploy rule to run now and the config rule to pause", async () => {
    const s = await armedCronStage(() => ({ kind: "exit", code: 0 }));
    const member = await addMember(s.owner, s.workspaceId, "dev@example.com", "member");
    const lock = await s.owner.json(`/v1/environments/${s.envId}/protection`, {
      method: "PUT",
      json: {
        protected: true,
        rules: {
          deploy: { roles: [], user_ids: [], team_ids: [] },
          config: { roles: [], user_ids: [], team_ids: [] },
          variables: { roles: [], user_ids: [], team_ids: [] },
        },
      },
    });
    expect(lock.status).toBe(200);
    const run = await member.json<{ error: { message: string } }>(
      `/v1/services/${s.serviceId}/cron-runs`,
      { method: "POST", json: { environment_id: s.envId } },
    );
    expect(run.status).toBe(403);
    expect(run.body.error.message).toMatch(/protected/);
    const pause = await member.json(`/v1/services/${s.serviceId}/cron/pause`, {
      method: "POST",
      json: { environment_id: s.envId },
    });
    expect(pause.status).toBe(403);
    const read = await member.json(
      `/v1/services/${s.serviceId}/cron-runs?environment_id=${s.envId}`,
    );
    expect(read.status).toBe(200);
    expect((await runNow(s)).status).toBe(201);
  });

  it("refuses a custom domain on a cron service", async () => {
    const s = await armedCronStage(() => ({ kind: "exit", code: 0 }));
    const res = await s.owner.json<{ error: { code: string } }>(
      `/v1/services/${s.serviceId}/domains`,
      { method: "POST", json: { environment_id: s.envId, hostname: "jobs.example.com" } },
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("cron_has_no_endpoint");
  });
});
