/**
 * The MCP server tools for one server's health and lifecycle:
 * `get_node_health` and `list_degraded_services` (read-only), and
 * `drain_node` and `resume_node`, which must refuse, write and audit exactly
 * like `POST /nodes/{id}/drain` and `/resume`: the `nodes:manage` scope, the
 * token creator's current role, the two-factor gate (fail closed), the
 * workspace boundary, and `force` with the services that block a drain.
 */
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createDb, deployments, nodeDrains, nodes, placements, services } from "@roundhouse/db";
import { API_TOKEN_PRESETS, newId } from "@roundhouse/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sealDeploymentEnv } from "../src/lib/desired-state";
import { rescheduleOfflineNode } from "../src/lib/moves";
import { projectKey } from "../src/lib/variables";
import { MCP_TOOLS } from "../src/mcp/tools";
import { addMember, type Client as Browser, eventually, joinNode, ORIGIN } from "./helpers";
import { type MeshCluster, meshCluster } from "./mesh-helpers";
import { createProject, createService } from "./pipeline-helpers";

let introspector: { dispose(): Promise<void> } | undefined;

beforeEach(async () => {
  (env as { MCP_LIMITER?: RateLimit }).MCP_LIMITER = { limit: async () => ({ success: true }) };
  await env.DB.prepare(
    "INSERT OR REPLACE INTO instance_settings (key, value, created_at, updated_at) VALUES ('mcp_enabled', 'true', ?1, ?1)",
  )
    .bind(Date.now())
    .run();
  introspector = await introspectWorkflow(env.DRAIN_WORKFLOW);
});

afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

const MANAGE = [...API_TOKEN_PRESETS.read, "nodes:manage"] as const;

