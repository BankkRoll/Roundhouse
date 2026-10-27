/**
 * Access control routes (ADR 0014 "Access control"): workspace access
 * settings, effective access, teams, project grants and environment
 * protection, including production being protected from the start and by
 * the upgrade migration, and lists leaving out projects the caller can't see.
 */
import { env } from "cloudflare:test";
import { DEFAULT_PROTECTION_RULES } from "@roundhouse/shared";
import { describe, expect, it } from "vitest";
import { addMember, type Client, install } from "./helpers";
import { createProject } from "./pipeline-helpers";

interface Member {
  id: string;
  user_id: string;
  email: string;
}

async function memberOf(owner: Client, workspaceId: string, email: string): Promise<Member> {
  const { body } = await owner.json<{ members: Member[] }>(`/v1/workspaces/${workspaceId}/members`);
  return body.members.find((m) => m.email === email)!;
}

async function productionOf(owner: Client, projectId: string) {
  const { body } = await owner.json<{
    environments: { id: string; kind: string; protected: boolean }[];
  }>(`/v1/projects/${projectId}/environments`);
  return body.environments.find((e) => e.kind === "production")!;
}

async function auditActions(): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT action FROM audit_logs ORDER BY seq").all<{
    action: string;
  }>();
  return results.map((r) => r.action);
}

describe("workspace access settings", () => {
  it("reads and changes the default project roles, for members:manage only", async () => {
    const { owner, workspaceId } = await install();
    const path = `/v1/workspaces/${workspaceId}/access-settings`;
    expect((await owner.json(path)).body).toEqual({
      member_default_project_role: "developer",
      viewer_default_project_role: "viewer",
    });
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    expect((await member.request(path)).status).toBe(200);
    expect(
      (
        await member.request(path, {
          method: "PATCH",
          json: { viewer_default_project_role: "none" },
        })
      ).status,
    ).toBe(403);
    const res = await owner.json(path, {
      method: "PATCH",
      json: { member_default_project_role: "viewer" },
    });
    expect(res.body).toEqual({
      member_default_project_role: "viewer",
      viewer_default_project_role: "viewer",
    });
    expect(await auditActions()).toContain("workspace.access_settings_updated");
    expect((await owner.request(path, { method: "PATCH", json: {} })).status).toBe(400);
  });

  it("hides projects from members implied none, until a grant gives one back", async () => {
    const { owner, workspaceId } = await install();
    const a = await createProject(owner, workspaceId, { name: "Alpha" });
    const b = await createProject(owner, workspaceId, { name: "Beta" });
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    await owner.request(`/v1/workspaces/${workspaceId}/access-settings`, {
      method: "PATCH",
      json: { member_default_project_role: "none" },
    });
    const list = await member.json<{ projects: { id: string }[] }>(
      `/v1/workspaces/${workspaceId}/projects`,
    );
    expect(list.status).toBe(200);
    expect(list.body.projects).toEqual([]);
    expect((await member.request(`/v1/projects/${a.id}`)).status).toBe(404);

    const { user_id } = await memberOf(owner, workspaceId, "m@example.com");
    const grant = await owner.json<{ id: string; principal_name: string; role: string }>(
      `/v1/projects/${a.id}/access`,
      { method: "PUT", json: { principal: { type: "user", id: user_id }, role: "viewer" } },
    );
    expect(grant.status).toBe(200);
    expect(grant.body).toMatchObject({ principal_name: "m", role: "viewer" });
    const after = await member.json<{ projects: { id: string }[] }>(
      `/v1/workspaces/${workspaceId}/projects`,
    );
    expect(after.body.projects.map((p) => p.id)).toEqual([a.id]);
    const summaries = await member.json<{ projects: { id: string }[] }>(
      `/v1/workspaces/${workspaceId}/projects/summary`,
    );
    expect(summaries.body.projects.map((p) => p.id)).toEqual([a.id]);
    expect((await member.request(`/v1/projects/${a.id}`)).status).toBe(200);
    expect((await member.request(`/v1/projects/${b.id}`)).status).toBe(404);
    // A viewer grant reads but doesn't change anything.
    expect(
      (await member.request(`/v1/projects/${a.id}`, { method: "PATCH", json: { name: "x" } }))
        .status,
    ).toBe(403);
  });
});

