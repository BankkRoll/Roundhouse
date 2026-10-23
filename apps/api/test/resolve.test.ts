/**
 * `POST /v1/services/{serviceId}/variables/resolve`: the fully resolved
 * environment through the deploy path's resolver (identical to what a
 * deployment's replicas get), built-ins included, audited, behind
 * `variables:reveal`, with reference errors reported per variable.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMember, type Client, install, joinNode } from "./helpers";
import {
  connectWorkloadAgent,
  createProject,
  createService,
  deploy,
  IMAGE_SERVICE,
  waitForStatus,
} from "./pipeline-helpers";

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
beforeEach(async () => {
  introspector = await introspectWorkflow(env.DEPLOY_WORKFLOW);
});
afterEach(async () => {
  await introspector?.dispose();
});

type Resolved = { variables: { key: string; value: string }[] };

/** A `${{…}}` variable reference, built so the linter doesn't take it for a template. */
const ref = (body: string) => `$\{{${body}}}`;

async function putVars(c: Client, path: string, set: unknown[]) {
  const res = await c.json(path, { method: "PUT", json: { set } });
  expect(res.status).toBe(200);
}

async function setup() {
  const installed = await install();
  const { owner, workspaceId } = installed;
  const agent = await connectWorkloadAgent(await joinNode(owner, workspaceId));
  const p = await createProject(owner, workspaceId);
  const envId = p.environments[0]!.id;
  const web = await createService(owner, p.id, IMAGE_SERVICE);
  const db = await createService(owner, p.id, { ...IMAGE_SERVICE, name: "db" });
  await putVars(owner, `/v1/projects/${p.id}/variables?environment_id=${envId}`, [
    { key: "DB_NAME", value: "shop" },
  ]);
  await putVars(owner, `/v1/services/${db.service.id}/variables?environment_id=${envId}`, [
    { key: "PASSWORD", value: "hunter2-long-secret", is_secret: true },
  ]);
  await putVars(owner, `/v1/services/${web.service.id}/variables?environment_id=${envId}`, [
    {
      key: "DATABASE_URL",
      value: `postgres://app:${ref("db.PASSWORD")}@${ref("db.OPENRAIL_PRIVATE_DOMAIN")}:5432/${ref("shared.DB_NAME")}`,
    },
    { key: "API_KEY", value: "sk_live_123", is_secret: true },
    { key: "LISTEN", value: `0.0.0.0:${ref("PORT")}` },
    { key: "LITERAL", value: `$${ref("not a ref")}` },
  ]);
  return {
    ...installed,
    agent,
    project: p,
    envId,
    webId: web.service.id,
    path: `/v1/services/${web.service.id}/variables/resolve?environment_id=${envId}`,
  };
}

describe("resolving a service's environment", () => {
  it("returns built-ins and substituted values, sorted, and audits the keys only", async () => {
    const s = await setup();
    const res = await s.owner.json<Resolved>(s.path, { method: "POST" });
    expect(res.status).toBe(200);
    const byKey = Object.fromEntries(res.body.variables.map((v) => [v.key, v.value]));
    expect(byKey).toMatchObject({
      API_KEY: "sk_live_123",
      LISTEN: "0.0.0.0:8080",
      LITERAL: ref("not a ref"),
      OPENRAIL_ENVIRONMENT: "production",
      OPENRAIL_SERVICE_NAME: "web",
      PORT: "8080",
    });
    expect(byKey.DATABASE_URL).toMatch(/^postgres:\/\/app:hunter2-long-secret@db\..+:5432\/shop$/);
    expect(byKey.DATABASE_URL).toContain(byKey.OPENRAIL_PRIVATE_DOMAIN!.replace(/^web/, "db"));
    // Nothing has been deployed, so there are no deployment built-ins.
    expect(byKey).not.toHaveProperty("OPENRAIL_DEPLOYMENT_ID");
    // Shared variables are injected only where referenced, as on deploy.
    expect(byKey).not.toHaveProperty("DB_NAME");
    const keys = res.body.variables.map((v) => v.key);
    expect(keys).toEqual([...keys].sort());

    const audit = await env.DB.prepare(
      "SELECT actor_type, target_id, metadata FROM audit_logs WHERE action = 'variables.resolved'",
    ).first<{ actor_type: string; target_id: string; metadata: string }>();
    expect(audit).toMatchObject({ actor_type: "user", target_id: s.webId });
    expect(JSON.parse(audit!.metadata)).toEqual({ environment_id: s.envId, keys });
    expect(audit!.metadata).not.toContain("sk_live_123");
    expect(audit!.metadata).not.toContain("hunter2");
  });

  it("matches the environment a deployment's replicas get exactly", async () => {
    const s = await setup();
    const d = await deploy(s.owner, s.webId, s.envId);
    await waitForStatus(s.owner, d.id, ["active"]);
    const workload = s.agent.desired()!.workloads.find((w) => w.deployment_id === d.id)!;
    const res = await s.owner.json<Resolved>(s.path, { method: "POST" });
    expect(Object.fromEntries(res.body.variables.map((v) => [v.key, v.value]))).toEqual(
      workload.env,
    );
    expect(res.body.variables).toContainEqual({ key: "OPENRAIL_DEPLOYMENT_ID", value: d.id });
  });

  it("reports unknown references and cycles per variable", async () => {
    const s = await setup();
    await putVars(s.owner, `/v1/services/${s.webId}/variables?environment_id=${s.envId}`, [
      { key: "BROKEN", value: ref("nope.VALUE") },
      { key: "A", value: ref("B") },
      { key: "B", value: ref("A") },
    ]);
    const res = await s.owner.json<{
      error: { code: string; details: { field: string; code: string }[] };
    }>(s.path, { method: "POST" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_reference");
    const fields = res.body.error.details.map((d) => d.field);
    expect(fields).toContain("web.BROKEN");
    expect(fields.some((f) => f === "web.A" || f === "web.B")).toBe(true);
    const n = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_logs WHERE action = 'variables.resolved'",
    ).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("needs variables:reveal, from a role or a token scope", async () => {
    const s = await setup();
    const member = await addMember(s.owner, s.workspaceId, "m@example.com", "member");
    expect((await member.json(s.path, { method: "POST" })).status).toBe(403);
    const mint = async (scopes: string[]) =>
      (
        await s.owner.json<{ secret: string }>(`/v1/workspaces/${s.workspaceId}/tokens`, {
          method: "POST",
          json: { name: "run", scopes, expires_in_days: 1 },
        })
      ).body.secret;
    const withScope = await mint(["variables:reveal"]);
    const without = await mint(["variables:read"]);
    const call = (secret: string) =>
      s.owner.json(s.path, { method: "POST", headers: { authorization: `Bearer ${secret}` } });
    expect((await call(withScope)).status).toBe(200);
    expect((await call(without)).status).toBe(403);
    const audit = await env.DB.prepare(
      "SELECT actor_type FROM audit_logs WHERE action = 'variables.resolved'",
    ).first<{ actor_type: string }>();
    expect(audit?.actor_type).toBe("token");
  });

  it("404s for an environment of another project", async () => {
    const s = await setup();
    const other = await createProject(s.owner, s.workspaceId, { name: "Other" });
    const res = await s.owner.json(
      `/v1/services/${s.webId}/variables/resolve?environment_id=${other.environments[0]!.id}`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
  });
});
