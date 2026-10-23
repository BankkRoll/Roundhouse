/**
 * Project summaries (one project, or every project of a workspace) with each
 * service's latest config version, first domain and newest deployment, in a
 * fixed number of queries; project lookup by slug; and `project_id` on every
 * deployment response.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMember, type Client, install, joinNode } from "./helpers";
import {
  connectWorkloadAgent,
  createProject,
  createService,
  type DeploymentBody,
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

interface ServiceSummary {
  service: { id: string; slug: string };
  config_version: number | null;
  source: { type: string } | null;
  domain: { hostname: string; url: string } | null;
  latest_deployment: (DeploymentBody & { project_id: string }) | null;
}

interface ProjectSummary {
  id: string;
  name: string;
  environment: { id: string; kind: string } | null;
  environments: { id: string }[];
  services: ServiceSummary[];
}

async function setAppsDomain(owner: Client) {
  const res = await owner.json("/v1/instance/settings", {
    method: "PATCH",
    json: { apps_domain: "apps.example.com", tls_mode: "off" },
  });
  expect(res.status).toBe(200);
}

/** Counts D1 statements the Worker runs while `fn` does. */
async function countStatements(fn: () => Promise<unknown>): Promise<number> {
  const real = env.DB;
  let n = 0;
  (env as { DB: D1Database }).DB = new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "prepare") {
        return (query: string) => {
          n++;
          return value.call(target, query);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    await fn();
  } finally {
    (env as { DB: D1Database }).DB = real;
  }
  return n;
}

describe("project summary", () => {
  it("carries each service's config version, domain and newest deployment", async () => {
    const { owner, workspaceId } = await install();
    await setAppsDomain(owner);
    await connectWorkloadAgent(await joinNode(owner, workspaceId));
    const p = await createProject(owner, workspaceId);
    const web = await createService(owner, p.id, {
      ...IMAGE_SERVICE,
      config: { networking: { generated_domain: true } },
    });
    const worker = await createService(owner, p.id, { ...IMAGE_SERVICE, name: "worker" });
    const envId = p.environments[0]!.id;
    const d = await deploy(owner, web.service.id, envId);
    await waitForStatus(owner, d.id, ["active"]);
    await owner.json(`/v1/services/${web.service.id}`, {
      method: "PATCH",
      json: { environment_id: envId, deploy: { replicas: 1, drain_s: 5 } },
    });

    const res = await owner.json<ProjectSummary>(`/v1/projects/${p.id}/summary`);
    expect(res.status).toBe(200);
    expect(res.body.environment).toMatchObject({ id: envId, kind: "production" });
    const [a, b] = res.body.services;
    expect(a!.service.id).toBe(web.service.id);
    expect(a!.config_version).toBe(2);
    expect(a!.source).toEqual(IMAGE_SERVICE.source);
    expect(a!.domain?.hostname).toMatch(/^web-production-[a-z0-9]{4}\.apps\.example\.com$/);
    expect(a!.domain?.url).toBe(`http://${a!.domain!.hostname}`);
    expect(a!.latest_deployment).toMatchObject({
      id: d.id,
      project_id: p.id,
      status: "active",
      config_version: 1,
    });
    expect(b).toMatchObject({
      service: { id: worker.service.id },
      config_version: 1,
      domain: null,
      latest_deployment: null,
    });

    const staging = await owner.json<{ id: string }>(`/v1/projects/${p.id}/environments`, {
      method: "POST",
      json: { name: "Staging", kind: "staging" },
    });
    const inStaging = await owner.json<ProjectSummary>(
      `/v1/projects/${p.id}/summary?environment_id=${staging.body.id}`,
    );
    expect(inStaging.body.environment?.id).toBe(staging.body.id);
    expect(inStaging.body.environments).toHaveLength(2);
    expect(inStaging.body.services.map((s) => s.latest_deployment)).toEqual([null, null]);
    expect(inStaging.body.services.map((s) => s.config_version)).toEqual([1, 1]);
  });

  it("costs the same number of queries for one service or many", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    await createService(owner, p.id);
    const one = await countStatements(() => owner.json(`/v1/projects/${p.id}/summary`));
    for (const name of ["a", "b", "c", "d"]) {
      await createService(owner, p.id, { ...IMAGE_SERVICE, name });
    }
    const many = await countStatements(() => owner.json(`/v1/projects/${p.id}/summary`));
    expect(many).toBe(one);

    const other = await createProject(owner, workspaceId, { name: "Other" });
    await createService(owner, other.id);
    const workspace = await countStatements(() =>
      owner.json(`/v1/workspaces/${workspaceId}/projects/summary`),
    );
    await createProject(owner, workspaceId, { name: "Third" });
    const more = await countStatements(() =>
      owner.json(`/v1/workspaces/${workspaceId}/projects/summary`),
    );
    expect(more).toBe(workspace);
  });

  it("is readable by any member and API tokens with projects:read, and 404s otherwise", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const viewer = await addMember(owner, workspaceId, "v@example.com", "viewer");
    expect((await viewer.json(`/v1/projects/${p.id}/summary`)).status).toBe(200);
    const token = await owner.json<{ secret: string }>(`/v1/workspaces/${workspaceId}/tokens`, {
      method: "POST",
      json: { name: "ro", scopes: ["projects:read"], expires_in_days: 1 },
    });
    const viaToken = await viewer.json(`/v1/projects/${p.id}/summary`, {
      headers: { authorization: `Bearer ${token.body.secret}` },
    });
    expect(viaToken.status).toBe(200);

    const other = await owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Other" },
    });
    const outsider = await addMember(owner, other.body.id, "o@example.com", "admin");
    expect((await outsider.json(`/v1/projects/${p.id}/summary`)).status).toBe(404);
    expect((await outsider.json(`/v1/workspaces/${workspaceId}/projects/summary`)).status).toBe(
      404,
    );
    const elsewhere = await createProject(owner, other.body.id);
    const foreignEnv = await owner.json(
      `/v1/projects/${p.id}/summary?environment_id=${elsewhere.environments[0]!.id}`,
    );
    expect(foreignEnv.status).toBe(404);
  });
});

