/**
 * Templates: the built-in catalogue (every manifest valid, every service
 * config accepted by the API's own schemas), the gallery routes, creating a
 * project from a template and deploying one into an existing project (one
 * batch, slug suffixing with references following, generated secrets
 * minted server-side and stored write-only, the write-only confirmation,
 * RBAC including token scopes and environment protection, audit records
 * without values), a first deploy reaching `active`, and the MCP tools.
 */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${{…}}` is variable-reference syntax, not a template.
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createDb } from "@roundhouse/db";
import { defaultServiceConfig } from "@roundhouse/shared";
import { renderTemplate, TemplateSchema } from "@roundhouse/shared/template";
import { afterEach, describe, expect, it } from "vitest";
import { policyOf, TEMPLATE_ROUTES } from "../src/contracts";
import { app } from "../src/index";
import { databaseCreateOp } from "../src/lib/databases";
import { mergeConfig } from "../src/lib/projects";
import { BUILT_IN_TEMPLATES } from "../src/lib/template-catalogue";
import { openVariable, projectKey } from "../src/lib/variables";
import { ServiceSourceSchema } from "../src/schemas";
import { addMember, type Client as Browser, install, ORIGIN } from "./helpers";
import { createProject, createService, stage, waitForStatus } from "./pipeline-helpers";

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;

afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

interface ErrorBody {
  error: { code: string; message: string; details?: { field: string; code: string }[] };
}

interface Deployed {
  template: { id: string; version: number };
  project: { id: string; slug: string; name: string };
  environment: { id: string; slug: string };
  services: { id: string; slug: string; name: string }[];
  deployments: { id: string; service_id: string; trigger: string; status: string }[];
  deploy_errors: { service_id: string; message: string }[];
  warnings: { key: string; code: string }[];
}

interface Listed {
  variables: { key: string; value: string | null; tier: "plain" | "secret" }[];
}

const fromTemplate = (c: Browser, workspaceId: string, body: Record<string, unknown>) =>
  c.json<Deployed & ErrorBody>(`/v1/workspaces/${workspaceId}/projects/from-template`, {
    method: "POST",
    json: body,
  });

const intoProject = (c: Browser, projectId: string, body: Record<string, unknown>) =>
  c.json<Deployed & ErrorBody>(`/v1/projects/${projectId}/templates/deploy`, {
    method: "POST",
    json: body,
  });

const variablesOf = (c: Browser, serviceId: string, envId: string) =>
  c.json<Listed>(`/v1/services/${serviceId}/variables?environment_id=${envId}`);

async function auditRows(action: string) {
  const { results } = await env.DB.prepare(
    "SELECT action, target_id, metadata FROM audit_logs WHERE action = ? ORDER BY seq",
  )
    .bind(action)
    .all<{ action: string; target_id: string; metadata: string }>();
  return results.map((r) => ({
    ...r,
    metadata: JSON.parse(r.metadata) as Record<string, unknown>,
  }));
}

async function mint(c: Browser, workspaceId: string, scopes: readonly string[]) {
  const res = await c.json<{ secret: string }>(`/v1/workspaces/${workspaceId}/tokens`, {
    method: "POST",
    json: { name: "agent", scopes, expires_in_days: 30 },
  });
  if (res.status !== 201) throw new Error(`mint: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.secret;
}

describe("template contracts", () => {
  it("serves every route with its policy, and audits only deploys", () => {
    const live = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } });
    for (const [name, route] of Object.entries(TEMPLATE_ROUTES)) {
      const op = (live.paths?.[route.path] as Record<string, Record<string, unknown>>)?.[
        route.method
      ];
      expect(op, name).toBeDefined();
      const policy = policyOf(route);
      expect(policy.auth, name).toBe("session");
      if (route.method === "get") expect(policy.audit, name).toEqual([]);
      else expect(policy.audit, name).toContain("template.deployed");
      const placeholders = [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const declared = Object.keys(
        (route.request as { params: { shape: object } }).params.shape,
      ).sort();
      expect(declared, name).toEqual(placeholders.sort());
    }
  });
});

describe("built-in catalogue", () => {
  it("has unique ids and only manifests the schema accepts", () => {
    const ids = BUILT_IN_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(8);
    for (const t of BUILT_IN_TEMPLATES) {
      expect(TemplateSchema.safeParse(t).success, t.id).toBe(true);
    }
  });

  it.each(BUILT_IN_TEMPLATES.map((t) => [t.id, t] as const))(
    "%s renders and its configs pass the API's config schemas",
    (_id, t) => {
      const rendered = renderTemplate(t, {
        inputs: {},
        existingSlugs: [],
        randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
      });
      for (const s of rendered.services) {
        if (s.source.type === "database") {
          const op = databaseCreateOp({ ref: "new:1", database: s.source, config: s.config });
          expect(op.kind, s.ref).toBe("database");
          continue;
        }
        const source = ServiceSourceSchema.parse(s.source);
        const spec = mergeConfig(defaultServiceConfig(source), s.config);
        expect(spec.networking.port, s.ref).not.toBeNull();
        expect(spec.healthcheck, s.ref).not.toBeNull();
      }
    },
  );
});