describe("teams", () => {
  it("creates, lists, renames, re-members and deletes teams of workspace members", async () => {
    const { owner, workspaceId, userId } = await install();
    await addMember(owner, workspaceId, "m@example.com", "member");
    const m = await memberOf(owner, workspaceId, "m@example.com");
    const base = `/v1/workspaces/${workspaceId}/teams`;

    const bad = await owner.json<{ error: { details: { field: string }[] } }>(base, {
      method: "POST",
      json: { name: "Core", user_ids: ["usr_nobody"] },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details).toEqual([expect.objectContaining({ field: "user_ids" })]);

    const created = await owner.json<{ id: string; slug: string; members: { user_id: string }[] }>(
      base,
      { method: "POST", json: { name: "Core Platform", user_ids: [m.user_id, userId] } },
    );
    expect(created.status).toBe(201);
    expect(created.body.slug).toBe("core-platform");
    expect(created.body.members.map((x) => x.user_id).sort()).toEqual([m.user_id, userId].sort());
    const dup = await owner.request(base, { method: "POST", json: { name: "Core Platform" } });
    expect(dup.status).toBe(409);

    const list = await owner.json<{ teams: { id: string; member_count: number }[] }>(base);
    expect(list.body.teams).toEqual([
      expect.objectContaining({ id: created.body.id, member_count: 2 }),
    ]);
    const renamed = await owner.json<{ name: string; slug: string }>(
      `/v1/teams/${created.body.id}`,
      { method: "PATCH", json: { name: "Core", slug: "core" } },
    );
    expect(renamed.body).toMatchObject({ name: "Core", slug: "core" });

    const put = await owner.json<{ members: { user_id: string }[] }>(
      `/v1/teams/${created.body.id}/members`,
      { method: "PUT", json: { user_ids: [m.user_id] } },
    );
    expect(put.body.members.map((x) => x.user_id)).toEqual([m.user_id]);

    expect((await owner.request(`/v1/teams/${created.body.id}`, { method: "DELETE" })).status).toBe(
      204,
    );
    expect((await owner.request(`/v1/teams/${created.body.id}`)).status).toBe(404);
    expect(await auditActions()).toEqual(
      expect.arrayContaining([
        "team.created",
        "team.updated",
        "team.member_removed",
        "team.deleted",
      ]),
    );
  });

  it("keeps teams to members:manage and to their own workspace", async () => {
    const { owner, workspaceId } = await install();
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    const viewer = await addMember(owner, workspaceId, "v@example.com", "viewer");
    const base = `/v1/workspaces/${workspaceId}/teams`;
    const team = await owner.json<{ id: string }>(base, { method: "POST", json: { name: "Ops" } });
    expect((await member.request(base)).status).toBe(200);
    expect((await viewer.request(base)).status).toBe(403);
    expect((await member.request(base, { method: "POST", json: { name: "Mine" } })).status).toBe(
      403,
    );
    expect((await member.request(`/v1/teams/${team.body.id}`, { method: "DELETE" })).status).toBe(
      403,
    );

    const other = await owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Other" },
    });
    const outsider = await addMember(owner, other.body.id, "o@example.com", "admin");
    expect((await outsider.request(`/v1/teams/${team.body.id}`)).status).toBe(404);
  });

  it("drops a deleted team from protection rules, and a removed member from teams and grants", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const prod = await productionOf(owner, p.id);
    await addMember(owner, workspaceId, "m@example.com", "member");
    const m = await memberOf(owner, workspaceId, "m@example.com");
    const team = await owner.json<{ id: string }>(`/v1/workspaces/${workspaceId}/teams`, {
      method: "POST",
      json: { name: "Ops", user_ids: [m.user_id] },
    });
    await owner.request(`/v1/projects/${p.id}/access`, {
      method: "PUT",
      json: { principal: { type: "user", id: m.user_id }, role: "project_admin" },
    });
    await owner.request(`/v1/environments/${prod.id}/protection`, {
      method: "PUT",
      json: {
        protected: true,
        rules: { variables: { roles: [], user_ids: [], team_ids: [team.body.id] } },
      },
    });
    await owner.request(`/v1/teams/${team.body.id}`, { method: "DELETE" });
    const protection = await owner.json<{ rules: { variables: { team_ids: string[] } } }>(
      `/v1/environments/${prod.id}/protection`,
    );
    expect(protection.body.rules.variables.team_ids).toEqual([]);

    const team2 = await owner.json<{ id: string }>(`/v1/workspaces/${workspaceId}/teams`, {
      method: "POST",
      json: { name: "Ops 2", user_ids: [m.user_id] },
    });
    await owner.request(`/v1/workspaces/${workspaceId}/members/${m.id}`, { method: "DELETE" });
    const left = await env.DB.prepare(
      "SELECT (SELECT count(*) FROM team_members WHERE user_id = ?1) AS teams, (SELECT count(*) FROM project_access_grants WHERE user_id = ?1) AS grants",
    )
      .bind(m.user_id)
      .first<{ teams: number; grants: number }>();
    expect(left).toEqual({ teams: 0, grants: 0 });
    const detail = await owner.json<{ members: unknown[] }>(`/v1/teams/${team2.body.id}`);
    expect(detail.body.members).toEqual([]);
  });
});

