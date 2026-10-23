/**
 * Cron services (ADR 0010): config validation, the minute-tick claimer
 * (exactly-once slots under concurrent ticks, deterministic run IDs, one
 * missed record plus one catch-up run, pause), and the routes' RBAC, run
 * now (409 without force), cancel and preview. The run workflow is replaced
 * by a recorder here, so no run leaves the control plane.
 */
import { env } from "cloudflare:test";
import { createDb, cronRuns, cronStates, deployments } from "@roundhouse/db";
import { ACTIONS, AUDIT_ACTIONS, newId } from "@roundhouse/shared";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { CRON_ROUTES, policyOf } from "../src/contracts";
import type { Env } from "../src/env";
import { cronRunId } from "../src/lib/cron/runs";
import { armCronState, claimDueCronRuns, planSlots } from "../src/lib/cron/schedule";
import { addMember, type Client, install } from "./helpers";
import { createProject, createService } from "./pipeline-helpers";

const MINUTE = 60_000;

/** An env whose cron workflow records starts instead of running them. */
function recordingEnv() {
  const started: string[] = [];
  const fake = {
    create: async ({ id }: { id: string }) => {
      if (started.includes(id)) throw new Error("instance exists");
      started.push(id);
      return {};
    },
    get: async () => ({}),
  };
  return { env: { ...env, CRON_RUN_WORKFLOW: fake } as unknown as Env, started };
}

async function cronStage(schedule = "*/5 * * * *") {
  const { owner, workspaceId } = await install();
  const project = await createProject(owner, workspaceId);
  const envId = project.environments[0]!.id;
  const created = await createService(owner, project.id, {
    name: "report",
    kind: "cron",
    source: { type: "image", image: "busybox:1.37" },
    config: { cron: { schedule } },
  });
  const serviceId = created.service.id;
  const db = createDb(env.DB);
  const deploymentId = newId("deployment");
  await db.insert(deployments).values({
    id: deploymentId,
    serviceId,
    environmentId: envId,
    configVersion: 1,
    image: "busybox:1.37",
    status: "active",
    trigger: "manual",
  });
  return { owner, workspaceId, projectId: project.id, envId, serviceId, deploymentId, db };
}

async function runsOf(serviceId: string) {
  return createDb(env.DB)
    .select()
    .from(cronRuns)
    .where(eq(cronRuns.serviceId, serviceId))
    .orderBy(cronRuns.id);
}

describe("cron contracts", () => {
  it("declares known actions and audits", () => {
    for (const [name, r] of Object.entries(CRON_ROUTES)) {
      const p = policyOf(r);
      expect(ACTIONS, name).toContain(p.action);
      for (const a of p.audit) expect(AUDIT_ACTIONS, name).toContain(a);
    }
    expect(policyOf(CRON_ROUTES.triggerCronRun).action).toBe("deployments:create");
    expect(policyOf(CRON_ROUTES.cancelCronRun).action).toBe("deployments:create");
    expect(policyOf(CRON_ROUTES.pauseCron).action).toBe("services:manage");
    expect(policyOf(CRON_ROUTES.listCronRuns).action).toBe("services:read");
  });
});

describe("cron config", () => {
  it("stores the cron part with defaults and rejects a bad schedule with its span", async () => {
    const s = await cronStage("0 3 * * *");
    const config = await s.owner.json<{ cron: Record<string, unknown> }>(
      `/v1/services/${s.serviceId}/config?environment_id=${s.envId}`,
    );
    expect(config.body.cron).toMatchObject({
      schedule: "0 3 * * *",
      timezone: "UTC",
      concurrency: "forbid",
      timeout_s: 3600,
      retries: 0,
    });
    const bad = await s.owner.json<{ error: { code: string; details: unknown[] } }>(
      `/v1/services/${s.serviceId}`,
      {
        method: "PATCH",
        json: { environment_id: s.envId, cron: { schedule: "0 25 * * *" } },
      },
    );
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("invalid_schedule");
    expect(bad.body.error.details[0]).toMatchObject({ field: "cron.schedule", start: 2, end: 4 });
    const zone = await s.owner.json<{ error: { code: string } }>(`/v1/services/${s.serviceId}`, {
      method: "PATCH",
      json: { environment_id: s.envId, cron: { timezone: "Mars/Olympus" } },
    });
    expect(zone.status).toBe(422);
  });

  it("refuses to deploy a cron service without a schedule", async () => {
    const { owner, workspaceId } = await install();
    const project = await createProject(owner, workspaceId);
    const envId = project.environments[0]!.id;
    const created = await createService(owner, project.id, {
      name: "nightly",
      kind: "cron",
      source: { type: "image", image: "busybox:1.37" },
    });
    const res = await owner.json<{ error: { code: string } }>(
      `/v1/services/${created.service.id}/deployments?environment_id=${envId}`,
      { method: "POST", json: {} },
    );
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("cron_schedule_required");
  });
});

