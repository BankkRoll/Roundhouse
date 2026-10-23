/**
 * Hardening on the control-plane side.
 *
 * - Phase 1: per-environment networks in desired state, `build_cancel` on
 *   cancel, supersede and failure, cancelled build results, secret build args
 *   end to end, and log flushes that never write for deleted deployments.
 * - ADR 0014: regression tests for the findings already closed, one
 *   `describe` per finding.
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
  MIN_PROTOCOL_VERSION,
} from "@roundhouse/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NodeConnection } from "../src/durable/node-connection";
import { secretBuildArgNames } from "../src/workflows/deploy";
import { addMember, call, install } from "./helpers";
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
const OLDEST = { protocol_version: MIN_PROTOCOL_VERSION };

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
    expect(prodWl.labels["roundhouse.private_domain"]).toBe("web.production.internal");
    expect(stgWl.labels["roundhouse.private_domain"]).toBe("web.staging.internal");
  });
});

describe("build cancel", () => {
  it("stops the build on the builder when the deployment is cancelled", async () => {
    const s = await stage(GIT_SERVICE, { build: "silent" });
    const builder = await connectWorkloadAgent(s.joined, { build: "silent" });
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    await waitForStatus(s.owner, d.id, ["building"]);
    const job = await builder.waitFor(isJob);
    const res = await s.owner.json<DeploymentBody>(`/v1/deployments/${d.id}/cancel`, {
      method: "POST",
    });
    expect(res.body.status).toBe("cancelled");
    const cancel = await builder.waitFor(isCancel);
    expect(cancel.build_id).toBe(job.build_id);
    expect(cancel.node_id).toBe(s.joined.node_id);
  });

  it("stops the build of a deployment superseded while building", async () => {
    const s = await stage(GIT_SERVICE, { build: "silent" });
    const builder = await connectWorkloadAgent(s.joined, { build: "silent" });
    const first = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    await waitForStatus(s.owner, first.id, ["building"]);
    const job = await builder.waitFor(isJob);
    const second = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: "f".repeat(40) });
    await waitForStatus(s.owner, first.id, ["cancelled"]);
    expect((await builder.waitFor(isCancel)).build_id).toBe(job.build_id);
    await waitForStatus(s.owner, second.id, ["building"]);
  });

  it("records a build the builder reports as cancelled as cancelled", async () => {
    const s = await stage(GIT_SERVICE, { build: "silent" });
    const builder = await connectWorkloadAgent(s.joined, { build: "silent" });
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    const job = await builder.waitFor(isJob);
    builder.send({
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

  it("marks them in the build job sent to the builder", async () => {
    const s = await stage(SECRET_SERVICE);
    const builder = s.agent;
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    const job = await builder.waitFor(isJob);
    expect(job.build_args).toEqual({ NPM_TOKEN: "npm_secret_value", NODE_ENV: "production" });
    expect(job.secret_build_args).toEqual(["NPM_TOKEN"]);
    await waitForStatus(s.owner, d.id, ["active"]);
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
  it("are still valid for the oldest accepted agents", async () => {
    const s = await stage();
    const oldest = await connectWorkloadAgent(s.joined, {}, OLDEST);
    expect(oldest.rejected).toEqual([]);
    expect(oldest.received.some(isDesired)).toBe(true);
  });
});

describe("cache: API and auth responses are never stored", () => {
  it.each(["/v1/setup", "/v1/me", "/v1/does-not-exist", "/api/auth/get-session"])(
    "sets no-store, private and varies on Cookie for %s",
    async (path) => {
      const res = await call(path);
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      expect(res.headers.get("vary")?.toLowerCase()).toContain("cookie");
    },
  );
});

describe("F3: instance:manage comes from the instance-admin flag only", () => {
  it("makes the setup user an instance admin", async () => {
    const { userId } = await install();
    const row = await env.DB.prepare("SELECT instance_admin FROM users WHERE id = ?")
      .bind(userId)
      .first<{ instance_admin: number }>();
    expect(row?.instance_admin).toBe(1);
  });

  it("refuses instance settings to a workspace owner who isn't an instance admin", async () => {
    const { owner, userId } = await install();
    await env.DB.prepare("UPDATE users SET instance_admin = 0 WHERE id = ?").bind(userId).run();
    expect((await owner.request("/v1/instance/settings")).status).toBe(403);
  });
});

describe("access: checks go through resolveAccess with the project in scope", () => {
  it("applies a protected environment's rules to variable writes", async () => {
    const s = await stage();
    const member = await addMember(s.owner, s.workspaceId, "dev@example.com", "member");
    const path = `/v1/services/${s.serviceId}/variables?environment_id=${s.envId}`;
    const put = (c: typeof member) =>
      c.json(path, { method: "PUT", json: { set: [{ key: "MODE", value: "fast" }] } });
    expect((await put(member)).status).toBe(200);
    await env.DB.prepare("UPDATE environments SET protected = 1 WHERE id = ?").bind(s.envId).run();
    expect((await put(member)).status).toBe(403);
    expect((await put(s.owner)).status).toBe(200);
    // Reads aren't environment actions, so protection leaves them alone.
    expect((await member.json(path)).status).toBe(200);
  });

  it("applies a protected environment's rules to deploys, rollbacks and cancels", async () => {
    const s = await stage();
    const member = await addMember(s.owner, s.workspaceId, "deployer@example.com", "member");
    const deploy = (c: typeof member) =>
      c.json(`/v1/services/${s.serviceId}/deployments?environment_id=${s.envId}`, {
        method: "POST",
        json: {},
      });
    const first = await deploy(s.owner);
    expect(first.status).toBeLessThan(300);
    const deployment = first.body as { id: string };

    // The default rules still let deployers deploy; this environment allows project admins only.
    const adminsOnly = { roles: [], userIds: [], teamIds: [] };
    await env.DB.prepare("UPDATE environments SET protected = 1, protection_rules = ? WHERE id = ?")
      .bind(
        JSON.stringify({ deploy: adminsOnly, config: adminsOnly, variables: adminsOnly }),
        s.envId,
      )
      .run();
    expect((await deploy(member)).status).toBe(403);
    const base = `/v1/deployments/${deployment.id}`;
    expect((await member.json(`${base}/rollback`, { method: "POST" })).status).toBe(403);
    expect((await member.json(`${base}/cancel`, { method: "POST" })).status).toBe(403);
    expect((await deploy(s.owner)).status).toBeLessThan(300);
  });

  it("uses project grants and the workspace's default project role", async () => {
    const s = await stage();
    const member = await addMember(s.owner, s.workspaceId, "m@example.com", "member");
    const project = `/v1/projects/${s.project.id}`;
    await env.DB.prepare("UPDATE workspaces SET member_default_project_role = 'none' WHERE id = ?")
      .bind(s.workspaceId)
      .run();
    expect((await member.json(project)).status).toBe(403);
    const userId = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
      .bind("m@example.com")
      .first<{ id: string }>();
    await env.DB.prepare(
      "INSERT INTO project_access_grants (id, project_id, principal_type, user_id, role, created_at, updated_at) VALUES ('pag_1', ?, 'user', ?, 'viewer', 0, 0)",
    )
      .bind(s.project.id, userId!.id)
      .run();
    expect((await member.json(project)).status).toBe(200);
    const patch = await member.json(project, { method: "PATCH", json: { name: "Renamed" } });
    expect(patch.status).toBe(403);
  });
});