describe("project grants", () => {
  it("grants, changes and revokes access for users and teams, for access:manage only", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    const m = await memberOf(owner, workspaceId, "m@example.com");
    const path = `/v1/projects/${p.id}/access`;
    // Members are developers by default: no access:manage.
    expect((await member.request(path)).status).toBe(403);

    const team = await owner.json<{ id: string }>(`/v1/workspaces/${workspaceId}/teams`, {
      method: "POST",
      json: { name: "Ops", user_ids: [m.user_id] },
    });
    const viaTeam = await owner.json<{ id: string; principal: unknown; principal_name: string }>(
      path,
      {
        method: "PUT",
        json: { principal: { type: "team", id: team.body.id }, role: "project_admin" },
      },
    );
    expect(viaTeam.body).toMatchObject({
      principal: { type: "team", id: team.body.id },
      principal_name: "Ops",
    });
    expect((await member.request(path)).status).toBe(200);

    const changed = await owner.json<{ id: string; role: string }>(path, {
      method: "PUT",
      json: { principal: { type: "team", id: team.body.id }, role: "viewer" },
    });
    expect(changed.body).toMatchObject({ id: viaTeam.body.id, role: "viewer" });
    // The team grant is lower than the implied developer role now.
    expect((await member.request(path)).status).toBe(403);

    const listed = await owner.json<{ grants: { id: string }[]; implied: unknown }>(path);
    expect(listed.body).toEqual({
      grants: [expect.objectContaining({ id: viaTeam.body.id })],
      implied: { member: "developer", viewer: "viewer" },
    });
    expect((await owner.request(`${path}/${viaTeam.body.id}`, { method: "DELETE" })).status).toBe(
      204,
    );
    expect((await owner.request(`${path}/${viaTeam.body.id}`, { method: "DELETE" })).status).toBe(
      404,
    );
    expect(await auditActions()).toEqual(
      expect.arrayContaining(["access.granted", "access.changed", "access.revoked"]),
    );
  });

  it("refuses principals from outside the project's workspace", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const other = await owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Other" },
    });
    await addMember(owner, other.body.id, "o@example.com", "member");
    const outsider = await memberOf(owner, other.body.id, "o@example.com");
    const foreignTeam = await owner.json<{ id: string }>(`/v1/workspaces/${other.body.id}/teams`, {
      method: "POST",
      json: { name: "Elsewhere" },
    });
    for (const principal of [
      { type: "user", id: outsider.user_id },
      { type: "team", id: foreignTeam.body.id },
    ]) {
      const res = await owner.request(`/v1/projects/${p.id}/access`, {
        method: "PUT",
        json: { principal, role: "developer" },
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("environment protection", () => {
  it("starts production protected with the default rules", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const prod = await productionOf(owner, p.id);
    expect(prod.protected).toBe(true);
    const protection = await owner.json(`/v1/environments/${prod.id}/protection`);
    expect(protection.body).toEqual({
      environment_id: prod.id,
      protected: true,
      rules: {
        deploy: { roles: ["developer", "deployer"], user_ids: [], team_ids: [] },
        config: { roles: ["developer"], user_ids: [], team_ids: [] },
        variables: { roles: [], user_ids: [], team_ids: [] },
      },
      require_approval: false,
    });
  });

  it("keeps variable changes in production to project admins until a rule lets someone in", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const prod = await productionOf(owner, p.id);
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    const m = await memberOf(owner, workspaceId, "m@example.com");
    const write = (c: Client) =>
      c.request(`/v1/projects/${p.id}/variables?environment_id=${prod.id}`, {
        method: "PUT",
        json: { set: [{ key: "LOG_LEVEL", value: "debug", tier: "plain" }] },
      });
    const refused = await write(member);
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(
      /protected/,
    );
    expect((await write(owner)).status).toBe(200);

    expect(
      (
        await member.request(`/v1/environments/${prod.id}/protection`, {
          method: "PUT",
          json: { protected: false },
        })
      ).status,
    ).toBe(403);
    const bad = await owner.request(`/v1/environments/${prod.id}/protection`, {
      method: "PUT",
      json: {
        protected: true,
        rules: { variables: { roles: [], user_ids: ["usr_nobody"], team_ids: [] } },
      },
    });
    expect(bad.status).toBe(400);
    const opened = await owner.json<{ rules: { variables: unknown; deploy: unknown } }>(
      `/v1/environments/${prod.id}/protection`,
      {
        method: "PUT",
        json: {
          protected: true,
          rules: { variables: { roles: [], user_ids: [m.user_id], team_ids: [] } },
        },
      },
    );
    expect(opened.body.rules.variables).toEqual({ roles: [], user_ids: [m.user_id], team_ids: [] });
    // Operations not named keep their rule.
    expect(opened.body.rules.deploy).toEqual({
      roles: DEFAULT_PROTECTION_RULES.deploy.roles,
      user_ids: [],
      team_ids: [],
    });
    expect((await write(member)).status).toBe(200);
    expect(await auditActions()).toContain("environment.protection_updated");
  });

  it("is protected on upgrade for production and prod environments nobody configured", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const prod = await productionOf(owner, p.id);
    const now = Date.now();
    const insert = (
      id: string,
      name: string,
      slug: string,
      protectedFlag: number,
      rules: string | null,
    ) =>
      env.DB.prepare(
        "INSERT INTO environments (id, project_id, name, slug, kind, protected, protection_rules, created_at, updated_at) VALUES (?, ?, ?, ?, 'staging', ?, ?, ?, ?)",
      )
        .bind(id, p.id, name, slug, protectedFlag, rules, now, now)
        .run();
    await env.DB.prepare("UPDATE environments SET protected = 0 WHERE id = ?").bind(prod.id).run();
    await insert("env_prod", "Prod", "prod", 0, null);
    await insert("env_staging", "staging", "staging", 0, null);
    const configured = JSON.stringify({
      ...DEFAULT_PROTECTION_RULES,
      deploy: { roles: [], userIds: [], teamIds: [] },
    });
    await insert("env_configured", "production", "production-2", 0, configured);

    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0013_"))!;
    await env.DB.prepare(migration.queries[0]!).run();

    const { results } = await env.DB.prepare(
      "SELECT id, protected, protection_rules FROM environments WHERE project_id = ? ORDER BY id",
    )
      .bind(p.id)
      .all<{ id: string; protected: number; protection_rules: string | null }>();
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId[prod.id]).toMatchObject({ protected: 1, protection_rules: null });
    expect(byId.env_prod).toMatchObject({ protected: 1, protection_rules: null });
    expect(byId.env_staging).toMatchObject({ protected: 0 });
    expect(byId.env_configured).toMatchObject({ protected: 0, protection_rules: configured });
  });
});

