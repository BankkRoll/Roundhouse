/**
 * Database services and volumes (ADR 0004): adding a database through a
 * change set (write-only generated credentials, reference-valued connection
 * variables, a volume per environment), RBAC and environment protection,
 * the replica rule, desired state (volumes, mounts, stop-first, the exec
 * probe, the spec hash), scheduler pinning, `volume_status` ingest, and the
 * volume routes with the grace-period deletion the minute tick sends.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import {
  type ControlMessage,
  computeSpecHash,
  type DesiredState,
  VOLUMES_PROTOCOL_VERSION,
  type VolumeDelete,
} from "@roundhouse/protocol";
import { ACTIONS, AUDIT_ACTIONS, VOLUME_DELETE_GRACE_MS } from "@roundhouse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DATABASE_ROUTES,
  PHASE1_ROUTES,
  POLICY_KEY,
  policyOf,
  type RoutePolicy,
} from "../src/contracts";
import { app } from "../src/index";
import { claimVolumeDeletions, controlStatusOf } from "../src/lib/volumes";
import { addMember, type Client, eventually, install, joinNode } from "./helpers";
import {
  connectWorkloadAgent,
  createProject,
  deploy,
  type FakeWorkloadAgent,
  settleDeployments,
  waitForStatus,
} from "./pipeline-helpers";

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
beforeEach(async () => {
  introspector = await introspectWorkflow(env.DEPLOY_WORKFLOW);
});
afterEach(async () => {
  await settleDeployments();
  await introspector?.dispose();
});

interface Created {
  change_set_id: string;
  service: { id: string; slug: string; kind: string };
  engine: string;
  version: string;
  volumes: {
    id: string;
    environment_id: string;
    status: string;
    node_id: string | null;
    size_mb: number;
    mount_path: string;
  }[];
  variables: { key: string; secret: boolean }[];
  deployment_ids: string[];
}

function addDatabase(c: Client, projectId: string, body: Record<string, unknown>) {
  return c.json<Created & { error: { code: string; message: string } }>(
    `/v1/projects/${projectId}/databases`,
    { method: "POST", json: { engine: "postgres", deploy: false, ...body } },
  );
}

async function volumeRow(id: string) {
  return env.DB.prepare("SELECT * FROM volumes WHERE id = ?").bind(id).first<{
    status: string;
    node_id: string | null;
    used_bytes: number | null;
    quota_mode: string | null;
    delete_after: number | null;
    delete_sent_at: number | null;
    size_mb: number;
  }>();
}

const isDesired = (m: ControlMessage): m is DesiredState => m.type === "desired_state";

/** Installs, connects a protocol 5 agent and creates a project with a staging environment. */
async function dataStage() {
  const installed = await install();
  const { owner, workspaceId } = installed;
  const joined = await joinNode(owner, workspaceId);
  const agent = await connectWorkloadAgent(
    joined,
    {},
    { protocol_version: VOLUMES_PROTOCOL_VERSION },
  );
  const project = await createProject(owner, workspaceId);
  const envId = project.environments[0]!.id;
  return { ...installed, joined, agent, project, envId };
}

/** The latest desired state holding a workload of `deploymentId`. */
function desiredWith(agent: FakeWorkloadAgent, deploymentId: string) {
  return agent.waitFor(
    (m): m is DesiredState =>
      isDesired(m) && m.workloads.some((w) => w.deployment_id === deploymentId),
  );
}

