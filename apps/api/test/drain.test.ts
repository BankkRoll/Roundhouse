/**
 * The node lifecycle (ADR 0005, "Node lifecycle"): draining a server moves
 * its stateless replicas elsewhere and ends in maintenance, volume services
 * block it unless forced, resume brings the server back; an offline server's
 * stateless replicas are rescheduled and its stateful services degraded;
 * and a deployment tolerates two placements for one replica during a move.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { createDb, deployments, nodes, placements, services } from "@roundhouse/db";
import { ACTIONS, AUDIT_ACTIONS, newId } from "@roundhouse/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MESH_ROUTES, policyOf } from "../src/contracts";
import { replicaStates } from "../src/durable/node-connection";
import { buildDesiredState, sealDeploymentEnv } from "../src/lib/desired-state";
import { recoverNodeServices, rescheduleOfflineNode } from "../src/lib/moves";
import { projectKey } from "../src/lib/variables";
import { batchMoves } from "../src/workflows/drain";
import { addMember, eventually } from "./helpers";
import { type MeshCluster, meshCluster } from "./mesh-helpers";
import { createProject, createService } from "./pipeline-helpers";

let introspector: { dispose(): Promise<void> } | undefined;
beforeEach(async () => {
  introspector = await introspectWorkflow(env.DRAIN_WORKFLOW);
});
afterEach(async () => {
  await introspector?.dispose();
});

/** Inserts an active deployment with one healthy replica per node given. */
async function liveDeployment(
  c: MeshCluster,
  projectId: string,
  serviceId: string,
  environmentId: string,
  nodeIds: string[],
) {
  const db = createDb(env.DB);
  const id = newId("deployment");
  const key = await projectKey(db, env, projectId);
  await db.insert(deployments).values({
    id,
    serviceId,
    environmentId,
    configVersion: 1,
    image: "nginx:1.27",
    status: "active",
    trigger: "manual",
    envSealed: await sealDeploymentEnv(
      key,
      { workspaceId: c.workspaceId, projectId, deploymentId: id },
      { env: {}, files: {} },
    ),
  });
  const workloadIds: string[] = [];
  for (const [replica, nodeId] of nodeIds.entries()) {
    const workloadId = newId("workload");
    workloadIds.push(workloadId);
    await db.insert(placements).values({
      id: newId("placement"),
      deploymentId: id,
      replica,
      nodeId,
      workloadId,
      state: "healthy",
    });
  }
  return { id, workloadIds };
}

async function drainStage() {
  const c = await meshCluster(2, { ready: true });
  const project = await createProject(c.owner, c.workspaceId);
  const environmentId = project.environments[0]!.id;
  const web = await createService(c.owner, project.id, {
    name: "web",
    source: { type: "image", image: "nginx:1.27" },
    config: { networking: { port: 8080 } },
  });
  const dbService = await createService(c.owner, project.id, {
    name: "db",
    source: { type: "image", image: "postgres:18" },
    config: { networking: { port: 5432 } },
  });
  const [n1, n2] = c.members.map((m) => m.id) as [string, string];
  const webDep = await liveDeployment(c, project.id, web.service.id, environmentId, [n1]);
  return { ...c, project, environmentId, web, dbService, n1, n2, webDep };
}

/** Makes a service stateful the way a database service is. */
async function makeStateful(serviceId: string) {
  await createDb(env.DB)
    .update(services)
    .set({ databaseEngine: "postgres", databaseVersion: "18" })
    .where(eq(services.id, serviceId));
}

type DrainBody = {
  drain: {
    status: string;
    moves: { workload_id: string; state: string; to_node_id: string | null }[];
    blocked: { service_name: string }[];
  } | null;
};

const drainPath = (s: { workspaceId: string }, nodeId: string) =>
  `/v1/workspaces/${s.workspaceId}/nodes/${nodeId}/drain`;

