/**
 * The MCP server at `/mcp`: transport rules (POST only, Origin, body size,
 * the per-token tool-call budget), bearer-only `tok_` authentication, the
 * `insufficient_scope` challenge, RBAC through the token creator's current
 * role, audit records for mutations, the advertised tool schemas, that no
 * tool ever returns a secret value, and the `mcp_enabled` instance setting
 * (off by default; every other test turns it on first). Calls go through the official MCP
 * client SDK against the Worker, except where a test needs the raw HTTP
 * exchange.
 */
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { API_TOKEN_PRESETS } from "@roundhouse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCP_TOOLS } from "../src/mcp/tools";
import { addMember, type Client as Browser, install, ORIGIN } from "./helpers";
import {
  COMMIT_SHA,
  createProject,
  createService,
  GIT_SERVICE,
  stage,
  waitForStatus,
} from "./pipeline-helpers";

const SECRET_VALUE = "test-only-secret-Zq8vX2mN4pR7tY1wK9bH3cJ6";
const SHARED_SECRET_VALUE = "shared-s3cr3t-Hk2Lm9Pq4Rs7";
// biome-ignore lint/suspicious/noTemplateCurlyInString: `${{…}}` is variable-reference syntax, not a template.
const DERIVED_VALUE = "prefix-${{web.API_SECRET}}";

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;

/** Turns MCP on the way an instance admin would leave it: the stored setting. */
async function enableMcp(enabled = true) {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO instance_settings (key, value, created_at, updated_at) VALUES ('mcp_enabled', ?, ?, ?)",
  )
    .bind(JSON.stringify(enabled), Date.now(), Date.now())
    .run();
}

beforeEach(async () => {
  sent = [];
  (env as { MCP_LIMITER?: RateLimit }).MCP_LIMITER = { limit: async () => ({ success: true }) };
  await enableMcp();
});

afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