describe("database contracts", () => {
  const routes = Object.entries(DATABASE_ROUTES) as [
    string,
    RouteConfig & { [POLICY_KEY]: RoutePolicy },
  ][];

  it("serves every route with a valid policy, auditing only mutations", () => {
    const live = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } });
    const taken = new Set(Object.values(PHASE1_ROUTES).map((r) => `${r.method} ${r.path}`));
    for (const [name, route] of routes) {
      const op = (live.paths?.[route.path] as Record<string, Record<string, unknown>>)?.[
        route.method
      ];
      expect(op?.[POLICY_KEY], name).toEqual(policyOf(route));
      expect(ACTIONS).toContain(policyOf(route).action);
      for (const a of policyOf(route).audit) expect(AUDIT_ACTIONS).toContain(a);
      if (route.method === "get") expect(policyOf(route).audit, name).toEqual([]);
      expect(taken.has(`${route.method} ${route.path}`), name).toBe(false);
    }
    const router = new OpenAPIHono();
    for (const [, r] of routes) router.openapi(r, (c) => c.body(null, 204) as never);
    const doc = router.getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "t", version: "0" },
    });
    expect(Object.keys(doc.paths ?? {})).toHaveLength(4);
  });

  it("maps node reports onto control statuses without overriding control-owned ones", () => {
    expect(controlStatusOf("pending", "ready")).toBe("ready");
    expect(controlStatusOf("ready", "creating")).toBe("pending");
    expect(controlStatusOf("ready", "orphaned")).toBe("ready");
    expect(controlStatusOf("pending_deletion", "ready")).toBe("pending_deletion");
    expect(controlStatusOf("pending_deletion", "deleted")).toBe("deleted");
    expect(controlStatusOf("ready", "deleted")).toBe("error");
    expect(controlStatusOf("migrating", "error")).toBe("migrating");
  });
});