describe("workspace summary", () => {
  it("summarises every live project in production, by name", async () => {
    const { owner, workspaceId } = await install();
    await connectWorkloadAgent(await joinNode(owner, workspaceId));
    const zeta = await createProject(owner, workspaceId, { name: "Zeta" });
    const alpha = await createProject(owner, workspaceId, { name: "Alpha" });
    const gone = await createProject(owner, workspaceId, { name: "Gone" });
    const svc = await createService(owner, zeta.id);
    const d = await deploy(owner, svc.service.id, zeta.environments[0]!.id);
    await waitForStatus(owner, d.id, ["active"]);
    await owner.request(`/v1/projects/${gone.id}`, { method: "DELETE" });

    const res = await owner.json<{ projects: ProjectSummary[] }>(
      `/v1/workspaces/${workspaceId}/projects/summary`,
    );
    expect(res.status).toBe(200);
    expect(res.body.projects.map((p) => p.name)).toEqual(["Alpha", "Zeta"]);
    expect(res.body.projects[0]).toMatchObject({ id: alpha.id, services: [] });
    const single = await owner.json<ProjectSummary>(`/v1/projects/${zeta.id}/summary`);
    expect(res.body.projects[1]).toEqual(single.body);
    expect(single.body.services[0]!.latest_deployment?.id).toBe(d.id);
  });
});

describe("project lookup by slug", () => {
  it("returns the one live project with that exact slug", async () => {
    const { owner, workspaceId } = await install();
    const shop = await createProject(owner, workspaceId, { name: "Shop" });
    await createProject(owner, workspaceId, { name: "Shop" });
    const find = (slug: string) =>
      owner.json<{ projects: { id: string; slug: string }[] }>(
        `/v1/workspaces/${workspaceId}/projects?slug=${encodeURIComponent(slug)}`,
      );
    expect((await find("shop")).body.projects.map((p) => p.id)).toEqual([shop.id]);
    expect((await find("shop-2")).body.projects.map((p) => p.slug)).toEqual(["shop-2"]);
    expect((await find("sho")).body.projects).toEqual([]);
    expect((await find("Not A Slug")).status).toBe(400);
    await owner.request(`/v1/projects/${shop.id}`, { method: "DELETE" });
    expect((await find("shop")).body.projects).toEqual([]);
  });
});

describe("deployment responses", () => {
  it("carry project_id everywhere", async () => {
    const { owner, workspaceId } = await install();
    await connectWorkloadAgent(await joinNode(owner, workspaceId));
    const p = await createProject(owner, workspaceId);
    const svc = await createService(owner, p.id);
    const envId = p.environments[0]!.id;
    const created = await deploy(owner, svc.service.id, envId);
    expect(created).toMatchObject({ project_id: p.id });
    const active = await waitForStatus(owner, created.id, ["active"]);
    expect(active).toMatchObject({ project_id: p.id });
    const page = await owner.json<{ deployments: { project_id: string }[] }>(
      `/v1/services/${svc.service.id}/deployments?environment_id=${envId}`,
    );
    expect(page.body.deployments.map((d) => d.project_id)).toEqual([p.id]);
    const rollback = await owner.json<{ project_id: string }>(
      `/v1/deployments/${created.id}/rollback`,
      { method: "POST" },
    );
    expect(rollback.body.project_id).toBe(p.id);
  });
});
