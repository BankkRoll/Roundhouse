/**
 * Services, config versions and domains: creation defaults, generated
 * hostnames, immutable versions with optimistic concurrency, RBAC, and
 * cross-workspace isolation.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addMember, type Client, install } from "./helpers";
import { createProject, createService, IMAGE_SERVICE } from "./pipeline-helpers";

interface Config {
  id: string;
  version: number;
  environment_id: string;
  source: { type: string };
  build: { builder: string };
  deploy: { replicas: number; drain_s: number; restart_policy: string };
  resources: { cpu_millis: number; memory_mb: number };
  healthcheck: unknown;
  networking: { port: number | null; generated_domain: boolean };
  created_by: string | null;
}

async function setAppsDomain(owner: Client, domain: string | null, tls = "off") {
  const res = await owner.json("/v1/instance/settings", {
    method: "PATCH",
    json: { apps_domain: domain, tls_mode: tls },
  });
  expect(res.status).toBe(200);
}

describe("services", () => {
  it("creates config version 1 from defaults merged with the body, in every environment", async () => {
    const { owner, workspaceId, userId } = await install();
    const p = await createProject(owner, workspaceId);
    await owner.json(`/v1/projects/${p.id}/environments`, {
      method: "POST",
      json: { name: "staging", kind: "staging" },
    });
    const res = await owner.json<{ service: { slug: string; kind: string }; configs: Config[] }>(
      `/v1/projects/${p.id}/services`,
      {
        method: "POST",
        json: {
          name: "API Server",
          source: { type: "image", image: "ghcr.io/acme/api:1.2" },
          config: { deploy: { replicas: 2 }, resources: { memory_mb: 256 } },
        },
      },
    );
    expect(res.status).toBe(201);
    expect(res.body.service).toMatchObject({ slug: "api-server", kind: "app" });
    expect(res.body.configs).toHaveLength(2);
    for (const c of res.body.configs) {
      expect(c).toMatchObject({
        version: 1,
        created_by: userId,
        deploy: { replicas: 2, restart_policy: "on_failure", drain_s: 10 },
        resources: { cpu_millis: 1000, memory_mb: 256 },
        networking: { port: 8080, generated_domain: false },
        healthcheck: null,
      });
    }
  });

  it("validates the merged config and the slug", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const cases: [Record<string, unknown>, number][] = [
      [{ name: "x", slug: "shared", source: IMAGE_SERVICE.source }, 400],
      [{ name: "x", source: { type: "image", image: "Bad Image" } }, 400],
      [{ name: "x", source: IMAGE_SERVICE.source, config: { deploy: { replicas: 99 } } }, 400],
      [
        {
          name: "x",
          source: IMAGE_SERVICE.source,
          config: {
            healthcheck: {
              type: "http",
              interval_s: 5,
              timeout_s: 2,
              retries: 3,
              start_period_s: 0,
            },
          },
        },
        400,
      ],
    ];
    for (const [body, status] of cases) {
      const res = await owner.json(`/v1/projects/${p.id}/services`, { method: "POST", json: body });
      expect(res.status, JSON.stringify(body)).toBe(status);
    }
    await createService(owner, p.id, { ...IMAGE_SERVICE, slug: "web" });
    const dup = await owner.json(`/v1/projects/${p.id}/services`, {
      method: "POST",
      json: { ...IMAGE_SERVICE, slug: "web" },
    });
    expect(dup.status).toBe(409);
    const derived = await createService(owner, p.id, IMAGE_SERVICE);
    expect(derived.service.slug).toBe("web-2");
  });

  it("generates a hostname under the apps domain, retrying on collisions", async () => {
    const { owner, workspaceId } = await install();
    await setAppsDomain(owner, "apps.example.com");
    const p = await createProject(owner, workspaceId);
    const svc = await createService(owner, p.id, {
      ...IMAGE_SERVICE,
      config: { networking: { generated_domain: true } },
    });
    const res = await owner.json<{
      domains: {
        hostname: string;
        url: string;
        type: string;
        tls_status: string;
        target_port: number;
      }[];
    }>(`/v1/services/${svc.service.id}/domains`);
    expect(res.body.domains).toHaveLength(1);
    expect(res.body.domains[0]).toMatchObject({
      type: "generated",
      target_port: 8080,
      tls_status: "disabled",
    });
    expect(res.body.domains[0]!.hostname).toMatch(
      /^web-production-[a-z0-9]{4}\.apps\.example\.com$/,
    );
    expect(res.body.domains[0]!.url).toBe(`http://${res.body.domains[0]!.hostname}`);

    const none = await createService(owner, p.id, { name: "worker", source: IMAGE_SERVICE.source });
    const noDomains = await owner.json<{ domains: unknown[] }>(
      `/v1/services/${none.service.id}/domains`,
    );
    expect(noDomains.body.domains).toEqual([]);
  });

  it("makes no generated domain without an apps domain", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const svc = await createService(owner, p.id, {
      ...IMAGE_SERVICE,
      config: { networking: { generated_domain: true } },
    });
    const res = await owner.json<{ domains: unknown[] }>(`/v1/services/${svc.service.id}/domains`);
    expect(res.body.domains).toEqual([]);
  });
});

describe("service updates", () => {
  it("stores each config change as a new immutable version and doesn't deploy", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const envId = p.environments[0]!.id;
    const svc = await createService(owner, p.id);
    const res = await owner.json<{ service: { name: string }; config: Config }>(
      `/v1/services/${svc.service.id}`,
      {
        method: "PATCH",
        json: { environment_id: envId, deploy: { replicas: 3 }, name: "Web" },
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.service.name).toBe("Web");
    expect(res.body.config).toMatchObject({ version: 2, deploy: { replicas: 3, drain_s: 10 } });

    const v1 = await owner.json<Config>(
      `/v1/services/${svc.service.id}/config?environment_id=${envId}&version=1`,
    );
    expect(v1.body.deploy.replicas).toBe(1);
    const latest = await owner.json<Config>(
      `/v1/services/${svc.service.id}/config?environment_id=${envId}`,
    );
    expect(latest.body.version).toBe(2);
    expect(
      (await owner.json(`/v1/services/${svc.service.id}/config?environment_id=${envId}&version=9`))
        .status,
    ).toBe(404);

    const deployments = await env.DB.prepare("SELECT count(*) AS n FROM deployments").first<{
      n: number;
    }>();
    expect(deployments?.n).toBe(0);

    const meta = await owner.json<{ config: Config | null }>(`/v1/services/${svc.service.id}`, {
      method: "PATCH",
      json: { icon: "rocket" },
    });
    expect(meta.body.config).toBeNull();
  });

  it("rejects a stale expected_version with 409", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const envId = p.environments[0]!.id;
    const svc = await createService(owner, p.id);
    const ok = await owner.json(`/v1/services/${svc.service.id}`, {
      method: "PATCH",
      json: { environment_id: envId, expected_version: 1, resources: { cpu_millis: 500 } },
    });
    expect(ok.status).toBe(200);
    const stale = await owner.json(`/v1/services/${svc.service.id}`, {
      method: "PATCH",
      json: { environment_id: envId, expected_version: 1, resources: { cpu_millis: 250 } },
    });
    expect(stale.status).toBe(409);
  });

  it("replaces the source and healthcheck whole and checks cross-field rules", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const envId = p.environments[0]!.id;
    const svc = await createService(owner, p.id);
    const res = await owner.json<{ config: Config }>(`/v1/services/${svc.service.id}`, {
      method: "PATCH",
      json: {
        environment_id: envId,
        source: { type: "git", repo_url: "https://github.com/a/b", branch: "main", root_dir: "." },
        healthcheck: {
          type: "http",
          path: "/health",
          interval_s: 5,
          timeout_s: 2,
          retries: 3,
          start_period_s: 0,
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.config.source.type).toBe("git");
    const cleared = await owner.json<{ config: Config }>(`/v1/services/${svc.service.id}`, {
      method: "PATCH",
      json: { environment_id: envId, healthcheck: null },
    });
    expect(cleared.body.config.healthcheck).toBeNull();
    const noEnv = await owner.json(`/v1/services/${svc.service.id}`, {
      method: "PATCH",
      json: { deploy: { replicas: 2 } },
    });
    expect(noEnv.status).toBe(400);
  });

  it("adds a generated domain when enabled later", async () => {
    const { owner, workspaceId } = await install();
    await setAppsDomain(owner, "apps.example.com", "acme");
    const p = await createProject(owner, workspaceId);
    const envId = p.environments[0]!.id;
    const svc = await createService(owner, p.id);
    await owner.json(`/v1/services/${svc.service.id}`, {
      method: "PATCH",
      json: { environment_id: envId, networking: { generated_domain: true, port: 3000 } },
    });
    const res = await owner.json<{
      domains: { target_port: number; url: string; tls_status: string }[];
    }>(`/v1/services/${svc.service.id}/domains?environment_id=${envId}`);
    expect(res.body.domains).toHaveLength(1);
    expect(res.body.domains[0]).toMatchObject({ target_port: 3000, tls_status: "pending" });
    expect(res.body.domains[0]!.url).toMatch(/^https:\/\//);
  });
});

describe("service access", () => {
  it.each([
    ["viewer", 403],
    ["member", 200],
  ] as const)("lets a %s change services as the role allows", async (role, write) => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const svc = await createService(owner, p.id);
    const c = await addMember(owner, workspaceId, `${role}@example.com`, role);
    expect((await c.json(`/v1/projects/${p.id}/services`)).status).toBe(200);
    expect((await c.json(`/v1/services/${svc.service.id}`)).status).toBe(200);
    const patch = await c.json(`/v1/services/${svc.service.id}`, {
      method: "PATCH",
      json: { name: "renamed" },
    });
    expect(patch.status).toBe(write);
    const create = await c.json(`/v1/projects/${p.id}/services`, {
      method: "POST",
      json: { name: "new", source: IMAGE_SERVICE.source },
    });
    expect(create.status).toBe(write === 200 ? 201 : 403);
  });

  it("hides services of other workspaces and soft-deletes", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const svc = await createService(owner, p.id);
    const ws2 = await owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Other" },
    });
    const outsider = await addMember(owner, ws2.body.id, "o@example.com", "admin");
    const envId = p.environments[0]!.id;
    for (const path of [
      `/v1/services/${svc.service.id}`,
      `/v1/services/${svc.service.id}/config?environment_id=${envId}`,
      `/v1/services/${svc.service.id}/domains`,
      `/v1/services/${svc.service.id}/variables?environment_id=${envId}`,
    ]) {
      expect((await outsider.json(path)).status, path).toBe(404);
    }
    expect(
      (await outsider.request(`/v1/services/${svc.service.id}`, { method: "DELETE" })).status,
    ).toBe(404);

    expect(
      (await owner.request(`/v1/services/${svc.service.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect((await owner.json(`/v1/services/${svc.service.id}`)).status).toBe(404);
    const list = await owner.json<{ services: unknown[] }>(`/v1/projects/${p.id}/services`);
    expect(list.body.services).toEqual([]);
    const reused = await createService(owner, p.id);
    expect(reused.service.slug).toBe("web");
  });
});