async function mint(c: Browser, workspaceId: string, scopes: readonly string[]) {
  const res = await c.json<{ secret: string }>(`/v1/workspaces/${workspaceId}/tokens`, {
    method: "POST",
    json: { name: "agent", scopes, expires_in_days: 30 },
  });
  if (res.status !== 201) throw new Error(`mint: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.secret;
}

/** Every request the SDK client sent, for checks on what went over the wire. */
let sent: { headers: Headers; body: string }[] = [];

async function connect(secret: string, era: "modern" | "legacy" = "modern"): Promise<Client> {
  const client = new Client(
    { name: "roundhouse-test", version: "1.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
    fetch: (url, init) => {
      sent.push({ headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return SELF.fetch(url, init);
    },
    requestInit: { headers: { authorization: `Bearer ${secret}` } },
    onInsufficientScope: "throw",
  });
  await client.connect(transport);
  return client;
}

interface ToolOutput<T> {
  isError: boolean;
  body: T;
  text: string;
}

async function tool<T = Record<string, unknown>>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutput<T>> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as { type: string; text: string }[];
  const text = content.map((c) => c.text).join("\n");
  return {
    isError: res.isError === true,
    body: (res.structuredContent ?? JSON.parse(text)) as T,
    text: JSON.stringify(res),
  };
}

/** A raw 2025-style JSON-RPC POST, for checks on the HTTP exchange itself. */
function rpc(body: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const callBody = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
});

describe("mcp_enabled", () => {
  it("is off on a new install: 404 with a JSON-RPC error, before any authentication", async () => {
    await env.DB.prepare("DELETE FROM instance_settings WHERE key = 'mcp_enabled'").run();
    const { owner, workspaceId } = await install();
    expect((await owner.json("/v1/instance/settings")).body).toMatchObject({ mcp_enabled: false });
    const secret = await mint(owner, workspaceId, API_TOKEN_PRESETS.read);
    let budgetChecks = 0;
    (env as { MCP_LIMITER?: RateLimit }).MCP_LIMITER = {
      limit: async () => {
        budgetChecks++;
        return { success: true };
      },
    };

    for (const headers of [
      {} as Record<string, string>,
      { authorization: `Bearer ${secret}` },
      { authorization: "Bearer tok_not_a_real_token" },
    ]) {
      const res = await rpc(callBody("list_workspaces"), headers);
      expect(res.status).toBe(404);
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(await res.json()).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: {
          code: -32000,
          message: expect.stringContaining("MCP is disabled on this instance"),
          data: { code: "mcp_disabled" },
        },
      });
    }
    expect(budgetChecks).toBe(0);
    const used = await env.DB.prepare("SELECT last_used_at FROM api_tokens").first<{
      last_used_at: number | null;
    }>();
    expect(used!.last_used_at).toBeNull();
  });

  it("answers a batch per request and anything else with the API error body", async () => {
    await enableMcp(false);
    const batch = await rpc([
      { jsonrpc: "2.0", id: "a", method: "tools/list" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_workspaces" } },
    ]);
    expect(batch.status).toBe(404);
    expect(((await batch.json()) as { id: unknown }[]).map((m) => m.id)).toEqual(["a", 7]);

    for (const res of [
      await rpc("not json"),
      await SELF.fetch(`${ORIGIN}/mcp`),
      await SELF.fetch(`${ORIGIN}/mcp`, { method: "DELETE" }),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: { code: "mcp_disabled" } });
    }
  });

  it("serves agents once an instance admin turns it on", async () => {
    await env.DB.prepare("DELETE FROM instance_settings WHERE key = 'mcp_enabled'").run();
    const { owner, workspaceId } = await install();
    const secret = await mint(owner, workspaceId, API_TOKEN_PRESETS.read);
    expect(
      (await rpc(callBody("list_workspaces"), { authorization: `Bearer ${secret}` })).status,
    ).toBe(404);
    const on = await owner.json("/v1/instance/settings", {
      method: "PATCH",
      json: { mcp_enabled: true },
    });
    expect(on.status).toBe(200);
    const client = await connect(secret);
    const listed = await tool<{ workspaces: { id: string }[] }>(client, "list_workspaces");
    expect(listed.body.workspaces.map((w) => w.id)).toEqual([workspaceId]);
    await client.close();

    await owner.json("/v1/instance/settings", { method: "PATCH", json: { mcp_enabled: false } });
    expect(
      (await rpc(callBody("list_workspaces"), { authorization: `Bearer ${secret}` })).status,
    ).toBe(404);
  });
});

describe("transport and authentication", () => {
  it("requires a tok_ bearer token and never accepts the session cookie", async () => {
    const { owner } = await install();
    const anonymous = await rpc(callBody("list_workspaces"));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toMatch(/^Bearer realm="roundhouse"/);

    const withCookie = await rpc(callBody("list_workspaces"), { cookie: owner.cookie });
    expect(withCookie.status).toBe(401);

    const bogus = await rpc(callBody("list_workspaces"), { authorization: "Bearer tok_nope" });
    expect(bogus.status).toBe(401);
    expect(bogus.headers.get("www-authenticate")).toContain('error="invalid_token"');

    const other = await rpc(callBody("list_workspaces"), { authorization: "Bearer abc.def" });
    expect(other.status).toBe(401);
  });

  it("answers only POST, checks Origin, and bounds the body", async () => {
    const { owner, workspaceId } = await install();
    const secret = await mint(owner, workspaceId, API_TOKEN_PRESETS.read);
    const auth = { authorization: `Bearer ${secret}` };
    for (const method of ["GET", "DELETE"]) {
      const res = await SELF.fetch(`${ORIGIN}/mcp`, { method, headers: auth });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
    const foreign = await rpc(callBody("list_workspaces"), {
      ...auth,
      origin: "https://evil.example",
    });
    expect(foreign.status).toBe(403);
    const same = await rpc(callBody("list_workspaces"), { ...auth, origin: ORIGIN });
    expect(same.status).toBe(200);
    expect(same.headers.get("cache-control")).toContain("no-store");

    const huge = await rpc(
      JSON.stringify({ ...callBody("list_workspaces"), pad: "x".repeat(300 * 1024) }),
      auth,
    );
    expect(huge.status).toBe(413);
  });

  it("limits tool calls per token", async () => {
    const { owner, workspaceId } = await install();
    const secret = await mint(owner, workspaceId, API_TOKEN_PRESETS.read);
    const keys: string[] = [];
    (env as { MCP_LIMITER?: RateLimit }).MCP_LIMITER = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: keys.length <= 2 };
      },
    };
    const auth = { authorization: `Bearer ${secret}` };
    expect((await rpc(callBody("list_workspaces"), auth)).status).toBe(200);
    expect((await rpc(callBody("list_workspaces"), auth)).status).toBe(200);
    const limited = await rpc(callBody("list_workspaces"), auth);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^mcp:tok_/);
  });

  it.each([
    ["2026-07-28 (stateless, no initialize)", "modern" as const],
    ["2025-11-25 (initialize handshake)", "legacy" as const],
  ])("round-trips through the MCP client SDK speaking %s", async (_, era) => {
    const { owner, workspaceId } = await install();
    await createProject(owner, workspaceId, { name: "Storefront" });
    const client = await connect(await mint(owner, workspaceId, API_TOKEN_PRESETS.read), era);
    const ws = await tool<{ workspaces: { id: string; role: string }[] }>(
      client,
      "list_workspaces",
    );
    expect(ws.isError).toBe(false);
    expect(ws.body.workspaces).toEqual([
      expect.objectContaining({ id: workspaceId, role: "owner" }),
    ]);
    const projects = await tool<{ projects: { name: string }[] }>(client, "list_projects");
    expect(projects.body.projects.map((p) => p.name)).toEqual(["Storefront"]);
    await client.close();

    const call = sent.find((r) => r.body.includes('"tools/call"'))!;
    if (era === "modern") {
      expect(call.headers.get("mcp-protocol-version")).toBe("2026-07-28");
      expect(call.headers.get("mcp-method")).toBe("tools/call");
      expect(sent.some((r) => r.body.includes('"initialize"'))).toBe(false);
    } else {
      expect(sent.some((r) => r.body.includes('"initialize"'))).toBe(true);
    }
  });

  it("rejects a protocol version header that contradicts the request", async () => {
    const { owner, workspaceId } = await install();
    const secret = await mint(owner, workspaceId, API_TOKEN_PRESETS.read);
    const client = await connect(secret);
    await tool(client, "list_workspaces");
    await client.close();
    const call = sent.find((r) => r.body.includes('"tools/call"'))!;
    const headers = Object.fromEntries(call.headers);
    const res = await rpc(call.body, { ...headers, "mcp-protocol-version": "2025-06-18" });
    expect(res.status).toBe(400);
  });
});

describe("tools/list", () => {
  it("advertises every tool with an object input schema and accurate annotations", async () => {
    const { owner, workspaceId } = await install();
    const client = await connect(await mint(owner, workspaceId, API_TOKEN_PRESETS.read));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "list_workspaces",
      "list_projects",
      "get_project",
      "get_service",
      "list_deployments",
      "get_deployment",
      "read_logs",
      "deploy_service",
      "rollback_deployment",
      "cancel_deployment",
      "list_variables",
      "resolve_variables",
      "set_variables",
      "stage_config_change",
      "list_changes",
      "apply_changes",
      "list_nodes",
      "list_templates",
      "deploy_template",
    ]);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description?.length).toBeGreaterThan(20);
      expect(t.name).not.toMatch(/secret|shell|exec|delete|token|member/);
    }
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of [
      "list_projects",
      "get_deployment",
      "read_logs",
      "list_variables",
      "list_changes",
    ]) {
      expect(byName.get(name)!.annotations?.readOnlyHint).toBe(true);
    }
    for (const name of [
      "deploy_service",
      "rollback_deployment",
      "set_variables",
      "stage_config_change",
      "apply_changes",
    ]) {
      expect(byName.get(name)!.annotations?.readOnlyHint).toBe(false);
    }
    expect(byName.get("apply_changes")!.annotations?.destructiveHint).toBe(true);
    const setVars = byName.get("set_variables")!.inputSchema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(setVars.properties)).toEqual(
      expect.arrayContaining(["environment_id", "set", "confirm_write_only"]),
    );
    expect(Object.keys(setVars.properties)).not.toContain("delete");
    expect(setVars.required).toEqual(expect.arrayContaining(["environment_id", "set"]));
    await client.close();
  });

  it("rejects invalid input before the handler runs", async () => {
    const { owner, workspaceId } = await install();
    const client = await connect(await mint(owner, workspaceId, API_TOKEN_PRESETS.read));
    const res = await client.callTool({
      name: "list_deployments",
      arguments: { service_id: "svc_1", environment_id: "env_1", limit: 1000 },
    });
    expect(res.isError).toBe(true);
    const both = await client.callTool({
      name: "list_variables",
      arguments: { environment_id: "env_1" },
    });
    expect(both.isError).toBe(true);
    await client.close();
  });
});

describe("authorization", () => {
  it("answers a missing scope with a 403 insufficient_scope challenge", async () => {
    const { owner, workspaceId } = await install();
    const secret = await mint(owner, workspaceId, API_TOKEN_PRESETS.read);
    const res = await rpc(
      callBody("deploy_service", { service_id: "svc_x", environment_id: "e" }),
      {
        authorization: `Bearer ${secret}`,
      },
    );
    expect(res.status).toBe(403);
    const challenge = res.headers.get("www-authenticate")!;
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="deployments:create"');

    const client = await connect(secret);
    await expect(
      client.callTool({
        name: "deploy_service",
        arguments: { service_id: "svc_x", environment_id: "e" },
      }),
    ).rejects.toThrow();
    await client.close();
  });

  it("caps a token by its creator's current role: a demoted admin's token can't deploy", async () => {
    const { owner, workspaceId } = await install();
    const project = await createProject(owner, workspaceId);
    const svc = await createService(owner, project.id);
    const envId = project.environments[0]!.id;
    const admin = await addMember(owner, workspaceId, "a@example.com", "admin");
    const secret = await mint(admin, workspaceId, API_TOKEN_PRESETS.deploy);
    const { body } = await owner.json<{ members: { id: string; email: string }[] }>(
      `/v1/workspaces/${workspaceId}/members`,
    );
    const memberId = body.members.find((m) => m.email === "a@example.com")!.id;
    await owner.json(`/v1/workspaces/${workspaceId}/members/${memberId}`, {
      method: "PATCH",
      json: { role: "viewer" },
    });

    const client = await connect(secret);
    const deploy = await tool<{ error: { status: number; code: string } }>(
      client,
      "deploy_service",
      { service_id: svc.service.id, environment_id: envId },
    );
    expect(deploy.isError).toBe(true);
    expect(deploy.body.error).toMatchObject({ status: 403, code: "forbidden" });
    const write = await tool<{ error: { status: number } }>(client, "set_variables", {
      service_id: svc.service.id,
      environment_id: envId,
      set: [{ key: "A", value: "1" }],
    });
    expect(write.body.error.status).toBe(403);
    const read = await tool(client, "get_project", { project_id: project.id });
    expect(read.isError).toBe(false);

    const rows = await env.DB.prepare("SELECT count(*) AS n FROM deployments WHERE service_id = ?")
      .bind(svc.service.id)
      .first<{ n: number }>();
    expect(rows!.n).toBe(0);
    await client.close();
  });

  it("never reaches another workspace", async () => {
    const { owner, workspaceId } = await install();
    const other = await owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Elsewhere" },
    });
    const project = await createProject(owner, other.body.id);
    const client = await connect(await mint(owner, workspaceId, API_TOKEN_PRESETS.read));
    const list = await tool<{ error: { status: number } }>(client, "list_projects", {
      workspace_id: other.body.id,
    });
    expect(list.body.error.status).toBe(404);
    const get = await tool<{ error: { status: number } }>(client, "get_project", {
      project_id: project.id,
    });
    expect(get.body.error.status).toBe(404);
    await client.close();
  });
});

describe("staged changes", () => {
  it("stages variables instead of writing them, refuses new secrets without confirm_write_only, and never echoes values", async () => {
    const { owner, workspaceId } = await install();
    const project = await createProject(owner, workspaceId);
    const svc = await createService(owner, project.id);
    const envId = project.environments[0]!.id;
    const client = await connect(await mint(owner, workspaceId, API_TOKEN_PRESETS.deploy));
    const target = { service_id: svc.service.id, environment_id: envId };

    const plain = await tool<{
      status: string;
      change_set_id: string;
      revision: number;
      summary: string[];
      review_url: string;
    }>(client, "set_variables", { ...target, set: [{ key: "LOG_LEVEL", value: "debug" }] });
    expect(plain.isError).toBe(false);
    expect(plain.body).toMatchObject({ status: "staged", summary: ["set web.LOG_LEVEL"] });
    expect(plain.body.review_url).toBe(
      `${ORIGIN}/w/${workspaceId}/p/${project.id}?review=${plain.body.change_set_id}`,
    );
    // Nothing is written until the set is applied.
    const before = await owner.json<{ variables: unknown[] }>(
      `/v1/services/${svc.service.id}/variables?environment_id=${envId}`,
    );
    expect(before.body.variables).toEqual([]);

    const unconfirmed = await tool<{ error: { code: string } }>(client, "set_variables", {
      ...target,
      set: [{ key: "STRIPE_KEY", value: SECRET_VALUE, tier: "secret" }],
    });
    expect(unconfirmed.isError).toBe(true);
    expect(unconfirmed.body.error.code).toBe("confirmation_required");
    expect(unconfirmed.text).not.toContain(SECRET_VALUE);

    const confirmed = await tool<{ change_set_id: string; revision: number }>(
      client,
      "set_variables",
      {
        ...target,
        set: [{ key: "STRIPE_KEY", value: SECRET_VALUE, tier: "secret" }],
        confirm_write_only: true,
      },
    );
    expect(confirmed.isError).toBe(false);
    // The token's open set for the environment is reused.
    expect(confirmed.body.change_set_id).toBe(plain.body.change_set_id);

    const listed = await tool<{ change_sets: { changes: { op: Record<string, unknown> }[] }[] }>(
      client,
      "list_changes",
      { environment_id: envId },
    );
    expect(listed.body.change_sets).toHaveLength(1);
    expect(listed.body.change_sets[0]!.changes.map((c) => c.op.key)).toEqual([
      "LOG_LEVEL",
      "STRIPE_KEY",
    ]);

    const applied = await tool<{ status: string; deployment_ids: string[] }>(
      client,
      "apply_changes",
      {
        change_set_id: confirmed.body.change_set_id,
        expected_revision: confirmed.body.revision,
        deploy: "none",
      },
    );
    expect(applied.body).toMatchObject({ status: "applied", deployment_ids: [] });
    const after = await owner.json<{
      variables: { key: string; tier: string; value: string | null }[];
    }>(`/v1/services/${svc.service.id}/variables?environment_id=${envId}`);
    expect(after.body.variables).toEqual([
      expect.objectContaining({ key: "LOG_LEVEL", tier: "plain" }),
      expect.objectContaining({ key: "STRIPE_KEY", tier: "secret", value: null }),
    ]);

    for (const out of [plain, unconfirmed, confirmed, listed, applied]) {
      expect(out.text).not.toContain(SECRET_VALUE);
      expect(out.text).not.toContain("debug");
    }
    const audit = await env.DB.prepare(
      "SELECT action, actor_type, metadata FROM audit_logs WHERE actor_type = 'token' ORDER BY seq",
    ).all<{ action: string; actor_type: string; metadata: string }>();
    expect(audit.results.map((r) => r.action)).toEqual([
      "change_set.created",
      "variables.updated",
      "change_set.applied",
    ]);
    for (const row of audit.results) {
      expect(JSON.parse(row.metadata)).toMatchObject({ via: "mcp" });
      expect(row.metadata).not.toContain(SECRET_VALUE);
      expect(row.metadata).not.toContain("debug");
    }
    await client.close();
  });

  it("applies only its own sets on unprotected environments; otherwise awaits a human", async () => {
    const { owner, workspaceId } = await install();
    const project = await createProject(owner, workspaceId);
    const svc = await createService(owner, project.id);
    const envId = project.environments[0]!.id;
    const agent = await connect(await mint(owner, workspaceId, API_TOKEN_PRESETS.deploy));
    const other = await connect(await mint(owner, workspaceId, API_TOKEN_PRESETS.deploy));

    const staged = await tool<{ change_set_id: string; revision: number; review_url: string }>(
      agent,
      "stage_config_change",
      { service_id: svc.service.id, environment_id: envId, patch: { deploy: { replicas: 2 } } },
    );
    expect(staged.isError).toBe(false);

    const foreign = await tool<{ status: string; review_url: string }>(other, "apply_changes", {
      change_set_id: staged.body.change_set_id,
      expected_revision: staged.body.revision,
    });
    expect(foreign.body).toMatchObject({
      status: "awaiting_confirmation",
      review_url: staged.body.review_url,
    });

    const stale = await tool<{ status: string }>(agent, "apply_changes", {
      change_set_id: staged.body.change_set_id,
      expected_revision: staged.body.revision + 5,
    });
    expect(stale.body.status).toBe("awaiting_confirmation");

    await env.DB.prepare("UPDATE environments SET protected = 1 WHERE id = ?").bind(envId).run();
    const guarded = await tool<{ status: string }>(agent, "apply_changes", {
      change_set_id: staged.body.change_set_id,
      expected_revision: staged.body.revision,
    });
    expect(guarded.body.status).toBe("awaiting_confirmation");

    const config = await owner.json<{ version: number }>(
      `/v1/services/${svc.service.id}/config?environment_id=${envId}`,
    );
    expect(config.body.version).toBe(1);
    await agent.close();
    await other.close();
  });
});

describe("no secret values in any tool output", () => {
  it("returns plain values only, from every read tool", async () => {
    introspector = await introspectWorkflow(env.DEPLOY_WORKFLOW);
    const s = await stage();
    const vars = `/v1/services/${s.serviceId}/variables?environment_id=${s.envId}`;
    const seeded = await s.owner.json(vars, {
      method: "PUT",
      json: {
        set: [
          { key: "API_SECRET", value: SECRET_VALUE, tier: "secret" },
          { key: "DERIVED", value: DERIVED_VALUE },
          { key: "PUBLIC_URL", value: "https://shop.example" },
        ],
        confirm_write_only: true,
      },
    });
    expect(seeded.status).toBe(200);
    const shared = await s.owner.json(
      `/v1/projects/${s.project.id}/variables?environment_id=${s.envId}`,
      {
        method: "PUT",
        json: {
          set: [{ key: "SHARED_TOKEN", value: SHARED_SECRET_VALUE, tier: "secret" }],
          confirm_write_only: true,
        },
      },
    );
    expect(shared.status).toBe(200);

    const scopes = [...API_TOKEN_PRESETS.deploy, "variables:read_plain"];
    const client = await connect(await mint(s.owner, s.workspaceId, scopes));
    const deployed = await tool<{ id: string; status: string }>(client, "deploy_service", {
      service_id: s.serviceId,
      environment_id: s.envId,
    });
    expect(deployed.isError).toBe(false);
    expect(deployed.body.status).toBe("queued");
    await waitForStatus(s.owner, deployed.body.id, ["active"]);

    const outputs = [
      deployed,
      await tool(client, "list_workspaces"),
      await tool(client, "list_projects"),
      await tool(client, "get_project", { project_id: s.project.id }),
      await tool(client, "get_service", { service_id: s.serviceId }),
      await tool(client, "list_deployments", {
        service_id: s.serviceId,
        environment_id: s.envId,
      }),
      await tool(client, "get_deployment", { deployment_id: deployed.body.id }),
      await tool(client, "read_logs", { deployment_id: deployed.body.id }),
      await tool(client, "list_variables", {
        service_id: s.serviceId,
        environment_id: s.envId,
      }),
      await tool(client, "list_variables", {
        project_id: s.project.id,
        environment_id: s.envId,
      }),
      await tool(client, "resolve_variables", {
        service_id: s.serviceId,
        environment_id: s.envId,
      }),
      await tool(client, "list_nodes"),
    ];
    for (const out of outputs) {
      expect(out.isError).toBe(false);
      expect(out.text).not.toContain(SECRET_VALUE);
      expect(out.text).not.toContain(SHARED_SECRET_VALUE);
    }

    const listed = outputs[8]!.body as { variables: { key: string; value: string | null }[] };
    expect(listed.variables).toEqual([
      expect.objectContaining({ key: "API_SECRET", tier: "secret", value: null }),
      expect.objectContaining({ key: "DERIVED", value: DERIVED_VALUE }),
      expect.objectContaining({ key: "PUBLIC_URL", value: "https://shop.example" }),
    ]);
    const resolved = outputs[10]!.body as {
      variables: Record<string, string>;
      local_keys: string[];
    };
    expect(resolved.variables.PUBLIC_URL).toBe("https://shop.example");
    expect(resolved.variables).not.toHaveProperty("API_SECRET");
    expect(resolved.variables).not.toHaveProperty("DERIVED");
    expect(resolved.local_keys).toEqual(["API_SECRET", "DERIVED"]);

    const audit = await env.DB.prepare(
      "SELECT action, actor_type, metadata FROM audit_logs WHERE actor_type = 'token' ORDER BY seq",
    ).all<{ action: string; actor_type: string; metadata: string }>();
    expect(audit.results.map((r) => r.action)).toEqual([
      "deployment.created",
      "variables.resolved",
    ]);
    for (const row of audit.results) {
      expect(JSON.parse(row.metadata)).toMatchObject({ via: "mcp" });
      expect(row.metadata).not.toContain(SECRET_VALUE);
    }

    const rolled = await tool<{ id: string; trigger: string; rollback_of: string }>(
      client,
      "rollback_deployment",
      { deployment_id: deployed.body.id },
    );
    expect(rolled.isError).toBe(false);
    expect(rolled.body).toMatchObject({ trigger: "rollback", rollback_of: deployed.body.id });
    await waitForStatus(s.owner, rolled.body.id, ["active"]);
    await client.close();
  });
});

describe("cancel_deployment", () => {
  it("cancels a building deployment and audits it", async () => {
    introspector = await introspectWorkflow(env.DEPLOY_WORKFLOW);
    const s = await stage(GIT_SERVICE, { build: "silent" });
    const client = await connect(await mint(s.owner, s.workspaceId, API_TOKEN_PRESETS.deploy));
    const d = await tool<{ id: string }>(client, "deploy_service", {
      service_id: s.serviceId,
      environment_id: s.envId,
      commit_sha: COMMIT_SHA,
    });
    await waitForStatus(s.owner, d.body.id, ["building"]);
    await s.agent.waitFor((m) => m.type === "build_job");
    const cancelled = await tool<{ status: string }>(client, "cancel_deployment", {
      deployment_id: d.body.id,
    });
    expect(cancelled.body.status).toBe("cancelled");
    const again = await tool<{ error: { status: number } }>(client, "cancel_deployment", {
      deployment_id: d.body.id,
    });
    expect(again.body.error.status).toBe(409);
    const [instance] = await introspector.get();
    await instance!.waitForStatus("complete");
    const audit = await env.DB.prepare(
      "SELECT metadata FROM audit_logs WHERE action = 'deployment.cancelled'",
    ).first<{ metadata: string }>();
    expect(JSON.parse(audit!.metadata)).toMatchObject({ via: "mcp", tool: "cancel_deployment" });
    await client.close();
  });
});

describe("tool registry", () => {
  it("needs a scope for every tool and never a write scope for a read-only tool", () => {
    for (const t of MCP_TOOLS) {
      expect(t.scopes.length).toBeGreaterThan(0);
      if (t.annotations.readOnlyHint) {
        expect(t.scopes.some((s) => s.endsWith(":manage") || s.endsWith(":create"))).toBe(false);
      }
    }
  });
});
