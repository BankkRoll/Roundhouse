/**
 * Projects and environments: CRUD, slugs, RBAC per role, cross-workspace
 * isolation, soft delete, and environment copies.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addMember, type Client, install } from "./helpers";
import { createProject, createService, type ProjectDetailBody } from "./pipeline-helpers";

async function secondWorkspace(owner: Client) {
  const ws = await owner.json<{ id: string }>("/v1/workspaces", {
    method: "POST",
    json: { name: "Elsewhere" },
  });
  return ws.body.id;
}

describe("projects", () => {
  it("creates a project with a production environment and a sealed data key", async () => {
    const { owner, workspaceId } = await install();
    const res = await owner.json<ProjectDetailBody>(`/v1/workspaces/${workspaceId}/projects`, {
      method: "POST",
      json: { name: "Storefront API", description: "Main shop" },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      workspace_id: workspaceId,
      name: "Storefront API",
      slug: "storefront-api",
      description: "Main shop",
      services: [],
    });
    expect(res.body.environments).toEqual([
      expect.objectContaining({ name: "production", slug: "production", kind: "production" }),
    ]);
    const key = await env.DB.prepare("SELECT dek_sealed FROM project_keys WHERE project_id = ?")
      .bind(res.body.id)
      .first<{ dek_sealed: string }>();
    expect(JSON.parse(key!.dek_sealed)).toMatchObject({ v: 1, iv: expect.any(String) });
    const audit = await env.DB.prepare("SELECT action FROM audit_logs WHERE target_id = ?")
      .bind(res.body.id)
      .first<{ action: string }>();
    expect(audit?.action).toBe("project.created");
  });

  it("derives unique slugs and rejects a taken explicit slug", async () => {
    const { owner, workspaceId } = await install();
    const a = await createProject(owner, workspaceId, { name: "Shop" });
    const b = await createProject(owner, workspaceId, { name: "Shop" });
    expect([a.slug, b.slug]).toEqual(["shop", "shop-2"]);
    const dup = await owner.json(`/v1/workspaces/${workspaceId}/projects`, {
      method: "POST",
      json: { name: "Other", slug: "shop" },
    });
    expect(dup.status).toBe(409);
    const bad = await owner.json(`/v1/workspaces/${workspaceId}/projects`, {
      method: "POST",
      json: { name: "x", slug: "Not A Slug" },
    });
    expect(bad.status).toBe(400);
    expect(
      (await owner.json(`/v1/workspaces/${workspaceId}/projects`, { method: "POST", json: {} }))
        .status,
    ).toBe(400);
  });

  it("lists, reads and updates projects", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId, { name: "Zeta" });
    await createProject(owner, workspaceId, { name: "Alpha" });
    const list = await owner.json<{ projects: { name: string }[] }>(
      `/v1/workspaces/${workspaceId}/projects`,
    );
    expect(list.body.projects.map((x) => x.name)).toEqual(["Alpha", "Zeta"]);

    const patched = await owner.json<{ name: string; description: string | null }>(
      `/v1/projects/${p.id}`,
      { method: "PATCH", json: { name: "Zeta 2", description: null } },
    );
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ name: "Zeta 2", description: null });
    expect((await owner.json(`/v1/projects/${p.id}`, { method: "PATCH", json: {} })).status).toBe(
      400,
    );
    const taken = await owner.json(`/v1/projects/${p.id}`, {
      method: "PATCH",
      json: { slug: "alpha" },
    });
    expect(taken.status).toBe(409);
    const got = await owner.json<ProjectDetailBody>(`/v1/projects/${p.id}`);
    expect(got.body.environments).toHaveLength(1);
  });

  it("soft-deletes a project, freeing its slug and hiding it", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId, { name: "Gone" });
    await createService(owner, p.id);
    expect((await owner.request(`/v1/projects/${p.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await owner.json(`/v1/projects/${p.id}`)).status).toBe(404);
    expect((await owner.request(`/v1/projects/${p.id}`, { method: "DELETE" })).status).toBe(404);
    const again = await createProject(owner, workspaceId, { name: "Gone" });
    expect(again.slug).toBe("gone");
    const row = await env.DB.prepare("SELECT deleted_at FROM services WHERE project_id = ?")
      .bind(p.id)
      .first<{ deleted_at: number | null }>();
    expect(row?.deleted_at).not.toBeNull();
  });

  it.each([
    ["viewer", { read: 200, manage: 403 }],
    ["member", { read: 200, manage: 403 }],
    ["admin", { read: 200, manage: 201 }],
  ] as const)("lets a %s read and manage as the role allows", async (role, expected) => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const c = await addMember(owner, workspaceId, `${role}@example.com`, role);
    expect((await c.json(`/v1/workspaces/${workspaceId}/projects`)).status).toBe(expected.read);
    expect((await c.json(`/v1/projects/${p.id}`)).status).toBe(expected.read);
    expect((await c.json(`/v1/projects/${p.id}/environments`)).status).toBe(expected.read);
    const create = await c.json(`/v1/workspaces/${workspaceId}/projects`, {
      method: "POST",
      json: { name: `by ${role}` },
    });
    expect(create.status).toBe(expected.manage);
    const patch = await c.json(`/v1/projects/${p.id}`, { method: "PATCH", json: { name: "x" } });
    expect(patch.status).toBe(expected.manage === 201 ? 200 : 403);
    const envRes = await c.json(`/v1/projects/${p.id}/environments`, {
      method: "POST",
      json: { name: "staging", kind: "staging" },
    });
    expect(envRes.status).toBe(expected.manage);
    if (expected.manage === 403) {
      expect((await c.request(`/v1/projects/${p.id}`, { method: "DELETE" })).status).toBe(403);
    }
  });

  it("returns 404 for projects in a workspace the caller isn't in", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const other = await secondWorkspace(owner);
    const outsider = await addMember(owner, other, "out@example.com", "admin");
    for (const path of [
      `/v1/projects/${p.id}`,
      `/v1/projects/${p.id}/environments`,
      `/v1/projects/${p.id}/services`,
      `/v1/workspaces/${workspaceId}/projects`,
    ]) {
      const res = await outsider.json<{ error: { message: string } }>(path);
      expect(res.status, path).toBe(404);
    }
    const del = await outsider.request(`/v1/projects/${p.id}`, { method: "DELETE" });
    expect(del.status).toBe(404);
    expect((await outsider.json(`/v1/projects/prj_missing`)).status).toBe(404);
  });

  it("requires a session", async () => {
    const { workspaceId } = await install();
    const { call } = await import("./helpers");
    expect((await call(`/v1/workspaces/${workspaceId}/projects`)).status).toBe(401);
  });
});

describe("environments", () => {
  it("creates a staging environment with default configs for every service", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const svc = await createService(owner, p.id, {
      name: "web",
      source: { type: "image", image: "nginx:1.27" },
      config: { deploy: { replicas: 3 } },
    });
    const res = await owner.json<{ id: string; slug: string; kind: string }>(
      `/v1/projects/${p.id}/environments`,
      { method: "POST", json: { name: "Staging", kind: "staging" } },
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ slug: "staging", kind: "staging" });
    const cfg = await owner.json<{ version: number; deploy: { replicas: number } }>(
      `/v1/services/${svc.service.id}/config?environment_id=${res.body.id}`,
    );
    expect(cfg.body).toMatchObject({ version: 1, deploy: { replicas: 1 } });
    const list = await owner.json<{ environments: { kind: string }[] }>(
      `/v1/projects/${p.id}/environments`,
    );
    expect(list.body.environments.map((e) => e.kind)).toEqual(["production", "staging"]);
    const dup = await owner.json(`/v1/projects/${p.id}/environments`, {
      method: "POST",
      json: { name: "Staging", slug: "staging", kind: "staging" },
    });
    expect(dup.status).toBe(409);
    const prod = await owner.json(`/v1/projects/${p.id}/environments`, {
      method: "POST",
      json: { name: "Prod 2", kind: "production" },
    });
    expect(prod.status).toBe(400);
  });

  it("copies configs and re-sealed variables from another environment", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const prodId = p.environments[0]!.id;
    const svc = await createService(owner, p.id);
    await owner.json(`/v1/services/${svc.service.id}`, {
      method: "PATCH",
      json: { environment_id: prodId, deploy: { replicas: 4 } },
    });
    await owner.json(`/v1/services/${svc.service.id}/variables?environment_id=${prodId}`, {
      method: "PUT",
      json: { set: [{ key: "TOKEN", value: "s3cr3t-value", is_secret: true }] },
    });
    await owner.json(`/v1/projects/${p.id}/variables?environment_id=${prodId}`, {
      method: "PUT",
      json: { set: [{ key: "REGION", value: "eu" }] },
    });
    const staging = await owner.json<{ id: string }>(`/v1/projects/${p.id}/environments`, {
      method: "POST",
      json: { name: "staging", kind: "staging", copy_from_environment_id: prodId },
    });
    expect(staging.status).toBe(201);
    const cfg = await owner.json<{ deploy: { replicas: number } }>(
      `/v1/services/${svc.service.id}/config?environment_id=${staging.body.id}`,
    );
    expect(cfg.body.deploy.replicas).toBe(4);
    const revealed = await owner.json<{ variables: { key: string; value: string }[] }>(
      `/v1/services/${svc.service.id}/variables/reveal?environment_id=${staging.body.id}`,
      { method: "POST", json: { keys: ["TOKEN"] } },
    );
    expect(revealed.body.variables).toEqual([{ key: "TOKEN", value: "s3cr3t-value" }]);
    const shared = await owner.json<{ variables: { key: string; value: string }[] }>(
      `/v1/projects/${p.id}/variables?environment_id=${staging.body.id}`,
    );
    expect(shared.body.variables.map((v) => v.value)).toEqual(["eu"]);

    const other = await createProject(owner, workspaceId, { name: "Other" });
    const foreign = await owner.json(`/v1/projects/${p.id}/environments`, {
      method: "POST",
      json: {
        name: "x",
        kind: "preview",
        copy_from_environment_id: other.environments[0]!.id,
      },
    });
    expect(foreign.status).toBe(404);
  });
});
