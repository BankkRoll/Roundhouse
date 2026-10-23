/**
 * Agent protocol handling in the node's Durable Object: version gating, desired
 * state computed from D1 on every (re)connect, workload statuses scoped to
 * the reporting node, build results, credential TTLs, and frame limits.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import {
  CREDENTIAL_FRAME_TTL_MS,
  type DesiredState,
  MAX_AGENT_FRAME_BYTES,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "@openrail/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloseCode } from "../src/durable/node-connection";
import { connectAgent, hello, install, joinNode } from "./helpers";
import {
  COMMIT_SHA,
  connectWorkloadAgent,
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

const nodeStub = (nodeId: string) =>
  env.NODE_CONNECTION.get(env.NODE_CONNECTION.idFromName(nodeId));

describe("protocol versions", () => {
  it("accepts pre-sealing agents but sends them no workloads, registry or builds", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const agent = await connectWorkloadAgent(
      joined,
      {},
      { protocol_version: MIN_PROTOCOL_VERSION },
    );
    const desired = agent.desired()!;
    expect(desired.workloads).toEqual([]);
    expect(desired.registry).toBeNull();
    const row = await env.DB.prepare("SELECT protocol_version FROM nodes WHERE id = ?")
      .bind(joined.node_id)
      .first<{ protocol_version: number }>();
    expect(row?.protocol_version).toBe(MIN_PROTOCOL_VERSION);

    const result = await nodeStub(joined.node_id).sendBuildJob({
      build_id: "bld_x",
      deployment_id: "dep_x",
      project_id: "prj_x",
      service_id: "svc_x",
      source: { type: "git", url: "https://github.com/a/b", commit_sha: COMMIT_SHA },
      builder: "railpack",
      context_dir: ".",
      build_args: {},
      image_repository: "127.0.0.1:5000/prj_x/svc_x",
      cache_key: "prj_x.svc_x",
      timeout_s: 600,
    });
    expect(result).toEqual({ sent: false, reason: "protocol_too_old" });
    expect(agent.received.some((m) => m.type === "build_job")).toBe(false);
  });

  it("never places workloads on a node without an encryption key", async () => {
    const s = await stage();
    const keyless = await joinNode(s.owner, s.workspaceId, {
      name: "keyless-1",
      encryption_public_key: undefined,
    });
    const agent = await connectWorkloadAgent(keyless);
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const active = await waitForStatus(s.owner, d.id, ["active"]);
    expect(active.placements!.every((p) => p.node_id === s.joined.node_id)).toBe(true);
    expect(agent.received.filter(isDesired).every((m) => m.workloads.length === 0)).toBe(true);
    expect(agent.desired()!.registry).toBeNull();
  });

  // TODO(api-secrets-crypto): a signed hello.encryption_key registers a key
  // once for a node that has none, and is ignored when one is stored.
  it.todo("registers a signed encryption key from hello, once");

  it("never places workloads on a pre-sealing node", async () => {
    const s = await stage();
    const old = await joinNode(s.owner, s.workspaceId, { name: "old-1" });
    const v3 = await connectWorkloadAgent(old, {}, { protocol_version: MIN_PROTOCOL_VERSION });
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const active = await waitForStatus(s.owner, d.id, ["active"]);
    expect(active.placements!.every((p) => p.node_id === s.joined.node_id)).toBe(true);
    expect(v3.received.filter(isDesired).every((m) => m.workloads.length === 0)).toBe(true);
  });

  it.each([0, PROTOCOL_VERSION + 1])("rejects protocol version %i", async (version) => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const agent = await connectAgent(joined);
    agent.send(hello(joined.node_id, { protocol_version: version }));
    expect((await agent.closed).code).toBe(CloseCode.policy);
  });

  it.each([1, MIN_PROTOCOL_VERSION - 1])(
    "tells a version %i agent it is outdated",
    async (version) => {
      const { owner, workspaceId } = await install();
      const joined = await joinNode(owner, workspaceId);
      const agent = await connectAgent(joined);
      agent.send(hello(joined.node_id, { protocol_version: version }));
      expect(await agent.closed).toEqual({
        code: CloseCode.agentOutdated,
        reason: "agent_outdated",
      });
    },
  );

  it("gives builder nodes a registry and others none", async () => {
    const { owner, workspaceId } = await install();
    const builder = await connectWorkloadAgent(await joinNode(owner, workspaceId));
    const worker = await connectWorkloadAgent(
      await joinNode(owner, workspaceId, { name: "w-1" }),
      {},
      { capabilities: { docker: true, gvisor: false, builder: false } },
    );
    expect(builder.desired()!.registry).toEqual({
      listen: "127.0.0.1:5000",
      storage: { type: "filesystem" },
    });
    expect(worker.desired()!.registry).toBeNull();
    expect(builder.desired()!.tls_mode).toBe("acme");
    expect(builder.desired()!.apps_domain).toBeNull();
  });
});

describe("desired state", () => {
  it("is recomputed from D1 on reconnect, with the same workloads", async () => {
    const s = await stage();
    const d = await deploy(s.owner, s.serviceId, s.envId);
    await waitForStatus(s.owner, d.id, ["active"]);
    const before = s.agent.desired()!;
    s.agent.ws.close();
    const again = await connectWorkloadAgent(s.joined);
    const after = again.desired()!;
    // env_sealed is re-sealed for every frame; what it carries must not change.
    const unsealed = (m: typeof before) => m.workloads.map(({ env_sealed: _, ...w }) => w);
    expect(unsealed(after)).toEqual(unsealed(before));
    for (const w of after.workloads) expect(again.env(w.id)).toEqual(s.agent.env(w.id));
    expect(after.generation).toBe(before.generation);
    expect(after.workloads[0]!.spec_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is resent after every hello, even when the agent reports it already applied it", async () => {
    const s = await stage();
    const d = await deploy(s.owner, s.serviceId, s.envId);
    await waitForStatus(s.owner, d.id, ["active"]);
    const before = s.agent.desired()!;
    s.agent.ws.close();
    // A restarted agent keeps no desired state on disk (it holds secrets),
    // so an up-to-date generation must not suppress the frame.
    const again = await connectWorkloadAgent(
      s.joined,
      {},
      { observed_generation: before.generation },
    );
    expect(again.desired()!.generation).toBe(before.generation);
    expect(again.desired()!.workloads.map((w) => w.id)).toEqual(before.workloads.map((w) => w.id));
  });

  it("keeps the old replica listed until the new one is healthy", async () => {
    const s = await stage();
    const first = await deploy(s.owner, s.serviceId, s.envId);
    await waitForStatus(s.owner, first.id, ["active"]);
    s.agent.behaviour.health = "silent";
    const second = await deploy(s.owner, s.serviceId, s.envId);
    await s.agent.waitFor(
      (m): m is DesiredState =>
        m.type === "desired_state" && m.workloads.some((w) => w.deployment_id === second.id),
    );
    expect(
      s.agent
        .desired()!
        .workloads.map((w) => w.deployment_id)
        .sort(),
    ).toEqual([first.id, second.id].sort());
  });

  it("sends on_failure with 0 retries as never, since 0 means unlimited to the agent", async () => {
    const s = await stage({
      name: "once",
      source: { type: "image", image: "busybox:1.36" },
      config: { deploy: { restart_policy: "on_failure", max_retries: 0 } },
    });
    const d = await deploy(s.owner, s.serviceId, s.envId);
    await waitForStatus(s.owner, d.id, ["active"]);
    expect(s.agent.desired()!.workloads[0]!.restart).toEqual({ policy: "never", max_retries: 0 });
  });

  it("applies hello statuses after a reconnect", async () => {
    const s = await stage();
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const active = await waitForStatus(s.owner, d.id, ["active"]);
    const wl = active.placements![0]!.workload_id;
    s.agent.ws.close();
    await connectWorkloadAgent(
      s.joined,
      { health: "silent" },
      {
        statuses: [
          {
            workload_id: wl,
            deployment_id: d.id,
            state: "crashed",
            exit_code: 137,
            restarts: 3,
            ts: Date.now(),
          },
          {
            workload_id: "sys_registry",
            deployment_id: null,
            state: "healthy",
            restarts: 0,
            ts: Date.now(),
          },
        ],
      },
    );
    const crashed = await waitForStatus(s.owner, d.id, ["crashed"]);
    expect(crashed.placements![0]!.state).toBe("crashed");
  });

  it("ignores statuses for replicas placed on another node", async () => {
    const s = await stage();
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const active = await waitForStatus(s.owner, d.id, ["active"]);
    const intruder = await connectWorkloadAgent(
      await joinNode(s.owner, s.workspaceId, { name: "evil" }),
    );
    intruder.send({
      type: "workload_status",
      workload_id: active.placements![0]!.workload_id,
      deployment_id: d.id,
      state: "crashed",
      restarts: 0,
      ts: Date.now(),
    });
    // A heartbeat round trip proves the frame was processed.
    intruder.send({
      type: "heartbeat",
      seq: 1,
      ts: Date.now(),
      observed_generation: 0,
      usage: {
        cpu_percent: 1,
        mem_used_bytes: 1,
        mem_total_bytes: 2,
        disk_used_bytes: 1,
        disk_total_bytes: 2,
        load1: 0,
      },
    });
    await new Promise((r) => setTimeout(r, 200));
    const after = await s.owner.json<DeploymentBody>(`/v1/deployments/${d.id}`);
    expect(after.body.status).toBe("active");
    expect(after.body.placements![0]!.state).toBe("healthy");
  });
});

describe("builds", () => {
  it("rejects a build result that pushed to another repository", async () => {
    const s = await stage(GIT_SERVICE, { build: "silent" });
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    const job = await s.agent.waitFor((m) => m.type === "build_job");
    if (job.type !== "build_job") throw new Error("unreachable");
    s.agent.send({
      type: "build_result",
      build_id: job.build_id,
      ok: true,
      image: {
        repository: "127.0.0.1:5000/prj_other/svc_other",
        digest: `sha256:${"b".repeat(64)}`,
      },
      duration_ms: 1,
    });
    const failed = await waitForStatus(s.owner, d.id, ["failed"]);
    expect(failed.failure_reason).toMatch(/expected 127\.0\.0\.1:5000\//);
  });

  it("ignores build results from a node the build wasn't sent to", async () => {
    const s = await stage(GIT_SERVICE, { build: "silent" });
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    const job = await s.agent.waitFor((m) => m.type === "build_job");
    if (job.type !== "build_job") throw new Error("unreachable");
    const other = await connectWorkloadAgent(
      await joinNode(s.owner, s.workspaceId, { name: "b-2" }),
    );
    other.send({
      type: "build_result",
      build_id: job.build_id,
      ok: false,
      error: "nope",
      duration_ms: 1,
    });
    await new Promise((r) => setTimeout(r, 300));
    const still = await s.owner.json<DeploymentBody>(`/v1/deployments/${d.id}`);
    expect(still.body.status).toBe("building");
    expect(job.exp - job.iat).toBe(CREDENTIAL_FRAME_TTL_MS);
  });
});

describe("frame limits", () => {
  it("closes on a frame over the protocol's size limit", async () => {
    const s = await stage();
    s.agent.send(
      JSON.stringify({
        type: "logs",
        source: { type: "build", build_id: "bld_x" },
        lines: [{ ts: 1, stream: "stdout", text: "x".repeat(MAX_AGENT_FRAME_BYTES) }],
      }),
    );
    expect((await s.agent.closed).code).toBe(CloseCode.tooBig);
  });

  it("drops frames over the per-type rate and closes persistent floods", async () => {
    const s = await stage();
    for (let i = 0; i < 600; i++) {
      s.agent.send({
        type: "build_result",
        build_id: "bld_nothing",
        ok: false,
        error: "x",
        duration_ms: 1,
      });
    }
    const closed = await s.agent.closed;
    expect(closed).toMatchObject({ code: CloseCode.policy, reason: "build_result rate exceeded" });
  });

  it("closes on an invalid status frame", async () => {
    const s = await stage();
    s.agent.send({ type: "workload_status", workload_id: "not an id", state: "healthy" });
    expect((await s.agent.closed).code).toBe(CloseCode.policy);
  });
});