describe("drain", () => {
  it("moves stateless replicas to another server, then puts the server in maintenance", async () => {
    const s = await drainStage();
    const started = await s.owner.json<{ status: string; moves: unknown[] }>(drainPath(s, s.n1), {
      method: "POST",
      json: {},
    });
    expect(started.status).toBe(202);
    expect(started.body.status).toBe("running");

    const done = await eventually(async () => {
      const r = await s.owner.json<DrainBody>(drainPath(s, s.n1));
      return r.body.drain?.status === "completed" ? r.body.drain : undefined;
    }, 20_000);
    expect(done.moves).toEqual([
      expect.objectContaining({
        workload_id: s.webDep.workloadIds[0],
        state: "done",
        to_node_id: s.n2,
      }),
    ]);
    const db = createDb(env.DB);
    const rows = await db.select().from(placements).where(eq(placements.deploymentId, s.webDep.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nodeId: s.n2, state: "healthy" });
    const [node] = await db.select().from(nodes).where(eq(nodes.id, s.n1));
    expect(node!.status).toBe("maintenance");
    const [deployment] = await db.select().from(deployments).where(eq(deployments.id, s.webDep.id));
    expect(deployment!.status).toBe("active");
    const audit = await env.DB.prepare(
      "SELECT action FROM audit_logs WHERE action IN ('node.drain_started', 'node.drained') ORDER BY seq",
    ).all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toEqual(["node.drain_started", "node.drained"]);

    // Resume: schedulable again, nothing moves back.
    const resumed = await s.owner.json<{ status: string }>(
      `/v1/workspaces/${s.workspaceId}/nodes/${s.n1}/resume`,
      { method: "POST" },
    );
    expect(resumed.status).toBe(200);
    expect(resumed.body.status).toBe("online");
    expect(await db.select().from(placements).where(eq(placements.nodeId, s.n1))).toEqual([]);
  });

  it("stops at blocked for volume services unless forced", async () => {
    const s = await drainStage();
    await makeStateful(s.dbService.service.id);
    const dbDep = await liveDeployment(s, s.project.id, s.dbService.service.id, s.environmentId, [
      s.n1,
    ]);
    await s.owner.json(drainPath(s, s.n1), { method: "POST", json: {} });
    const blocked = await eventually(async () => {
      const r = await s.owner.json<DrainBody>(drainPath(s, s.n1));
      return r.body.drain?.status === "blocked" ? r.body.drain : undefined;
    }, 20_000);
    expect(blocked.blocked).toEqual([expect.objectContaining({ service_name: "db" })]);
    const db = createDb(env.DB);
    // Nothing moved; the node stays draining.
    expect(
      (await db.select().from(placements).where(eq(placements.deploymentId, s.webDep.id)))[0]!
        .nodeId,
    ).toBe(s.n1);

    const forced = await s.owner.json(drainPath(s, s.n1), {
      method: "POST",
      json: { force: true },
    });
    expect(forced.status).toBe(202);
    await eventually(async () => {
      const r = await s.owner.json<DrainBody>(drainPath(s, s.n1));
      return r.body.drain?.status === "completed" ? true : undefined;
    }, 20_000);
    const [parked] = await db
      .select()
      .from(placements)
      .where(eq(placements.deploymentId, dbDep.id));
    expect(parked!.state).toBe("parked");
    const [svc] = await db.select().from(services).where(eq(services.id, s.dbService.service.id));
    expect(svc).toMatchObject({ health: "degraded", healthReason: "node_maintenance" });
    // Parked replicas leave the node's desired state, so the agent stops them.
    const desired = await buildDesiredState(db, env, s.n1);
    expect(desired!.workloads.some((w) => w.id === dbDep.workloadIds[0])).toBe(false);
    const view = await s.owner.json<{ health: string; health_reason: string | null }>(
      `/v1/services/${s.dbService.service.id}`,
    );
    expect(view.body).toMatchObject({ health: "degraded", health_reason: "node_maintenance" });

    // Resume restarts it where its data is, and the service recovers.
    await s.owner.json(`/v1/workspaces/${s.workspaceId}/nodes/${s.n1}/resume`, { method: "POST" });
    const [back] = await db.select().from(placements).where(eq(placements.deploymentId, dbDep.id));
    expect(back!.state).not.toBe("parked");
    const [healed] = await db
      .select()
      .from(services)
      .where(eq(services.id, s.dbService.service.id));
    expect(healed).toMatchObject({ health: "ok", healthReason: null });
  });

  it("refuses a second drain while one runs, and resume of a server in service", async () => {
    const s = await drainStage();
    // Nowhere to go: the drain stays running until its replacement settles.
    await createDb(env.DB).update(nodes).set({ status: "maintenance" }).where(eq(nodes.id, s.n2));
    await s.owner.json(drainPath(s, s.n1), { method: "POST", json: {} });
    const failed = await eventually(async () => {
      const r = await s.owner.json<DrainBody>(drainPath(s, s.n1));
      return r.body.drain?.status === "failed" ? r.body.drain : undefined;
    }, 20_000);
    expect(failed.moves[0]).toMatchObject({ state: "failed", to_node_id: null });
    const notDraining = await s.owner.json<{ error: { code: string } }>(
      `/v1/workspaces/${s.workspaceId}/nodes/${s.n2}/resume`,
      { method: "POST" },
    );
    expect(notDraining.status).toBe(200);
    const online = await s.owner.json<{ error: { code: string } }>(
      `/v1/workspaces/${s.workspaceId}/nodes/${s.n2}/resume`,
      { method: "POST" },
    );
    expect(online.status).toBe(409);
    expect(online.body.error.code).toBe("node_not_draining");
  });

  it("lets only managers drain and resume, and viewers read progress", async () => {
    const s = await drainStage();
    const viewer = await addMember(s.owner, s.workspaceId, "vi@example.com", "viewer");
    const member = await addMember(s.owner, s.workspaceId, "me@example.com", "member");
    expect((await viewer.json(drainPath(s, s.n1))).status).toBe(200);
    expect((await member.json(drainPath(s, s.n1), { method: "POST", json: {} })).status).toBe(403);
    expect(
      (
        await viewer.json(`/v1/workspaces/${s.workspaceId}/nodes/${s.n1}/resume`, {
          method: "POST",
        })
      ).status,
    ).toBe(403);
    expect((await s.owner.json(drainPath(s, "node_missing"))).status).toBe(404);
    for (const r of [MESH_ROUTES.drainNode, MESH_ROUTES.getNodeDrain, MESH_ROUTES.resumeNode]) {
      const p = policyOf(r);
      expect(ACTIONS).toContain(p.action);
      for (const a of p.audit) expect(AUDIT_ACTIONS).toContain(a);
    }
    expect(policyOf(MESH_ROUTES.drainNode).audit).toEqual(["node.drain_started"]);
    expect(policyOf(MESH_ROUTES.resumeNode).audit).toEqual(["node.resumed"]);
  });

  it("batches moves four at a time, never two of one service", () => {
    const m = (workloadId: string, serviceId: string) => ({ workloadId, serviceId });
    expect(
      batchMoves([
        m("w1", "a"),
        m("w2", "a"),
        m("w3", "b"),
        m("w4", "c"),
        m("w5", "d"),
        m("w6", "e"),
      ]),
    ).toEqual([
      ["w1", "w3", "w4", "w5"],
      ["w2", "w6"],
    ]);
  });
});