async function mint(c: Browser, workspaceId: string, scopes: readonly string[]) {
  const res = await c.json<{ secret: string }>(`/v1/workspaces/${workspaceId}/tokens`, {
    method: "POST",
    json: { name: "agent", scopes, expires_in_days: 30 },
  });
  if (res.status !== 201) throw new Error(`mint: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.secret;
}

async function connect(secret: string): Promise<Client> {
  const client = new Client(
    { name: "roundhouse-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    fetch: (url, init) => SELF.fetch(url, init),
    requestInit: { headers: { authorization: `Bearer ${secret}` } },
    onInsufficientScope: "throw",
  });
  await client.connect(transport);
  return client;
}

async function tool<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; body: T }> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as { text: string }[]).map((c) => c.text).join("\n");
  return {
    isError: res.isError === true,
    body: (res.structuredContent ?? JSON.parse(text)) as T,
  };
}

type ToolError = { error: { status: number; code: string } };

/** An active deployment with one healthy replica per node given. */
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
  for (const [replica, nodeId] of nodeIds.entries()) {
    await db.insert(placements).values({
      id: newId("placement"),
      deploymentId: id,
      replica,
      nodeId,
      workloadId: newId("workload"),
      state: "healthy",
    });
  }
  return id;
}

/** Two meshed servers; `web` (stateless) and `db` (a database) both run on n1. */
async function stage() {
  const c = await meshCluster(2, { ready: true });
  const project = await createProject(c.owner, c.workspaceId);
  const environmentId = project.environments[0]!.id;
  const web = await createService(c.owner, project.id, {
    name: "web",
    source: { type: "image", image: "nginx:1.27" },
    config: { networking: { port: 8080 } },
  });
  const database = await createService(c.owner, project.id, {
    name: "db",
    source: { type: "image", image: "postgres:18" },
    config: { networking: { port: 5432 } },
  });
  const db = createDb(env.DB);
  await db
    .update(services)
    .set({ databaseEngine: "postgres", databaseVersion: "18" })
    .where(eq(services.id, database.service.id));
  const [n1, n2] = c.members.map((m) => m.id) as [string, string];
  await liveDeployment(c, project.id, web.service.id, environmentId, [n1]);
  const dbDeployment = await liveDeployment(c, project.id, database.service.id, environmentId, [
    n1,
  ]);
  return {
    ...c,
    db,
    project,
    environmentId,
    webId: web.service.id,
    dbId: database.service.id,
    dbDeployment,
    n1,
    n2,
  };
}

async function auditRows(action: string) {
  const { results } = await env.DB.prepare(
    "SELECT actor_type, target_id, metadata FROM audit_logs WHERE action = ? ORDER BY seq",
  )
    .bind(action)
    .all<{ actor_type: string; target_id: string; metadata: string }>();
  return results.map((r) => ({
    ...r,
    metadata: JSON.parse(r.metadata) as Record<string, unknown>,
  }));
}

async function nodeStatus(id: string) {
  const [row] = await createDb(env.DB).select().from(nodes).where(eq(nodes.id, id));
  return row!.status;
}

describe("server health tools", () => {
  it("reports a server's status, mesh, drain and replicas, and the services degraded by it", async () => {
    const s = await stage();
    await s.db.update(nodes).set({ status: "offline" }).where(eq(nodes.id, s.n1));
    await rescheduleOfflineNode(env, s.db, s.n1);
    const client = await connect(await mint(s.owner, s.workspaceId, API_TOKEN_PRESETS.read));

    const health = await tool<{
      server: { id: string; name: string; status: string; cpu_total: unknown };
      mesh: { enabled: boolean; joined: boolean; peers: { server: string; path: string }[] };
      drain: unknown;
      replicas: { service_name: string; state: string; health: string }[];
    }>(client, "get_node_health", { node_id: s.n1 });
    expect(health.isError).toBe(false);
    expect(health.body.server).toMatchObject({ id: s.n1, name: "n1", status: "offline" });
    expect(health.body.server).toHaveProperty("cpu_total");
    expect(health.body.mesh).toMatchObject({ enabled: true, joined: true });
    expect(health.body.mesh.peers).toEqual([expect.objectContaining({ server: "n2" })]);
    expect(health.body.drain).toBeNull();
    expect(health.body.replicas).toEqual(
      expect.arrayContaining([expect.objectContaining({ service_name: "db", health: "degraded" })]),
    );

    const degraded = await tool<{
      services: { service_id: string; health_reason: string; server: unknown }[];
    }>(client, "list_degraded_services");
    expect(degraded.body.services).toEqual([
      expect.objectContaining({
        service_id: s.dbId,
        health_reason: "node_offline",
        server: { id: s.n1, name: "n1" },
      }),
    ]);

    const rest = await s.owner.json<{ health_node: unknown }>(`/v1/services/${s.dbId}`);
    expect(rest.body.health_node).toEqual({ id: s.n1, name: "n1" });

    for (const name of ["get_node_health", "list_degraded_services"]) {
      const t = MCP_TOOLS.find((x) => x.name === name)!;
      expect(t.annotations.readOnlyHint).toBe(true);
      expect(t.scopes.every((scope) => scope.endsWith(":read"))).toBe(true);
    }
    await client.close();
  });

  it("hides another workspace's server", async () => {
    const s = await stage();
    const other = await s.owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Elsewhere" },
    });
    const foreign = await joinNode(s.owner, other.body.id, {
      name: "far-1",
      hostname: "far-1",
      public_key: "Qnl0ZXMtb2YtYS1mb3JlaWduLW5vZGUta2V5LTAwMDA=",
    });
    const client = await connect(await mint(s.owner, s.workspaceId, API_TOKEN_PRESETS.read));
    const hidden = await tool<ToolError>(client, "get_node_health", { node_id: foreign.node_id });
    expect(hidden.body.error.status).toBe(404);
    const crossed = await tool<ToolError>(client, "get_node_health", {
      node_id: foreign.node_id,
      workspace_id: other.body.id,
    });
    expect(crossed.body.error.status).toBe(404);
    await client.close();
  });
});

describe("drain_node and resume_node", () => {
  it("drains like REST: blocked by volume services, forced, resumed, audited via mcp", async () => {
    const s = await stage();
    const client = await connect(await mint(s.owner, s.workspaceId, MANAGE));

    const blocked = await tool<{
      drain: { status: string; force: boolean };
      volume_services: { service_id: string; service_name: string }[];
      outcome: string;
    }>(client, "drain_node", { node_id: s.n1 });
    expect(blocked.isError).toBe(false);
    expect(blocked.body.drain).toMatchObject({ status: "running", force: false });
    expect(blocked.body.volume_services).toEqual([
      expect.objectContaining({ service_id: s.dbId, service_name: "db" }),
    ]);
    expect(blocked.body.outcome).toMatch(/blocked/);
    expect(await nodeStatus(s.n1)).toBe("draining");
    const ended = await eventually(async () => {
      const r = await tool<{ drain: { status: string; blocked: { service_name: string }[] } }>(
        client,
        "get_node_health",
        { node_id: s.n1 },
      );
      return r.body.drain?.status === "blocked" ? r.body.drain : undefined;
    }, 20_000);
    expect(ended.blocked).toEqual([expect.objectContaining({ service_name: "db" })]);

    const again = await tool<ToolError>(client, "drain_node", { node_id: s.n1, force: true });
    expect(again.isError).toBe(false);
    await eventually(async () => {
      const r = await s.owner.json<{ drain: { status: string } | null }>(
        `/v1/workspaces/${s.workspaceId}/nodes/${s.n1}/drain`,
      );
      return r.body.drain?.status === "completed" ? true : undefined;
    }, 20_000);
    const degraded = await tool<{ services: { service_id: string; server: unknown }[] }>(
      client,
      "list_degraded_services",
    );
    expect(degraded.body.services).toEqual([
      expect.objectContaining({ service_id: s.dbId, server: { id: s.n1, name: "n1" } }),
    ]);

    const resumed = await tool<{ server: { status: string }; restarted: number }>(
      client,
      "resume_node",
      { node_id: s.n1 },
    );
    expect(resumed.body).toMatchObject({ server: { status: "online" }, restarted: 1 });
    const [svc] = await s.db.select().from(services).where(eq(services.id, s.dbId));
    expect(svc).toMatchObject({ health: "ok", healthReason: null });
    const notDraining = await tool<ToolError>(client, "resume_node", { node_id: s.n1 });
    expect(notDraining.body.error).toMatchObject({ status: 409, code: "node_not_draining" });

    const started = await auditRows("node.drain_started");
    expect(started).toHaveLength(2);
    expect(started[0]).toMatchObject({
      actor_type: "token",
      target_id: s.n1,
      metadata: { name: "n1", force: false, via: "mcp", tool: "drain_node" },
    });
    expect(started[1]!.metadata).toMatchObject({ force: true, via: "mcp" });
    expect(await auditRows("node.resumed")).toEqual([
      expect.objectContaining({
        target_id: s.n1,
        metadata: expect.objectContaining({ restarted: 1, via: "mcp", tool: "resume_node" }),
      }),
    ]);
    await client.close();
  });

  it("refuses a second drain, a pending server, and reports no blockers for stateless servers", async () => {
    const s = await stage();
    const client = await connect(await mint(s.owner, s.workspaceId, MANAGE));
    // n2 runs nothing: nothing blocks it, and with n1 in maintenance its drain can't finish.
    await s.db.update(nodes).set({ status: "maintenance" }).where(eq(nodes.id, s.n1));
    const first = await tool<{ volume_services: unknown[]; outcome: string }>(
      client,
      "drain_node",
      { node_id: s.n2 },
    );
    expect(first.body.volume_services).toEqual([]);
    expect(first.body.outcome).toMatch(/Every replica can move/);
    await s.db.insert(nodeDrains).values({
      id: newId("nodeDrain"),
      workspaceId: s.workspaceId,
      nodeId: s.n1,
      force: false,
      workflowInstanceId: "drain-manual",
      startedBy: null,
    });
    const busy = await tool<ToolError>(client, "drain_node", { node_id: s.n1 });
    expect(busy.body.error).toMatchObject({ status: 409, code: "drain_in_progress" });

    const pending = await joinNode(s.owner, s.workspaceId, {
      name: "new-1",
      hostname: "new-1",
      public_key: "Qnl0ZXMtb2YtYS1wZW5kaW5nLW5vZGUta2V5LTAwMDA=",
    });
    const early = await tool<ToolError>(client, "drain_node", { node_id: pending.node_id });
    expect(early.body.error).toMatchObject({ status: 409, code: "node_not_drainable" });
    await client.close();
  });

  it("needs the nodes:manage scope", async () => {
    const s = await stage();
    const secret = await mint(s.owner, s.workspaceId, API_TOKEN_PRESETS.read);
    for (const name of ["drain_node", "resume_node"]) {
      const res = await SELF.fetch(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: { node_id: s.n1 } },
        }),
      });
      expect(res.status).toBe(403);
      const challenge = res.headers.get("www-authenticate")!;
      expect(challenge).toContain('error="insufficient_scope"');
      expect(challenge).toContain('scope="nodes:manage"');
    }
    expect(await nodeStatus(s.n1)).toBe("online");
    for (const name of ["drain_node", "resume_node"]) {
      const t = MCP_TOOLS.find((x) => x.name === name)!;
      expect(t.scopes).toEqual(["nodes:manage"]);
      expect(t.annotations.readOnlyHint).toBe(false);
    }
  });

  it("caps the token by its creator's role: a viewer can't drain or resume", async () => {
    const s = await stage();
    const admin = await addMember(s.owner, s.workspaceId, "ada@example.com", "admin");
    const secret = await mint(admin, s.workspaceId, MANAGE);
    const { body } = await s.owner.json<{ members: { id: string; email: string }[] }>(
      `/v1/workspaces/${s.workspaceId}/members`,
    );
    const memberId = body.members.find((m) => m.email === "ada@example.com")!.id;
    await s.owner.json(`/v1/workspaces/${s.workspaceId}/members/${memberId}`, {
      method: "PATCH",
      json: { role: "viewer" },
    });
    const client = await connect(secret);
    const drain = await tool<ToolError>(client, "drain_node", { node_id: s.n1 });
    expect(drain.body.error).toMatchObject({ status: 403, code: "forbidden" });
    await s.db.update(nodes).set({ status: "maintenance" }).where(eq(nodes.id, s.n2));
    const resume = await tool<ToolError>(client, "resume_node", { node_id: s.n2 });
    expect(resume.body.error).toMatchObject({ status: 403, code: "forbidden" });
    expect(await nodeStatus(s.n1)).toBe("online");
    expect(await nodeStatus(s.n2)).toBe("maintenance");
    expect(await s.db.select().from(nodeDrains)).toEqual([]);
    await client.close();
  });

  it("fails closed while the token's owner must enroll in two-factor authentication", async () => {
    const s = await stage();
    const client = await connect(await mint(s.owner, s.workspaceId, MANAGE));
    await env.DB.prepare("UPDATE users SET two_factor_enabled = 0").run();
    await s.db.update(nodes).set({ status: "maintenance" }).where(eq(nodes.id, s.n2));
    for (const [name, node] of [
      ["drain_node", s.n1],
      ["resume_node", s.n2],
    ] as const) {
      const res = await tool<ToolError>(client, name, { node_id: node });
      expect(res.isError).toBe(true);
      expect(res.body.error).toMatchObject({ status: 403, code: "two_factor_required" });
    }
    expect(await nodeStatus(s.n1)).toBe("online");
    expect(await nodeStatus(s.n2)).toBe("maintenance");
    const read = await tool(client, "get_node_health", { node_id: s.n1 });
    expect(read.isError).toBe(false);
    await client.close();
  });

  it("never touches another workspace's server", async () => {
    const s = await stage();
    const other = await s.owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Elsewhere" },
    });
    const foreign = await joinNode(s.owner, other.body.id, {
      name: "far-1",
      hostname: "far-1",
      public_key: "Qnl0ZXMtb2YtYS1mb3JlaWduLW5vZGUta2V5LTAwMDA=",
    });
    await s.db.update(nodes).set({ status: "maintenance" }).where(eq(nodes.id, foreign.node_id));
    const client = await connect(await mint(s.owner, s.workspaceId, MANAGE));
    for (const args of [
      { node_id: foreign.node_id },
      { node_id: foreign.node_id, workspace_id: other.body.id },
    ]) {
      const drain = await tool<ToolError>(client, "drain_node", args);
      expect(drain.body.error.status).toBe(404);
      const resume = await tool<ToolError>(client, "resume_node", args);
      expect(resume.body.error.status).toBe(404);
    }
    expect(await nodeStatus(foreign.node_id)).toBe("maintenance");
    expect(await s.db.select().from(nodeDrains)).toEqual([]);
    await client.close();
  });
});
