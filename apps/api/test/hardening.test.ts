/**
 * Phase 1 hardening on the control-plane side: per-environment networks in
 * desired state, `build_cancel` on cancel, supersede and failure (gated by
 * protocol version), cancelled build results, secret build args end to end,
 * and log flushes that never write for deleted deployments.
 */
import {
  env,
  introspectWorkflow,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import {
  type BuildCancel,
  type BuildJob,
  type ControlMessage,
  environmentNetworkName,
} from "@openrail/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NodeConnection } from "../src/durable/node-connection";
import { secretBuildArgNames } from "../src/workflows/deploy";
import {
  COMMIT_SHA,
  connectWorkloadAgent,
  createService,
  type DeploymentBody,
  deploy,
  GIT_SERVICE,
  isDesired,
  stage,
  waitForStatus,
} from "./pipeline-helpers";

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
beforeEach(async () => {
  introspector = await introspectWorkflow(env.DEPLOY_WORKFLOW);
});
afterEach(async () => {
  await introspector?.dispose();
});

const isCancel = (m: ControlMessage): m is BuildCancel => m.type === "build_cancel";
const isJob = (m: ControlMessage): m is BuildJob => m.type === "build_job";
const V3 = { protocol_version: 3 };

const nodeStub = (nodeId: string) =>
  env.NODE_CONNECTION.get(env.NODE_CONNECTION.idFromName(nodeId));

describe("environment networks", () => {
  it("puts each environment's replicas on its own network", async () => {
    const s = await stage();
    const staging = await s.owner.json<{ id: string }>(
      `/v1/projects/${s.project.id}/environments`,
      {
        method: "POST",
        json: { name: "staging", kind: "staging", copy_from_environment_id: s.envId },
      },
    );
    expect(staging.status).toBe(201);
    const prod = await deploy(s.owner, s.serviceId, s.envId);
    await waitForStatus(s.owner, prod.id, ["active"]);
    const stg = await deploy(s.owner, s.serviceId, staging.body.id);
    await waitForStatus(s.owner, stg.id, ["active"]);

    const workloads = s.agent.desired()!.workloads;
    const prodWl = workloads.find((w) => w.deployment_id === prod.id)!;
    const stgWl = workloads.find((w) => w.deployment_id === stg.id)!;
    expect(prodWl.network).toBe(await environmentNetworkName(s.project.id, s.envId));
    expect(stgWl.network).toBe(await environmentNetworkName(s.project.id, staging.body.id));
    expect(prodWl.network).not.toBe(stgWl.network);
    expect(prodWl.labels["openrail.private_domain"]).toBe("web.production.internal");
    expect(stgWl.labels["openrail.private_domain"]).toBe("web.staging.internal");
  });
});

describe("build cancel", () => {
  it("stops the build on a version 3 builder when the deployment is cancelled", async () => {
    const s = await stage(GIT_SERVICE, { build: "silent" });
    const v3 = await connectWorkloadAgent(s.joined, { build: "silent" }, V3);
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    await waitForStatus(s.owner, d.id, ["building"]);
    const job = await v3.waitFor(isJob);
    const res = await s.owner.json<DeploymentBody>(`/v1/deployments/${d.id}/cancel`, {
      method: "POST",
    });
    expect(res.body.status).toBe("cancelled");
    const cancel = await v3.waitFor(isCancel);
    expect(cancel.build_id).toBe(job.build_id);
    expect(cancel.node_id).toBe(s.joined.node_id);
  });

  it("stops the build of a deployment superseded while building", async () => {
    const s = await stage(GIT_SERVICE, { build: "silent" });
    const v3 = await connectWorkloadAgent(s.joined, { build: "silent" }, V3);
    const first = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    await waitForStatus(s.owner, first.id, ["building"]);
    const job = await v3.waitFor(isJob);
    const second = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: "f".repeat(40) });
    await waitForStatus(s.owner, first.id, ["cancelled"]);
    expect((await v3.waitFor(isCancel)).build_id).toBe(job.build_id);
    await waitForStatus(s.owner, second.id, ["building"]);
  });

  it("never sends build_cancel to a version 2 builder", async () => {
    const s = await stage(GIT_SERVICE, { build: "silent" });
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    await waitForStatus(s.owner, d.id, ["building"]);
    const job = await s.agent.waitFor(isJob);
    await s.owner.json(`/v1/deployments/${d.id}/cancel`, { method: "POST" });
    const result = await nodeStub(s.joined.node_id).sendBuildCancel(job.build_id);
    expect(result).toEqual({ sent: false, reason: "protocol_too_old" });
    expect(s.agent.received.some(isCancel)).toBe(false);
  });

  it("records a build the builder reports as cancelled as cancelled", async () => {
    const s = await stage(GIT_SERVICE, { build: "silent" });
    const v3 = await connectWorkloadAgent(s.joined, { build: "silent" }, V3);
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    const job = await v3.waitFor(isJob);
    v3.send({
      type: "build_result",
      build_id: job.build_id,
      ok: false,
      error: "Build was cancelled.",
      cancelled: true,
      duration_ms: 10,
    });
    const failed = await waitForStatus(s.owner, d.id, ["failed"]);
    expect(failed.build?.status).toBe("cancelled");
    expect(failed.failure_reason).toMatch(/cancelled/);
  });
});