describe("project directory", () => {
  interface DirectoryBody {
    users: { id: string; name: string; email: string | null; project_member: boolean }[];
    teams: { id: string; name: string }[];
  }

  it("names project members and rule principals to project readers, emails only with members:read", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const prod = await productionOf(owner, p.id);
    await owner.request(`/v1/workspaces/${workspaceId}/access-settings`, {
      method: "PATCH",
      json: { viewer_default_project_role: "none" },
    });
    const vee = await addMember(owner, workspaceId, "vee@example.com", "viewer");
    const outsider = await addMember(owner, workspaceId, "out@example.com", "viewer");
    await addMember(owner, workspaceId, "mia@example.com", "member");
    await addMember(owner, workspaceId, "tee@example.com", "viewer");
    await addMember(owner, workspaceId, "nobody@example.com", "viewer");
    const v = await memberOf(owner, workspaceId, "vee@example.com");
    const o = await memberOf(owner, workspaceId, "out@example.com");
    const m = await memberOf(owner, workspaceId, "mia@example.com");
    const t = await memberOf(owner, workspaceId, "tee@example.com");
    const team = await owner.json<{ id: string }>(`/v1/workspaces/${workspaceId}/teams`, {
      method: "POST",
      json: { name: "Ops", user_ids: [t.user_id] },
    });
    await owner.json(`/v1/workspaces/${workspaceId}/teams`, {
      method: "POST",
      json: { name: "Unrelated" },
    });
    const grant = (principal: { type: string; id: string }, role: string) =>
      owner.request(`/v1/projects/${p.id}/access`, { method: "PUT", json: { principal, role } });
    expect((await grant({ type: "user", id: v.user_id }, "project_admin")).status).toBe(200);
    expect((await grant({ type: "team", id: team.body.id }, "viewer")).status).toBe(200);
    const rule = { roles: [], user_ids: [m.user_id, o.user_id], team_ids: [team.body.id] };
    expect(
      (
        await owner.request(`/v1/environments/${prod.id}/protection`, {
          method: "PUT",
          json: { protected: true, rules: { deploy: rule } },
        })
      ).status,
    ).toBe(200);

    // A workspace viewer made project admin can't list the workspace's members...
    expect((await vee.request(`/v1/workspaces/${workspaceId}/members`)).status).toBe(403);
    // ...but can put names to the IDs in the rules.
    const path = `/v1/projects/${p.id}/directory`;
    const seen = await vee.json<DirectoryBody>(path);
    expect(seen.status).toBe(200);
    const user = (id: string) => seen.body.users.find((u) => u.id === id);
    expect(user(v.user_id)).toMatchObject({ name: "vee", project_member: true });
    expect(user(m.user_id)).toMatchObject({ name: "mia", project_member: true });
    expect(user(t.user_id)).toMatchObject({ name: "tee", project_member: true });
    expect(user(o.user_id)).toMatchObject({ name: "out", project_member: false });
    expect(seen.body.users.map((u) => u.name)).not.toContain("nobody");
    expect(seen.body.users).toHaveLength(5);
    expect(seen.body.users.every((u) => u.email === null)).toBe(true);
    expect(JSON.stringify(seen.body)).not.toContain("@example.com");
    expect(seen.body.teams).toEqual([{ id: team.body.id, name: "Ops" }]);

    const asOwner = await owner.json<DirectoryBody>(path);
    expect(asOwner.body.users.find((u) => u.id === v.user_id)?.email).toBe("vee@example.com");

    // No role on the project: it doesn't exist for them.
    expect((await outsider.request(path)).status).toBe(404);
  });
});