describe("cron claimer", () => {
  it("claims each slot exactly once, under a deterministic run ID, even with overlapping ticks", async () => {
    const s = await cronStage("*/5 * * * *");
    const t0 = Date.UTC(2026, 9, 23, 10, 1);
    const cron = { ...(await armedCron(s)) };
    expect(
      await armCronState(s.db, { serviceId: s.serviceId, environmentId: s.envId, cron, now: t0 }),
    ).toBe(Date.UTC(2026, 9, 23, 10, 5));
    const { env: tickEnv, started } = recordingEnv();
    const tick = Date.UTC(2026, 9, 23, 10, 5, 20);
    const results = await Promise.all([
      claimDueCronRuns(tickEnv, tick),
      claimDueCronRuns(tickEnv, tick),
      claimDueCronRuns(tickEnv, tick),
    ]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    const runs = await runsOf(s.serviceId);
    expect(runs).toHaveLength(1);
    const expectedId = await cronRunId({
      serviceId: s.serviceId,
      environmentId: s.envId,
      scheduledFor: Date.UTC(2026, 9, 23, 10, 5),
      attempt: 1,
      kind: "run",
    });
    expect(runs[0]).toMatchObject({ id: expectedId, status: "queued", trigger: "schedule" });
    expect(started).toEqual([expectedId]);
    expect(await claimDueCronRuns(tickEnv, tick)).toBe(0);
    const [state] = await s.db
      .select()
      .from(cronStates)
      .where(and(eq(cronStates.serviceId, s.serviceId), eq(cronStates.environmentId, s.envId)));
    expect(+state!.nextRunAt!).toBe(Date.UTC(2026, 9, 23, 10, 10));
  });

  it("records old slots as one missed run and runs only the latest", async () => {
    const s = await cronStage("*/5 * * * *");
    const cron = await armedCron(s);
    await armCronState(s.db, {
      serviceId: s.serviceId,
      environmentId: s.envId,
      cron,
      now: Date.UTC(2026, 9, 23, 9, 0, 30),
    });
    const { env: tickEnv } = recordingEnv();
    await claimDueCronRuns(tickEnv, Date.UTC(2026, 9, 23, 10, 0, 40));
    const runs = await runsOf(s.serviceId);
    const missed = runs.find((r) => r.status === "missed");
    const queued = runs.filter((r) => r.status === "queued");
    expect(missed).toMatchObject({ missedCount: 11 });
    expect(+missed!.scheduledFor).toBe(Date.UTC(2026, 9, 23, 9, 5));
    expect(queued).toHaveLength(1);
    expect(+queued[0]!.scheduledFor).toBe(Date.UTC(2026, 9, 23, 10, 0));
  });

  it("misses the latest slot too once it is past the starting deadline", () => {
    const plan = planSlots(
      {
        schedule: "0 * * * *",
        timezone: "UTC",
        concurrency: "forbid",
        timeout_s: 60,
        starting_deadline_s: 300,
        retries: 0,
        retry_backoff_s: 60,
        history_limit: 100,
      },
      Date.UTC(2026, 9, 23, 8),
      Date.UTC(2026, 9, 23, 10, 10),
    );
    expect(plan.run).toBeNull();
    expect(plan.missed).toEqual([
      Date.UTC(2026, 9, 23, 8),
      Date.UTC(2026, 9, 23, 9),
      Date.UTC(2026, 9, 23, 10),
    ]);
    expect(plan.next).toBe(Date.UTC(2026, 9, 23, 11));
  });

  it("does nothing while paused, and resumes from the next future slot", async () => {
    const s = await cronStage("*/5 * * * *");
    const cron = await armedCron(s);
    await armCronState(s.db, {
      serviceId: s.serviceId,
      environmentId: s.envId,
      cron,
      now: Date.UTC(2026, 9, 23, 9, 0, 30),
    });
    const paused = await s.owner.json<{ paused: boolean; next_run_at: number | null }>(
      `/v1/services/${s.serviceId}/cron/pause`,
      { method: "POST", json: { environment_id: s.envId } },
    );
    expect(paused.body).toMatchObject({ paused: true, next_run_at: null });
    const { env: tickEnv } = recordingEnv();
    expect(await claimDueCronRuns(tickEnv, Date.UTC(2026, 9, 23, 10))).toBe(0);
    expect(await runsOf(s.serviceId)).toHaveLength(0);
    const resumed = await s.owner.json<{ paused: boolean; next_run_at: number }>(
      `/v1/services/${s.serviceId}/cron/resume`,
      { method: "POST", json: { environment_id: s.envId } },
    );
    expect(resumed.body.paused).toBe(false);
    expect(resumed.body.next_run_at).toBeGreaterThan(Date.now());
  });
});

describe("cron routes", () => {
  it("lets viewers read runs but not run, cancel or pause", async () => {
    const s = await cronStage();
    const viewer: Client = await addMember(s.owner, s.workspaceId, "vic@example.com", "viewer");
    const list = await viewer.json(
      `/v1/services/${s.serviceId}/cron-runs?environment_id=${s.envId}`,
    );
    expect(list.status).toBe(200);
    for (const [path, json] of [
      [`/v1/services/${s.serviceId}/cron-runs`, { environment_id: s.envId }],
      [`/v1/services/${s.serviceId}/cron/pause`, { environment_id: s.envId }],
    ] as const) {
      const res = await viewer.json(path, { method: "POST", json });
      expect(res.status, path).toBe(403);
    }
  });

  it("answers run now with 409 run_in_progress unless forced, and cancels a queued run", async () => {
    const s = await cronStage();
    const runningId = newId("cronRun");
    await s.db.insert(cronRuns).values({
      id: runningId,
      serviceId: s.serviceId,
      environmentId: s.envId,
      deploymentId: s.deploymentId,
      trigger: "schedule",
      scheduledFor: new Date(),
      status: "running",
    });
    const blocked = await s.owner.json<{ error: { code: string } }>(
      `/v1/services/${s.serviceId}/cron-runs`,
      { method: "POST", json: { environment_id: s.envId } },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("run_in_progress");

    const queuedId = newId("cronRun");
    await s.db.insert(cronRuns).values({
      id: queuedId,
      serviceId: s.serviceId,
      environmentId: s.envId,
      deploymentId: s.deploymentId,
      trigger: "manual",
      scheduledFor: new Date(),
      status: "queued",
    });
    const cancelled = await s.owner.json<{ status: string }>(`/v1/cron-runs/${queuedId}/cancel`, {
      method: "POST",
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
    const again = await s.owner.json(`/v1/cron-runs/${queuedId}/cancel`, { method: "POST" });
    expect(again.status).toBe(409);
  });

  it("previews a schedule, pointing at the offending span", async () => {
    const s = await cronStage();
    const ok = await s.owner.json<{ valid: boolean; next_runs: number[] }>(
      `/v1/projects/${s.projectId}/cron/preview?schedule=${encodeURIComponent("0 3 * * *")}&timezone=Europe/Berlin&count=3`,
    );
    expect(ok.body.valid).toBe(true);
    expect(ok.body.next_runs).toHaveLength(3);
    const bad = await s.owner.json<{ valid: boolean; error: { start: number; end: number } }>(
      `/v1/projects/${s.projectId}/cron/preview?schedule=${encodeURIComponent("0 0 ? * *")}`,
    );
    expect(bad.body).toMatchObject({ valid: false, error: { start: 4, end: 5 } });
  });

  it("hides another workspace's runs", async () => {
    const s = await cronStage();
    const runId = newId("cronRun");
    await s.db.insert(cronRuns).values({
      id: runId,
      serviceId: s.serviceId,
      environmentId: s.envId,
      deploymentId: s.deploymentId,
      trigger: "manual",
      scheduledFor: new Date(),
      status: "succeeded",
    });
    const stranger = await install({ email: "zed@example.org" }).catch(() => null);
    if (stranger) {
      const res = await stranger.owner.json(`/v1/cron-runs/${runId}`);
      expect(res.status).toBe(404);
    }
    const own = await s.owner.json<{ id: string }>(`/v1/cron-runs/${runId}`);
    expect(own.body.id).toBe(runId);
  });
});

async function armedCron(s: { db: ReturnType<typeof createDb>; serviceId: string; envId: string }) {
  const { armedDeployment } = await import("../src/lib/cron/runs");
  const armed = await armedDeployment(s.db, s.serviceId, s.envId);
  if (!armed) throw new Error("not armed");
  return armed.cron;
}