describe("offline rescheduling", () => {
  it("replaces stateless replicas, degrades stateful services, and cleans up once healthy", async () => {
    const s = await drainStage();
    await makeStateful(s.dbService.service.id);
    await liveDeployment(s, s.project.id, s.dbService.service.id, s.environmentId, [s.n1]);
    const db = createDb(env.DB);
    await db.update(nodes).set({ status: "offline" }).where(eq(nodes.id, s.n1));

    const out = await rescheduleOfflineNode(env, db, s.n1);
    expect(out).toEqual({ moved: 1, unplaced: 0, degraded: 1 });
    // Once per outage.
    expect(await rescheduleOfflineNode(env, db, s.n1)).toEqual({
      moved: 0,
      unplaced: 0,
      degraded: 0,
    });
    const [svc] = await db.select().from(services).where(eq(services.id, s.dbService.service.id));
    expect(svc).toMatchObject({ health: "degraded", healthReason: "node_offline" });

    // The replacement on n2 reports healthy (the fake agent does), and the
    // lost row goes away.
    const rows = await eventually(async () => {
      const r = await db.select().from(placements).where(eq(placements.deploymentId, s.webDep.id));
      return r.length === 1 && r[0]!.nodeId === s.n2 && r[0]!.state === "healthy" ? r : undefined;
    }, 10_000);
    expect(rows[0]!.replacesWorkloadId).toBe(s.webDep.workloadIds[0]);

    expect(await recoverNodeServices(env, db, s.n1, ["node_offline"])).toEqual([
      s.dbService.service.id,
    ]);
    const audit = await env.DB.prepare(
      "SELECT action FROM audit_logs WHERE action IN ('service.degraded', 'service.recovered') ORDER BY seq",
    ).all<{ action: string }>();
    expect(audit.results.map((r) => r.action)).toEqual(["service.degraded", "service.recovered"]);
  });

  it("keeps a lost replica out of desired state and the mesh", async () => {
    const s = await drainStage();
    const db = createDb(env.DB);
    await db
      .update(placements)
      .set({ state: "lost" })
      .where(eq(placements.workloadId, s.webDep.workloadIds[0]!));
    const desired = await buildDesiredState(db, env, s.n1);
    expect(desired!.workloads.some((w) => w.id === s.webDep.workloadIds[0])).toBe(false);
    const peer = await buildDesiredState(db, env, s.n2);
    expect(peer!.mesh?.addresses ?? []).toEqual([]);
  });
});

describe("replica states during a move", () => {
  it("counts a replica healthy when either of its rows is, bad only when all are", () => {
    expect(
      replicaStates([
        { replica: 0, state: "healthy" },
        { replica: 0, state: "pending" },
        { replica: 1, state: "crashed" },
        { replica: 1, state: "starting" },
        { replica: 2, state: "lost" },
      ]),
    ).toEqual(["healthy", "starting"]);
    expect(replicaStates([{ replica: 0, state: "crashed" }])).toEqual(["crashed"]);
  });
});