describe("adding a database", () => {
  it("creates the service, a volume per environment and write-only credentials", async () => {
    const { owner, workspaceId } = await install();
    const project = await createProject(owner, workspaceId);
    const prod = project.environments[0]!.id;
    const staging = await owner.json<{ id: string }>(`/v1/projects/${project.id}/environments`, {
      method: "POST",
      json: { name: "staging", kind: "staging" },
    });
    const res = await addDatabase(owner, project.id, { environment_id: prod, size_mb: 1024 });
    expect(res.status).toBe(201);
    expect(res.body.service).toMatchObject({ kind: "database", slug: "postgresql" });
    expect(res.body).toMatchObject({ engine: "postgres", version: "18", deployment_ids: [] });
    expect(res.body.volumes.map((v) => v.environment_id).sort()).toEqual(
      [prod, staging.body.id].sort(),
    );
    for (const v of res.body.volumes) {
      expect(v).toMatchObject({
        status: "pending",
        node_id: null,
        size_mb: 1024,
        mount_path: "/var/lib/postgresql",
      });
    }
    expect(res.body.variables).toEqual(
      expect.arrayContaining([
        { key: "POSTGRES_PASSWORD", secret: true },
        { key: "ROUNDHOUSE_RO_PASSWORD", secret: true },
        { key: "DATABASE_URL", secret: true },
        { key: "POSTGRES_USER", secret: false },
      ]),
    );

    const service = await env.DB.prepare(
      "SELECT database_engine, database_version FROM services WHERE id = ?",
    )
      .bind(res.body.service.id)
      .first();
    expect(service).toEqual({ database_engine: "postgres", database_version: "18" });

    const listed = await owner.json<{
      variables: { key: string; tier: string; value: string | null }[];
    }>(`/v1/services/${res.body.service.id}/variables?environment_id=${prod}`);
    const byKey = new Map(listed.body.variables.map((v) => [v.key, v]));
    expect(byKey.get("POSTGRES_PASSWORD")).toMatchObject({ tier: "secret", value: null });
    expect(byKey.get("DATABASE_URL")).toMatchObject({ tier: "secret", value: null });
    expect(byKey.get("POSTGRES_USER")).toMatchObject({ tier: "plain", value: "postgres" });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: variable-reference syntax.
    expect(byKey.get("PGUSER")!.value).toBe("${{POSTGRES_USER}}");

    // Each environment gets its own credentials.
    const secrets = await env.DB.prepare(
      "SELECT environment_id, fingerprint FROM variables WHERE service_id = ? AND key = 'POSTGRES_PASSWORD'",
    )
      .bind(res.body.service.id)
      .all<{ fingerprint: string }>();
    expect(secrets.results).toHaveLength(2);
    expect(secrets.results[0]!.fingerprint).not.toBe(secrets.results[1]!.fingerprint);

    // No audit entry carries a value: only keys.
    const audit = await env.DB.prepare(
      "SELECT action, metadata FROM audit_logs WHERE workspace_id = ? ORDER BY id",
    )
      .bind(workspaceId)
      .all<{ action: string; metadata: string }>();
    const actions = audit.results.map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "change_set.created",
        "service.created",
        "variables.updated",
        "change_set.applied",
      ]),
    );
    for (const a of audit.results) {
      expect(a.metadata ?? "").not.toMatch(/postgresql:\/\/|[A-Za-z0-9_-]{43}/);
    }
  });

  it("refuses an unknown version, more than one replica, and bad sizes", async () => {
    const { owner, workspaceId } = await install();
    const project = await createProject(owner, workspaceId);
    const prod = project.environments[0]!.id;
    expect(
      (await addDatabase(owner, project.id, { environment_id: prod, version: "9" })).status,
    ).toBe(404);
    expect(
      (await addDatabase(owner, project.id, { environment_id: prod, size_mb: 10 })).status,
    ).toBe(400);
    const ok = await addDatabase(owner, project.id, {
      environment_id: prod,
      engine: "redis",
      name: "Cache",
    });
    expect(ok.status).toBe(201);
    const scaled = await owner.json<{ error: { code: string } }>(
      `/v1/services/${ok.body.service.id}`,
      { method: "PATCH", json: { environment_id: prod, deploy: { replicas: 2 } } },
    );
    expect(scaled.status).toBe(422);
    expect(scaled.body.error.code).toBe("volume_requires_single_replica");
    const staged = await owner.json<{ error: { code: string } }>(
      `/v1/environments/${prod}/change-sets`,
      {
        method: "POST",
        json: {
          ops: [
            {
              type: "config.patch",
              service: ok.body.service.id,
              patch: { deploy: { replicas: 3 } },
            },
          ],
        },
      },
    );
    expect(staged.status).toBe(422);
  });

  it("needs services:manage, variables:manage and deployments:create, protection included", async () => {
    const { owner, workspaceId } = await install();
    const project = await createProject(owner, workspaceId);
    const prod = project.environments[0]!.id;
    const viewer = await addMember(owner, workspaceId, "v@example.com", "viewer");
    expect((await addDatabase(viewer, project.id, { environment_id: prod })).status).toBe(403);
    const member = await addMember(owner, workspaceId, "dev@example.com", "member");
    await env.DB.prepare("UPDATE environments SET protected = 1 WHERE id = ?").bind(prod).run();
    const refused = await addDatabase(member, project.id, { environment_id: prod });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toContain("variables:manage");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM services").first<{ n: number }>();
    expect(count!.n).toBe(0);
    expect((await addDatabase(owner, project.id, { environment_id: prod })).status).toBe(201);
  });

  it("stages and applies a database op through a change set", async () => {
    const { owner, workspaceId } = await install();
    const project = await createProject(owner, workspaceId);
    const prod = project.environments[0]!.id;
    const created = await owner.json<{ id: string; revision: number }>(
      `/v1/environments/${prod}/change-sets`,
      {
        method: "POST",
        json: {
          ops: [
            {
              type: "service.create",
              ref: "new:1",
              name: "Main DB",
              database: { engine: "mysql" },
            },
          ],
        },
      },
    );
    expect(created.status).toBe(201);
    const applied = await owner.json(`/v1/change-sets/${created.body.id}/apply`, {
      method: "POST",
      json: { expected_revision: created.body.revision, deploy: "none" },
    });
    expect(applied.status).toBe(200);
    const svc = await env.DB.prepare(
      "SELECT id, kind, database_engine FROM services WHERE name = 'Main DB'",
    ).first<{ id: string; kind: string; database_engine: string }>();
    expect(svc).toMatchObject({ kind: "database", database_engine: "mysql" });
    const vols = await env.DB.prepare("SELECT mount_path FROM volumes WHERE service_id = ?")
      .bind(svc!.id)
      .all();
    expect(vols.results).toEqual([{ mount_path: "/var/lib/mysql" }]);
  });
});

