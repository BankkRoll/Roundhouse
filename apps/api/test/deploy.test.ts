/**
 * The deploy pipeline end to end: routes start a `DeployWorkflow`, which
 * builds on (and places replicas through) a protocol 2 fake agent until the
 * deployment is active, fails, or is cancelled.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { createDb } from "@openrail/db";
import { BUILD_TIMEOUT_S, canTransition, ROLLOUT_TIMEOUT_MS } from "@openrail/shared";
import { afterEach, describe, expect, it } from "vitest";
import { IllegalTransitionError, transitionDeployment } from "../src/lib/deployments";
import { rolloutTimeoutMs } from "../src/workflows/deploy";
import { addMember, eventually, install, joinNode } from "./helpers";
import {
  COMMIT_SHA,
  connectWorkloadAgent,
  createProject,
  createService,
  type DeploymentBody,
  deploy,
  GIT_SERVICE,
  IMAGE_DIGEST,
  isDesired,
  stage,
  waitForStatus,
} from "./pipeline-helpers";

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;

async function introspect() {
  introspector = await introspectWorkflow(env.DEPLOY_WORKFLOW);
  return introspector;
}

afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

describe("image deployments", () => {
  it("goes queued → deploying → active with healthy replicas on the node", async () => {
    await introspect();
    const s = await stage();
    await s.owner.json(`/v1/services/${s.serviceId}/variables?environment_id=${s.envId}`, {
      method: "PUT",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: `${{…}}` is variable-reference syntax, not a template.
      json: { set: [{ key: "GREETING", value: "hi from ${{OPENRAIL_SERVICE_NAME}}" }] },
    });
    const created = await deploy(s.owner, s.serviceId, s.envId);
    expect(created.status).toBe("queued");
    expect(created.image).toBe("nginx:1.27");

    const active = await waitForStatus(s.owner, created.id, ["active", "failed"]);
    expect(active.failure_reason).toBeNull();
    expect(active.status).toBe("active");
    expect(active.placements).toHaveLength(1);
    expect(active.placements![0]).toMatchObject({ node_id: s.joined.node_id, state: "healthy" });
    expect(active.events!.map((e) => e.type)).toEqual(
      expect.arrayContaining(["status_changed", "scheduled", "replica_status", "rollout_finished"]),
    );

    const desired = s.agent.desired()!;
    const workload = desired.workloads.find((w) => w.deployment_id === created.id)!;
    expect(workload).toMatchObject({
      kind: "service",
      image: "nginx:1.27",
      network: `openrail-${s.project.id}-${s.envId}`,
      ports: [{ container_port: 8080, protocol: "http" }],
    });
    expect(s.agent.env(workload.id)).toMatchObject({
      GREETING: "hi from web",
      PORT: "8080",
      OPENRAIL_DEPLOYMENT_ID: created.id,
      OPENRAIL_ENVIRONMENT: "production",
    });
    expect(s.agent.rejected).toEqual([]);

    // The audit entry is written just after the status flips.
    const actions = await eventually(async () => {
      const audit = await env.DB.prepare(
        "SELECT action FROM audit_logs WHERE target_id = ? ORDER BY id",
      )
        .bind(created.id)
        .all<{ action: string }>();
      return audit.results.length === 2 ? audit.results.map((r) => r.action) : undefined;
    });
    expect(actions).toEqual(["deployment.created", "deployment.succeeded"]);
  });

  it("supersedes the previous deployment and drops its workloads from desired state", async () => {
    await introspect();
    const s = await stage();
    const first = await deploy(s.owner, s.serviceId, s.envId);
    await waitForStatus(s.owner, first.id, ["active"]);
    const second = await deploy(s.owner, s.serviceId, s.envId);
    await waitForStatus(s.owner, second.id, ["active"]);

    // Superseded right after the new one goes active.
    await waitForStatus(s.owner, first.id, ["removed"]);
    await eventually(async () => {
      const ids = s.agent.desired()!.workloads.map((w) => w.deployment_id);
      return ids.length === 1 && ids[0] === second.id ? true : undefined;
    });
    // Each push carries a higher generation than the one before.
    const generations = s.agent.received.filter(isDesired).map((d) => d.generation);
    expect([...generations].sort((a, b) => a - b)).toEqual(generations);
  });

  it("fails without placing anything when no node can take the replicas", async () => {
    await introspect();
    const s = await stage({
      name: "huge",
      source: { type: "image", image: "nginx:1.27" },
      config: { resources: { memory_mb: 262_144 } },
    });
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const failed = await waitForStatus(s.owner, d.id, ["failed"]);
    expect(failed.failure_reason).toContain("insufficient memory");
    expect(failed.events!.some((e) => e.type === "schedule_failed")).toBe(true);
    expect(failed.placements).toEqual([]);
  });

  it("fails at deploy time on an unknown reference, before scheduling", async () => {
    await introspect();
    const s = await stage();
    await s.owner.json(`/v1/services/${s.serviceId}/variables?environment_id=${s.envId}`, {
      method: "PUT",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: `${{…}}` is variable-reference syntax, not a template.
      json: { set: [{ key: "DB", value: "${{postgres.URL}}" }] },
    });
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const failed = await waitForStatus(s.owner, d.id, ["failed"]);
    expect(failed.failure_reason).toMatch(/web\.DB.*postgres/);
    expect(failed.placements).toEqual([]);
  });

  it("times out when replicas never become healthy and keeps the previous one serving", async () => {
    const wf = await introspect();
    const s = await stage();
    const good = await deploy(s.owner, s.serviceId, s.envId);
    await waitForStatus(s.owner, good.id, ["active"]);

    await wf.modifyAll(async (m) => {
      await m.forceEventTimeout({ name: "health" });
    });
    s.agent.behaviour.health = "silent";
    const bad = await deploy(s.owner, s.serviceId, s.envId);
    const failed = await waitForStatus(s.owner, bad.id, ["failed"]);
    expect(failed.failure_reason).toMatch(/did not become healthy/);

    const prev = await s.owner.json<DeploymentBody>(`/v1/deployments/${good.id}`);
    expect(prev.body.status).toBe("active");
    await eventually(async () => {
      const ids = s.agent.desired()!.workloads.map((w) => w.deployment_id);
      return ids.length === 1 && ids[0] === good.id ? true : undefined;
    });
    await eventually(async () => {
      const audit = await env.DB.prepare("SELECT action FROM audit_logs WHERE target_id = ?")
        .bind(bad.id)
        .all<{ action: string }>();
      return audit.results.some((r) => r.action === "deployment.failed") ? true : undefined;
    });
  });

  it("fails fast when a replica crashes under restart policy never", async () => {
    await introspect();
    const s = await stage(
      {
        name: "once",
        source: { type: "image", image: "busybox:1.36" },
        config: { deploy: { restart_policy: "never" } },
      },
      { health: "crashed" },
    );
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const failed = await waitForStatus(s.owner, d.id, ["failed"]);
    expect(failed.failure_reason).toMatch(/crashed and its restart policy is never/);
  });

  it("marks an active deployment crashed and back when a replica recovers", async () => {
    await introspect();
    const s = await stage();
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const active = await waitForStatus(s.owner, d.id, ["active"]);
    const wl = active.placements![0]!.workload_id;
    const status = (state: string) =>
      s.agent.send({
        type: "workload_status",
        workload_id: wl,
        deployment_id: d.id,
        state,
        restarts: 1,
        ts: Date.now(),
      });
    status("crashed");
    await waitForStatus(s.owner, d.id, ["crashed"]);
    status("healthy");
    await waitForStatus(s.owner, d.id, ["active"]);
  });
});

describe("git deployments", () => {
  it("builds on the builder node, then rolls out the built digest", async () => {
    await introspect();
    const s = await stage(GIT_SERVICE);
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    const active = await waitForStatus(s.owner, d.id, ["active", "failed"]);
    expect(active.failure_reason).toBeNull();
    const repo = `127.0.0.1:5000/${s.project.id.toLowerCase()}/${s.serviceId.toLowerCase()}`;
    expect(active.image).toBe(`${repo}@${IMAGE_DIGEST}`);
    expect(active.build).toMatchObject({
      status: "succeeded",
      image_digest: IMAGE_DIGEST,
      node_id: s.joined.node_id,
      commit_sha: COMMIT_SHA,
    });

    const job = s.agent.received.find((m) => m.type === "build_job")!;
    expect(job).toMatchObject({
      build_id: active.build!.id,
      deployment_id: d.id,
      source: { type: "git", url: "https://github.com/acme/api", commit_sha: COMMIT_SHA },
      image_repository: repo,
      timeout_s: BUILD_TIMEOUT_S,
    });
    expect(job.exp - job.iat).toBeLessThanOrEqual(60_000);
    expect("token" in (job as { source: object }).source).toBe(false);
    const workload = s.agent.desired()!.workloads[0]!;
    expect(s.agent.env(workload.id)?.OPENRAIL_GIT_COMMIT_SHA).toBe(COMMIT_SHA);
    expect(s.agent.desired()!.registry).toEqual({
      listen: "127.0.0.1:5000",
      storage: { type: "filesystem" },
    });
  });

  it("resolves the branch head over smart HTTP when no commit is given", async () => {
    await introspect();
    const s = await stage(GIT_SERVICE);
    const realFetch = globalThis.fetch;
    const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://github.com/acme/api/info/refs?service=git-upload-pack") {
        return new Response(
          `${pkt("# service=git-upload-pack\n")}0000${pkt(`${COMMIT_SHA} HEAD\0multi_ack\n`)}${pkt(
            `${COMMIT_SHA} refs/heads/main\n`,
          )}0000`,
        );
      }
      return realFetch(input, init);
    }) as typeof fetch;
    try {
      const d = await deploy(s.owner, s.serviceId, s.envId);
      const active = await waitForStatus(s.owner, d.id, ["active", "failed"]);
      expect(active.failure_reason).toBeNull();
      expect(active.build?.commit_sha).toBe(COMMIT_SHA);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("fails on a build failure and records the builder's error", async () => {
    await introspect();
    const s = await stage(GIT_SERVICE, { build: "fail" });
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    const failed = await waitForStatus(s.owner, d.id, ["failed"]);
    expect(failed.failure_reason).toBe("Build failed: exit status 1");
    expect(failed.build?.status).toBe("failed");
    expect(failed.placements).toEqual([]);
  });

  it("fails when the build times out", async () => {
    const wf = await introspect();
    await wf.modifyAll(async (m) => {
      await m.forceEventTimeout({ name: "build" });
    });
    const s = await stage(GIT_SERVICE, { build: "silent" });
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    const failed = await waitForStatus(s.owner, d.id, ["failed"]);
    expect(failed.failure_reason).toMatch(/Build did not finish/);
    expect(failed.build?.status).toBe("failed");
  });

  it("fails when no builder node is available", async () => {
    await introspect();
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    await connectWorkloadAgent(
      joined,
      {},
      {
        capabilities: { docker: true, gvisor: false, builder: false },
      },
    );
    const project = await createProject(owner, workspaceId);
    const svc = await createService(owner, project.id, GIT_SERVICE);
    const d = await deploy(owner, svc.service.id, project.environments[0]!.id, {
      commit_sha: COMMIT_SHA,
    });
    const failed = await waitForStatus(owner, d.id, ["failed"]);
    expect(failed.failure_reason).toMatch(/No online builder node/);
  });

  it("cancels while building: the workflow stops and nothing is placed", async () => {
    const wf = await introspect();
    const s = await stage(GIT_SERVICE, { build: "silent" });
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    await waitForStatus(s.owner, d.id, ["building"]);
    await s.agent.waitFor((m) => m.type === "build_job");
    const res = await s.owner.json<DeploymentBody>(`/v1/deployments/${d.id}/cancel`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    const [instance] = await wf.get();
    await instance!.waitForStatus("complete");
    expect(await instance!.getOutput()).toEqual({ status: "cancelled" });
    const after = await s.owner.json<DeploymentBody>(`/v1/deployments/${d.id}`);
    expect(after.body.placements).toEqual([]);
    expect(after.body.build?.status).toBe("cancelled");

    const again = await s.owner.json(`/v1/deployments/${d.id}/cancel`, { method: "POST" });
    expect(again.status).toBe(409);
  });
});

describe("rollback", () => {
  it("redeploys an earlier image and config version without building", async () => {
    await introspect();
    const s = await stage(GIT_SERVICE);
    const first = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    await waitForStatus(s.owner, first.id, ["active"]);
    await s.owner.json(`/v1/services/${s.serviceId}`, {
      method: "PATCH",
      json: { environment_id: s.envId, deploy: { drain_s: 30 } },
    });
    const second = await deploy(s.owner, s.serviceId, s.envId, {
      commit_sha: "f".repeat(40),
    });
    const secondActive = await waitForStatus(s.owner, second.id, ["active"]);
    expect(secondActive.config_version).toBe(2);
    const jobs = () => s.agent.received.filter((m) => m.type === "build_job").length;
    expect(jobs()).toBe(2);

    const res = await s.owner.json<DeploymentBody>(`/v1/deployments/${first.id}/rollback`, {
      method: "POST",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      trigger: "rollback",
      rollback_of: first.id,
      config_version: 1,
    });
    const rolled = await waitForStatus(s.owner, res.body.id, ["active", "failed"]);
    expect(rolled.failure_reason).toBeNull();
    expect(rolled.image).toBe((await waitForStatus(s.owner, first.id, ["removed"])).image);
    expect(rolled.build_id).toBeNull();
    expect(jobs()).toBe(2);
    await waitForStatus(s.owner, second.id, ["rolled_back"]);
  });

  it("refuses to roll back to a deployment that never ran", async () => {
    await introspect();
    const s = await stage(GIT_SERVICE, { build: "fail" });
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    await waitForStatus(s.owner, d.id, ["failed"]);
    const res = await s.owner.json(`/v1/deployments/${d.id}/rollback`, { method: "POST" });
    expect(res.status).toBe(409);
  });
});

describe("deployment routes", () => {
  it("rejects deploying 0 replicas with 409", async () => {
    await introspect();
    const s = await stage({
      name: "idle",
      source: { type: "image", image: "nginx:1.27" },
      config: { deploy: { replicas: 0 } },
    });
    const res = await s.owner.json(
      `/v1/services/${s.serviceId}/deployments?environment_id=${s.envId}`,
      {
        method: "POST",
        json: {},
      },
    );
    expect(res.status).toBe(409);
  });

  it("pages newest first with a cursor", async () => {
    await introspect();
    const s = await stage({ ...GIT_SERVICE }, { build: "silent" });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA })).id);
    }
    const page1 = await s.owner.json<{ deployments: DeploymentBody[]; next_cursor: string | null }>(
      `/v1/services/${s.serviceId}/deployments?environment_id=${s.envId}&limit=2`,
    );
    expect(page1.body.deployments.map((d) => d.id)).toEqual([ids[2], ids[1]]);
    const page2 = await s.owner.json<{ deployments: DeploymentBody[]; next_cursor: string | null }>(
      `/v1/services/${s.serviceId}/deployments?environment_id=${s.envId}&limit=2&cursor=${page1.body.next_cursor}`,
    );
    expect(page2.body.deployments.map((d) => d.id)).toEqual([ids[0]]);
    expect(page2.body.next_cursor).toBeNull();
    // Older in-flight deployments were superseded by each newer one.
    expect(page2.body.deployments[0]!.status).toBe("cancelled");
    const bad = await s.owner.json(
      `/v1/services/${s.serviceId}/deployments?environment_id=${s.envId}&cursor=nope`,
    );
    expect(bad.status).toBe(400);
  });

  it("enforces roles and hides other workspaces' deployments", async () => {
    await introspect();
    const s = await stage({ ...GIT_SERVICE }, { build: "silent" });
    const viewer = await addMember(s.owner, s.workspaceId, "v@example.com", "viewer");
    const member = await addMember(s.owner, s.workspaceId, "m@example.com", "member");
    const path = `/v1/services/${s.serviceId}/deployments?environment_id=${s.envId}`;
    expect((await viewer.json(path, { method: "POST", json: {} })).status).toBe(403);
    expect((await viewer.json(path)).status).toBe(200);
    const d = await member.json<DeploymentBody>(path, {
      method: "POST",
      json: { commit_sha: COMMIT_SHA },
    });
    expect(d.status).toBe(201);
    expect(
      (await viewer.json(`/v1/deployments/${d.body.id}/cancel`, { method: "POST" })).status,
    ).toBe(403);

    const ws2 = await s.owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Elsewhere" },
    });
    const outsider = await addMember(s.owner, ws2.body.id, "x@example.com", "admin");
    for (const p of [`/v1/deployments/${d.body.id}`, `/v1/deployments/${d.body.id}/logs`, path]) {
      expect((await outsider.json(p)).status, p).toBe(404);
    }
    expect(
      (await outsider.json(`/v1/deployments/${d.body.id}/rollback`, { method: "POST" })).status,
    ).toBe(404);
  });

  it("requires an environment of the service's project", async () => {
    await introspect();
    const s = await stage();
    const other = await createProject(s.owner, s.workspaceId, { name: "Other" });
    const res = await s.owner.json(
      `/v1/services/${s.serviceId}/deployments?environment_id=${other.environments[0]!.id}`,
      { method: "POST", json: {} },
    );
    expect(res.status).toBe(404);
    const missing = await s.owner.json(`/v1/services/${s.serviceId}/deployments`, {
      method: "POST",
      json: {},
    });
    expect(missing.status).toBe(400);
  });
});

describe("status transitions", () => {
  it("only allows what canTransition allows", async () => {
    await introspect();
    const s = await stage(GIT_SERVICE, { build: "fail" });
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    await waitForStatus(s.owner, d.id, ["failed"]);
    const ctx = { db: createDb(env.DB), env };
    expect(canTransition("failed", "active")).toBe(false);
    await expect(transitionDeployment(ctx, s.project.id, d.id, "active")).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
    await expect(transitionDeployment(ctx, s.project.id, d.id, "queued")).rejects.toThrow(
      /failed → queued/,
    );
    // Staying put is not a transition and reports no change.
    expect(await transitionDeployment(ctx, s.project.id, d.id, "failed")).toBeNull();
  });
});

describe("rollout timeout", () => {
  it("defaults to ROLLOUT_TIMEOUT_MS and lets ROLLOUT_TIMEOUT_S only shorten it", () => {
    expect(rolloutTimeoutMs({})).toBe(ROLLOUT_TIMEOUT_MS);
    expect(rolloutTimeoutMs({ ROLLOUT_TIMEOUT_S: "45" })).toBe(45_000);
    expect(rolloutTimeoutMs({ ROLLOUT_TIMEOUT_S: " 60 " })).toBe(60_000);
    // Garbage, too short or longer than the default fall back to the default.
    for (const bad of ["", "abc", "1.5", "-30", "5", String(ROLLOUT_TIMEOUT_MS / 1000 + 1)]) {
      expect(rolloutTimeoutMs({ ROLLOUT_TIMEOUT_S: bad })).toBe(ROLLOUT_TIMEOUT_MS);
    }
  });

  it("fails the rollout after the configured timeout, saying how long it waited", async () => {
    const wf = await introspect();
    await wf.modifyAll(async (m) => {
      await m.forceEventTimeout({ name: "health" });
    });
    const s = await stage(undefined, { health: "silent" });
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const failed = await waitForStatus(s.owner, d.id, ["failed"]);
    expect(failed.failure_reason).toBe("Replicas did not become healthy within 10 minutes");
  });
});