describe("gallery", () => {
  it("lists templates and shows one without secret values", async () => {
    const { owner, workspaceId } = await install();
    const viewer = await addMember(owner, workspaceId, "v@example.com", "viewer");
    const list = await viewer.json<{ templates: { id: string; supported: boolean }[] }>(
      `/v1/workspaces/${workspaceId}/templates`,
    );
    expect(list.status).toBe(200);
    expect(list.body.templates.map((t) => t.id)).toEqual(BUILT_IN_TEMPLATES.map((t) => t.id));
    expect(list.body.templates.every((t) => t.supported)).toBe(true);

    const n8n = await viewer.json<{
      services: {
        variables: { key: string; secret: boolean; generated: boolean; value: string | null }[];
      }[];
      inputs: { key: string; default: string | null }[];
    }>(`/v1/workspaces/${workspaceId}/templates/n8n`);
    expect(n8n.status).toBe(200);
    expect(n8n.body.inputs).toEqual([expect.objectContaining({ key: "TIMEZONE", default: "UTC" })]);
    expect(n8n.body.services[0]!.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "N8N_ENCRYPTION_KEY",
          secret: true,
          generated: true,
          value: null,
        }),
        expect.objectContaining({ key: "TZ", secret: false, value: "${{input.TIMEZONE}}" }),
      ]),
    );

    expect((await viewer.json(`/v1/workspaces/${workspaceId}/templates/nope`)).status).toBe(404);
    expect((await viewer.json(`/v1/workspaces/${workspaceId}/templates/Not_A_Slug`)).status).toBe(
      400,
    );
    expect((await owner.json("/v1/workspaces/ws_other/templates")).status).toBe(404);
  });
});