describe("deploying a database", () => {
  it("places it with its volume, mounts it, stops first, and probes with exec", async () => {
    const s = await dataStage();
    const created = await addDatabase(s.owner, s.project.id, { environment_id: s.envId });
    const d = await deploy(s.owner, created.body.service.id, s.envId);
    await waitForStatus(s.owner, d.id, ["active"]);
    const volume = created.body.volumes[0]!;
    expect((await volumeRow(volume.id))!.node_id).toBe(s.joined.node_id);

    const desired = await desiredWith(s.agent, d.id);
    expect(desired.volumes).toEqual([
      {
        id: volume.id,
        size_mb: 5120,
        project_id: s.project.id,
        environment_id: s.envId,
        service_id: created.body.service.id,
        owner: null,
      },
    ]);
    const w = desired.workloads.find((x) => x.deployment_id === d.id)!;
    expect(w.mounts).toEqual([
      { volume_id: volume.id, path: "/var/lib/postgresql", read_only: false },
    ]);
    expect(w.rollout).toBe("stop_first");
    expect(w.stop_grace_s).toBe(60);
    expect(w.healthcheck).toMatchObject({ type: "exec", interval_s: 5, retries: 6 });
    expect(w.healthcheck!.command!.join(" ")).toContain("pg_isready");
    expect(w.image).toMatch(/^postgres:18-bookworm@sha256:[0-9a-f]{64}$/);
    const { spec_hash, ...rest } = w;
    expect(spec_hash).toBe(await computeSpecHash(rest));
    expect(await computeSpecHash({ ...rest, rollout: "start_first", stop_grace_s: 1 })).toBe(
      spec_hash,
    );
    expect(await computeSpecHash({ ...rest, mounts: undefined })).not.toBe(spec_hash);

    // Opened env carries the credentials, resolved; nothing else does.
    const opened = s.agent.env(w.id)!;
    expect(opened.POSTGRES_PASSWORD).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(opened.DATABASE_URL).toBe(
      `postgresql://postgres:${opened.POSTGRES_PASSWORD}@${opened.ROUNDHOUSE_PRIVATE_DOMAIN}:5432/app`,
    );
    expect(s.agent.rejected).toEqual([]);
  });

  it("pins later deployments to the volume's node and fails while it is offline", async () => {
    const s = await dataStage();
    const created = await addDatabase(s.owner, s.project.id, { environment_id: s.envId });
    const first = await deploy(s.owner, created.body.service.id, s.envId);
    await waitForStatus(s.owner, first.id, ["active"]);

    // A second, roomier node never takes the pinned replica.
    const other = await joinNode(s.owner, s.workspaceId, {
      name: "hel-2",
      hostname: "hel-2",
      public_key: "8b1UZq3c8oE5Vb7m2D9qXhK0cR6tYw4nJ1sL5aF3eGc=",
    });
    await connectWorkloadAgent(other, {}, { protocol_version: VOLUMES_PROTOCOL_VERSION });
    const second = await deploy(s.owner, created.body.service.id, s.envId);
    const active = await waitForStatus(s.owner, second.id, ["active"]);
    expect(active.placements!.map((p) => p.node_id)).toEqual([s.joined.node_id]);

    await env.DB.prepare("UPDATE nodes SET status = 'offline' WHERE id = ?")
      .bind(s.joined.node_id)
      .run();
    const third = await deploy(s.owner, created.body.service.id, s.envId);
    const failed = await waitForStatus(s.owner, third.id, ["failed"]);
    expect(failed.failure_reason).toContain("volume lives on node hel-1 (offline)");
  });

  it("keeps volume services off agents older than the volumes protocol", async () => {
    const installed = await install();
    const joined = await joinNode(installed.owner, installed.workspaceId);
    await connectWorkloadAgent(joined);
    const project = await createProject(installed.owner, installed.workspaceId);
    const envId = project.environments[0]!.id;
    const created = await addDatabase(installed.owner, project.id, { environment_id: envId });
    const d = await deploy(installed.owner, created.body.service.id, envId);
    const failed = await waitForStatus(installed.owner, d.id, ["failed"]);
    expect(failed.failure_reason).toContain("agent outdated");
  });
});