describe("secret build args", () => {
  const SECRET_SERVICE = {
    ...GIT_SERVICE,
    config: {
      build: {
        builder: "dockerfile",
        build_args: { NPM_TOKEN: "npm_secret_value", NODE_ENV: "production" },
        secret_build_args: ["NPM_TOKEN"],
      },
    },
  };

  it("validates that secret args name build args", async () => {
    const s = await stage();
    const bad = await s.owner.json(`/v1/projects/${s.project.id}/services`, {
      method: "POST",
      json: {
        ...GIT_SERVICE,
        name: "bad",
        config: { build: { builder: "dockerfile", build_args: {}, secret_build_args: ["NOPE"] } },
      },
    });
    expect(bad.status).toBe(400);
    const created = await createService(s.owner, s.project.id, { ...SECRET_SERVICE, name: "good" });
    const config = created.configs[0] as unknown as { build: { secret_build_args?: string[] } };
    expect(config.build.secret_build_args).toEqual(["NPM_TOKEN"]);
  });

  it("marks them in the build job sent to a version 3 builder", async () => {
    const s = await stage(SECRET_SERVICE);
    const v3 = await connectWorkloadAgent(s.joined, {}, V3);
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    const job = await v3.waitFor(isJob);
    expect(job.build_args).toEqual({ NPM_TOKEN: "npm_secret_value", NODE_ENV: "production" });
    expect(job.secret_build_args).toEqual(["NPM_TOKEN"]);
    await waitForStatus(s.owner, d.id, ["active"]);
  });

  it("refuses to send them to a builder that would bake them into the image", async () => {
    const s = await stage(SECRET_SERVICE);
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    const failed = await waitForStatus(s.owner, d.id, ["failed"]);
    expect(failed.failure_reason).toMatch(/too old for secret build args/);
    expect(s.agent.received.some(isJob)).toBe(false);
  });

  it("keeps only names of args the config has", () => {
    expect(
      secretBuildArgNames({
        builder: "railpack",
        build_args: { A: "1", B: "2" },
        secret_build_args: ["B", "Z", "B"],
      }),
    ).toEqual(["B"]);
    expect(secretBuildArgNames(undefined)).toEqual([]);
  });
});

describe("log flushes", () => {
  it("flush on the alarm, and write nothing for a deployment deleted meanwhile", async () => {
    const s = await stage();
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const active = await waitForStatus(s.owner, d.id, ["active"]);
    const workloadId = active.placements![0]!.workload_id;
    const stub = nodeStub(s.joined.node_id);
    const buffered = () =>
      runInDurableObject(stub, async (obj: NodeConnection, state) => ({
        lines: (obj as unknown as { logBuffers: Map<string, unknown> }).logBuffers.size,
        alarm: await state.storage.getAlarm(),
      }));

    s.agent.send({
      type: "logs",
      source: { type: "runtime", workload_id: workloadId, deployment_id: d.id },
      lines: [{ ts: Date.now(), stream: "stdout", text: "orphaned line" }],
    });
    for (let i = 0; i < 100 && (await buffered()).lines === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const before = await buffered();
    expect(before.lines).toBe(1);
    expect(before.alarm).not.toBeNull();
    expect(before.alarm!).toBeLessThanOrEqual(Date.now() + 2000);

    // As a test's table wipe (or a project deletion) does between buffering
    // and flushing.
    await env.DB.batch([
      env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
      env.DB.prepare("DELETE FROM placements WHERE deployment_id = ?").bind(d.id),
      env.DB.prepare("DELETE FROM deployment_events WHERE deployment_id = ?").bind(d.id),
      env.DB.prepare("DELETE FROM deployments WHERE id = ?").bind(d.id),
    ]);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await buffered()).lines).toBe(0);
    const listed = await env.LOGS.list({ prefix: `logs/${s.project.id}/` });
    expect(listed.objects).toEqual([]);
    const chunks = await env.DB.prepare("SELECT count(*) AS n FROM log_chunks").first<{
      n: number;
    }>();
    expect(chunks?.n).toBe(0);
  });

  it("still stores lines of live deployments on the alarm", async () => {
    const s = await stage();
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const active = await waitForStatus(s.owner, d.id, ["active"]);
    s.agent.send({
      type: "logs",
      source: {
        type: "runtime",
        workload_id: active.placements![0]!.workload_id,
        deployment_id: d.id,
      },
      lines: [{ ts: Date.now(), stream: "stdout", text: "kept line" }],
    });
    const stub = nodeStub(s.joined.node_id);
    for (let i = 0; i < 100; i++) {
      await runDurableObjectAlarm(stub);
      const row = await env.DB.prepare(
        "SELECT count(*) AS n FROM log_chunks WHERE deployment_id = ?",
      )
        .bind(d.id)
        .first<{ n: number }>();
      if (row?.n) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("the alarm never flushed the line");
  });
});

describe("desired state frames", () => {
  it("are still valid for version 3 agents", async () => {
    const s = await stage();
    const v3 = await connectWorkloadAgent(s.joined, {}, V3);
    expect(v3.rejected).toEqual([]);
    expect(v3.received.some(isDesired)).toBe(true);
  });
});