describe("POST /v1/workspaces/{id}/projects/from-template", () => {
  it("creates the project, service and write-only generated secret in one go", async () => {
    const { owner, workspaceId } = await install();
    await createProject(owner, workspaceId, { name: "n8n" });

    const unconfirmed = await fromTemplate(owner, workspaceId, {
      template_id: "n8n",
      deploy: false,
    });
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.error.code).toBe("confirmation_required");
    expect(unconfirmed.body.error.details?.map((d) => d.field)).toEqual(["N8N_ENCRYPTION_KEY"]);
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM projects").first<{
      n: number;
    }>();
    expect(before!.n).toBe(1);

    const res = await fromTemplate(owner, workspaceId, {
      template_id: "n8n",
      inputs: { TIMEZONE: "Europe/Berlin" },
      deploy: false,
      confirm_write_only: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.template).toEqual({ id: "n8n", version: 1 });
    expect(res.body.project).toMatchObject({ name: "n8n", slug: "n8n-2" });
    expect(res.body.environment.slug).toBe("production");
    expect(res.body.services.map((s) => s.slug)).toEqual(["n8n"]);
    expect(res.body.deployments).toEqual([]);

    const svc = res.body.services[0]!;
    const config = await owner.json<{
      source: { type: string; image: string };
      networking: { port: number; generated_domain: boolean };
      healthcheck: { path: string };
    }>(`/v1/services/${svc.id}/config?environment_id=${res.body.environment.id}`);
    expect(config.body).toMatchObject({
      source: { type: "image", image: "n8nio/n8n:stable" },
      networking: { port: 5678, generated_domain: true },
      healthcheck: { path: "/healthz" },
    });

    const listed = await variablesOf(owner, svc.id, res.body.environment.id);
    expect(listed.body.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "N8N_ENCRYPTION_KEY", tier: "secret", value: null }),
        expect.objectContaining({ key: "GENERIC_TIMEZONE", tier: "plain", value: "Europe/Berlin" }),
        expect.objectContaining({ key: "TZ", tier: "plain", value: "Europe/Berlin" }),
      ]),
    );
    expect(JSON.stringify(res.body)).not.toMatch(/[0-9a-f]{64}/);

    const db = createDb(env.DB);
    const key = await projectKey(db, env, res.body.project.id);
    const row = await db.query.variables.findFirst({
      where: (v, { eq }) => eq(v.key, "N8N_ENCRYPTION_KEY"),
    });
    const secret = await openVariable(key, row!);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.fingerprint).toBeTruthy();

    const deployed = await auditRows("template.deployed");
    expect(deployed).toHaveLength(1);
    expect(deployed[0]!.metadata).toMatchObject({
      template_id: "n8n",
      template_version: 1,
      services: [{ id: svc.id, slug: "n8n", variables: expect.arrayContaining(["TZ"]) }],
      secret_keys: ["N8N_ENCRYPTION_KEY"],
      inputs: ["TIMEZONE"],
      deploy: false,
    });
    const created = [
      ...(await auditRows("project.created")),
      ...(await auditRows("service.created")),
    ];
    expect(created.map((r) => r.metadata.template_id)).toEqual([undefined, "n8n", "n8n"]);
    const everything = JSON.stringify(
      (await env.DB.prepare("SELECT metadata FROM audit_logs").all()).results,
    );
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain("Europe/Berlin");
  });

  it("mints a fresh secret per deploy", async () => {
    const { owner, workspaceId } = await install();
    const body = { template_id: "n8n", deploy: false, confirm_write_only: true };
    const a = await fromTemplate(owner, workspaceId, body);
    const b = await fromTemplate(owner, workspaceId, body);
    const db = createDb(env.DB);
    const values = await Promise.all(
      [a, b].map(async (r) => {
        const key = await projectKey(db, env, r.body.project.id);
        const row = await db.query.variables.findFirst({
          where: (v, { and, eq }) =>
            and(eq(v.projectId, r.body.project.id), eq(v.key, "N8N_ENCRYPTION_KEY")),
        });
        return openVariable(key, row!);
      }),
    );
    expect(values[0]).not.toBe(values[1]);
  });

  it("validates inputs, names and support before writing anything", async () => {
    const { owner, workspaceId } = await install();
    const unknown = await fromTemplate(owner, workspaceId, {
      template_id: "whoami",
      inputs: { NOPE: "x" },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details).toEqual([
      expect.objectContaining({ field: "inputs.NOPE", code: "unknown_input" }),
    ]);
    expect((await fromTemplate(owner, workspaceId, { template_id: "missing" })).status).toBe(404);
    const custom = await fromTemplate(owner, workspaceId, {
      template_id: "whoami",
      name: "Edge probe",
      slug: "probe",
      description: "Echoes requests",
      deploy: false,
    });
    expect(custom.status).toBe(201);
    expect(custom.body.project).toMatchObject({ name: "Edge probe", slug: "probe" });
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM projects").first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it("needs projects:create and every action the deploy performs", async () => {
    const { owner, workspaceId } = await install();
    const viewer = await addMember(owner, workspaceId, "v@example.com", "viewer");
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    const admin = await addMember(owner, workspaceId, "a@example.com", "admin");
    const body = { template_id: "whoami", deploy: false };
    expect((await fromTemplate(viewer, workspaceId, body)).status).toBe(403);
    expect((await fromTemplate(member, workspaceId, body)).status).toBe(403);
    expect((await fromTemplate(admin, workspaceId, body)).status).toBe(201);

    const narrow = await mint(owner, workspaceId, ["projects:create", "services:manage"]);
    const res = await SELF.fetch(`${ORIGIN}/v1/workspaces/${workspaceId}/projects/from-template`, {
      method: "POST",
      headers: { authorization: `Bearer ${narrow}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrorBody).error.message).toContain("variables:manage");
    const noDeploy = await mint(owner, workspaceId, [
      "projects:create",
      "services:manage",
      "variables:manage",
    ]);
    const refused = await SELF.fetch(
      `${ORIGIN}/v1/workspaces/${workspaceId}/projects/from-template`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${noDeploy}`, "content-type": "application/json" },
        body: JSON.stringify({ template_id: "whoami" }),
      },
    );
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as ErrorBody).error.message).toContain("deployments:create");
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM projects").first<{ n: number }>();
    expect(count!.n).toBe(1);
  });
});