describe("volumes", () => {
  it("ingests volume_status for its own node only", async () => {
    const s = await dataStage();
    const created = await addDatabase(s.owner, s.project.id, { environment_id: s.envId });
    const d = await deploy(s.owner, created.body.service.id, s.envId);
    await waitForStatus(s.owner, d.id, ["active"]);
    const volumeId = created.body.volumes[0]!.id;
    s.agent.send({
      type: "volume_status",
      volumes: [
        {
          volume_id: volumeId,
          state: "ready",
          size_bytes: 5120 * 2 ** 20,
          used_bytes: 42 * 2 ** 20,
          quota: "loop",
        },
      ],
    });
    const row = await eventually(async () => {
      const r = await volumeRow(volumeId);
      return r?.status === "ready" ? r : undefined;
    });
    expect(row).toMatchObject({ used_bytes: 42 * 2 ** 20, quota_mode: "loop" });

    const got = await s.owner.json<{ status: string; node_name: string; used_bytes: number }>(
      `/v1/services/${created.body.service.id}/volume?environment_id=${s.envId}`,
    );
    expect(got.body).toMatchObject({
      status: "ready",
      node_name: "hel-1",
      used_bytes: 42 * 2 ** 20,
    });

    // Another node can't touch it.
    const other = await joinNode(s.owner, s.workspaceId, {
      name: "hel-2",
      hostname: "hel-2",
      public_key: "8b1UZq3c8oE5Vb7m2D9qXhK0cR6tYw4nJ1sL5aF3eGc=",
    });
    const rogue = await connectWorkloadAgent(
      other,
      {},
      { protocol_version: VOLUMES_PROTOCOL_VERSION },
    );
    rogue.send({
      type: "volume_status",
      volumes: [
        { volume_id: volumeId, state: "deleted", size_bytes: 0, used_bytes: 0, quota: "none" },
      ],
    });
    rogue.send({
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
    expect((await volumeRow(volumeId))!.status).toBe("ready");
  });

  it("grows only, deletes after a grace period, and undeletes", async () => {
    const s = await dataStage();
    const created = await addDatabase(s.owner, s.project.id, { environment_id: s.envId });
    const volumeId = created.body.volumes[0]!.id;
    const d = await deploy(s.owner, created.body.service.id, s.envId);
    await waitForStatus(s.owner, d.id, ["active"]);

    const shrink = await s.owner.json<{ error: { code: string } }>(`/v1/volumes/${volumeId}`, {
      method: "PATCH",
      json: { size_mb: 1024 },
    });
    expect(shrink.status).toBe(422);
    expect(shrink.body.error.code).toBe("volume_shrink_unsupported");
    const grow = await s.owner.json<{ size_mb: number }>(`/v1/volumes/${volumeId}`, {
      method: "PATCH",
      json: { size_mb: 8192 },
    });
    expect(grow.status).toBe(200);
    await s.agent.waitFor(
      (m): m is DesiredState => isDesired(m) && m.volumes?.[0]?.size_mb === 8192,
    );

    // A volume still mounted can't be deleted.
    expect((await s.owner.json(`/v1/volumes/${volumeId}`, { method: "DELETE" })).status).toBe(409);
    const member = await addMember(s.owner, s.workspaceId, "deployer@example.com", "member");
    await env.DB.prepare(
      "UPDATE workspaces SET member_default_project_role = 'deployer' WHERE id = ?",
    )
      .bind(s.workspaceId)
      .run();
    expect((await member.json(`/v1/volumes/${volumeId}`, { method: "DELETE" })).status).toBe(403);

    await s.owner.json(`/v1/services/${created.body.service.id}`, { method: "DELETE" });
    const pending = await volumeRow(volumeId);
    expect(pending!.status).toBe("pending_deletion");
    expect(pending!.delete_after).toBeGreaterThan(Date.now() + VOLUME_DELETE_GRACE_MS - 60_000);

    // Not yet due: nothing is sent.
    expect(await claimVolumeDeletions(env, Date.now())).toBe(0);
    const later = Date.now() + VOLUME_DELETE_GRACE_MS + 1000;
    expect(await claimVolumeDeletions(env, later)).toBe(1);
    const frame = await s.agent.waitFor((m): m is VolumeDelete => m.type === "volume_delete");
    expect(frame.volume_id).toBe(volumeId);
    // Claimed: the next tick doesn't resend.
    expect(await claimVolumeDeletions(env, later + 60_000)).toBe(0);

    s.agent.send({
      type: "volume_status",
      volumes: [
        { volume_id: volumeId, state: "deleted", size_bytes: 0, used_bytes: 0, quota: "loop" },
      ],
    });
    await eventually(async () =>
      (await volumeRow(volumeId))?.status === "deleted" ? true : undefined,
    );
  });

  it("undeletes within the grace period", async () => {
    const { owner, workspaceId } = await install();
    const project = await createProject(owner, workspaceId);
    const prod = project.environments[0]!.id;
    const created = await addDatabase(owner, project.id, { environment_id: prod });
    const volumeId = created.body.volumes[0]!.id;
    const del = await owner.json<{ status: string; delete_after: number }>(
      `/v1/volumes/${volumeId}`,
      { method: "DELETE" },
    );
    expect(del.body.status).toBe("pending_deletion");
    const back = await owner.json<{ status: string; delete_after: number | null }>(
      `/v1/volumes/${volumeId}/undelete`,
      { method: "POST" },
    );
    expect(back.body).toMatchObject({ status: "pending", delete_after: null });
    expect((await owner.json(`/v1/volumes/${volumeId}/undelete`, { method: "POST" })).status).toBe(
      409,
    );
    const audit = await env.DB.prepare(
      "SELECT action FROM audit_logs WHERE action LIKE 'volume.%' ORDER BY id",
    ).all<{ action: string }>();
    expect(audit.results.map((a) => a.action)).toEqual(["volume.deleted", "volume.undeleted"]);
    // A never-placed volume has no data anywhere: it is simply marked deleted.
    await owner.json(`/v1/volumes/${volumeId}`, { method: "DELETE" });
    expect(await claimVolumeDeletions(env, Date.now() + VOLUME_DELETE_GRACE_MS + 1)).toBe(1);
    expect((await volumeRow(volumeId))!.status).toBe("deleted");
  });
});

describe("templates with a database", () => {
  it("deploys n8n with PostgreSQL: a database service, its volume and credentials", async () => {
    const { owner, workspaceId } = await install();
    const res = await owner.json<{
      services: { id: string; slug: string; kind: string }[];
    }>(`/v1/workspaces/${workspaceId}/projects/from-template`, {
      method: "POST",
      json: { template_id: "n8n-postgres", deploy: false, confirm_write_only: true },
    });
    expect(res.status).toBe(201);
    const db = res.body.services.find((x) => x.slug === "postgres")!;
    expect(db.kind).toBe("database");
    const vols = await env.DB.prepare(
      "SELECT mount_path, size_mb FROM volumes WHERE service_id = ?",
    )
      .bind(db.id)
      .all();
    expect(vols.results).toEqual([{ mount_path: "/var/lib/postgresql", size_mb: 5120 }]);
    const keys = await env.DB.prepare(
      "SELECT key, tier FROM variables WHERE service_id = ? ORDER BY key",
    )
      .bind(db.id)
      .all<{ key: string; tier: string }>();
    expect(keys.results).toEqual(
      expect.arrayContaining([
        { key: "POSTGRES_PASSWORD", tier: "secret" },
        { key: "DATABASE_URL", tier: "secret" },
      ]),
    );
    const n8n = res.body.services.find((x) => x.slug === "n8n")!;
    const pw = await env.DB.prepare(
      "SELECT tier FROM variables WHERE service_id = ? AND key = 'DB_POSTGRESDB_PASSWORD'",
    )
      .bind(n8n.id)
      .first();
    expect(pw).toEqual({ tier: "secret" });
  });
});