describe("effective access", () => {
  it("reports actions per workspace and project, and what protection denies", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const prod = await productionOf(owner, p.id);
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    const res = await member.json<{
      workspace_role: string;
      instance_admin: boolean;
      actions: string[];
      projects: {
        project_id: string;
        role: string;
        actions: string[];
        environments: { environment_id: string; protected: boolean; denied: unknown[] }[];
      }[];
    }>(`/v1/workspaces/${workspaceId}/access/me`);
    expect(res.body.workspace_role).toBe("member");
    expect(res.body.instance_admin).toBe(false);
    expect(res.body.actions).toEqual(["workspace:read", "members:read", "nodes:read"]);
    expect(res.body.projects).toEqual([
      {
        project_id: p.id,
        role: "developer",
        actions: expect.arrayContaining(["services:manage", "variables:manage"]),
        environments: [
          {
            environment_id: prod.id,
            protected: true,
            denied: [{ action: "variables:manage", reason: "environment_protected" }],
          },
        ],
      },
    ]);
    const mine = await owner.json<{ instance_admin: boolean; actions: string[] }>(
      `/v1/workspaces/${workspaceId}/access/me`,
    );
    expect(mine.body.instance_admin).toBe(true);
    expect(mine.body.actions).toEqual(
      expect.arrayContaining(["instance:manage", "workspace:delete"]),
    );
  });
});