describe("POST /v1/projects/{id}/templates/deploy", () => {
  it("adds services to every environment, suffixing taken slugs", async () => {
    const { owner, workspaceId } = await install();
    const project = await createProject(owner, workspaceId);
    const prod = project.environments[0]!.id;
    await createService(owner, project.id, {
      name: "api",
      source: { type: "image", image: "nginx:1.27" },
    });
    const staging = await owner.json<{ id: string }>(`/v1/projects/${project.id}/environments`, {
      method: "POST",
      json: { name: "staging", kind: "staging" },
    });

    const res = await intoProject(owner, project.id, {
      template_id: "express",
      environment_id: staging.body.id,
      deploy: false,
    });
    expect(res.status).toBe(201);
    expect(res.body.services.map((s) => s.slug)).toEqual(["api-2"]);
    const svc = res.body.services[0]!;
    for (const envId of [prod, staging.body.id]) {
      const config = await owner.json<{ version: number; source: { repo_url: string } }>(
        `/v1/services/${svc.id}/config?environment_id=${envId}`,
      );
      expect(config.body).toMatchObject({
        version: 1,
        source: { repo_url: "https://github.com/railwayapp-templates/expressjs" },
      });
    }
    expect((await variablesOf(owner, svc.id, staging.body.id)).body.variables).toEqual([
      expect.objectContaining({ key: "NODE_ENV", value: "production", tier: "plain" }),
    ]);
    expect((await variablesOf(owner, svc.id, prod)).body.variables).toEqual([]);

    const unknownEnv = await intoProject(owner, project.id, {
      template_id: "express",
      environment_id: "env_nope",
    });
    expect(unknownEnv.status).toBe(404);
  });

  it("honours environment protection for every action it performs", async () => {
    const { owner, workspaceId } = await install();
    const project = await createProject(owner, workspaceId);
    const prod = project.environments[0]!.id;
    const member = await addMember(owner, workspaceId, "dev@example.com", "member");
    const configOnly = {
      deploy: { roles: [], userIds: [], teamIds: [] },
      config: { roles: ["developer"], userIds: [], teamIds: [] },
      variables: { roles: [], userIds: [], teamIds: [] },
    };
    await env.DB.prepare("UPDATE environments SET protected = 1, protection_rules = ? WHERE id = ?")
      .bind(JSON.stringify(configOnly), prod)
      .run();
    const body = { template_id: "whoami", environment_id: prod, deploy: false };
    const refused = await intoProject(member, project.id, body);
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toContain("variables:manage");
    expect((await intoProject(owner, project.id, body)).status).toBe(201);
  });

  it("starts first deployments that reach active", async () => {
    introspector = await introspectWorkflow(env.DEPLOY_WORKFLOW);
    const s = await stage();
    const res = await intoProject(s.owner, s.project.id, {
      template_id: "whoami",
      environment_id: s.envId,
    });
    expect(res.status).toBe(201);
    expect(res.body.deploy_errors).toEqual([]);
    expect(res.body.deployments).toEqual([
      expect.objectContaining({ service_id: res.body.services[0]!.id, trigger: "template" }),
    ]);
    const active = await waitForStatus(s.owner, res.body.deployments[0]!.id, ["active", "failed"]);
    expect(active.status).toBe("active");
    expect(active.image).toBe("traefik/whoami:v1.12");
    expect((await auditRows("deployment.created")).at(-1)!.metadata).toMatchObject({
      service_id: res.body.services[0]!.id,
    });
  });
});

describe("MCP tools", () => {
  async function connect(secret: string) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO instance_settings (key, value, created_at, updated_at) VALUES ('mcp_enabled', 'true', 0, 0)",
    ).run();
    (env as { MCP_LIMITER?: RateLimit }).MCP_LIMITER = { limit: async () => ({ success: true }) };
    const client = new Client(
      { name: "roundhouse-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
        fetch: (url, init) => SELF.fetch(url, init),
        requestInit: { headers: { authorization: `Bearer ${secret}` } },
        onInsufficientScope: "throw",
      }),
    );
    return client;
  }

  async function callTool(client: Client, name: string, args: Record<string, unknown>) {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[]).map((c) => c.text).join("");
    return { isError: res.isError === true, body: JSON.parse(text) as Record<string, unknown> };
  }

  it("lists templates and deploys one through the REST path's checks", async () => {
    const { owner, workspaceId } = await install();
    const project = await createProject(owner, workspaceId);
    const prod = project.environments[0]!.id;
    const secret = await mint(owner, workspaceId, [
      "projects:read",
      "services:manage",
      "variables:manage",
    ]);
    const client = await connect(secret);

    const list = await callTool(client, "list_templates", {});
    expect(list.isError).toBe(false);
    expect((list.body.templates as { id: string }[]).map((t) => t.id)).toContain("n8n");

    const args = { template_id: "n8n", project_id: project.id, environment_id: prod };
    const unconfirmed = await callTool(client, "deploy_template", args);
    expect(unconfirmed.isError).toBe(true);
    expect(unconfirmed.body).toMatchObject({ error: { code: "confirmation_required" } });

    const noDeployScope = await callTool(client, "deploy_template", {
      ...args,
      confirm_write_only: true,
      deploy: true,
    });
    expect(noDeployScope.isError).toBe(true);
    expect(noDeployScope.body).toMatchObject({ error: { status: 403 } });

    const ok = await callTool(client, "deploy_template", { ...args, confirm_write_only: true });
    expect(ok.isError).toBe(false);
    expect((ok.body.services as { slug: string }[]).map((s) => s.slug)).toEqual(["n8n"]);
    expect(JSON.stringify(ok.body)).not.toMatch(/[0-9a-f]{64}/);
    const [entry] = await auditRows("template.deployed");
    expect(entry!.metadata).toMatchObject({
      via: "mcp",
      tool: "deploy_template",
      template_id: "n8n",
    });
  });
});
