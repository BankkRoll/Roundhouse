/**
 * Instance settings: owner-only access, hostname validation, desired state
 * pushed to every node when ingress changes, log retention, and the audit
 * record written to every workspace the caller owns.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addMember, call, eventually, install, joinNode } from "./helpers";
import { connectWorkloadAgent } from "./pipeline-helpers";

describe("instance settings", () => {
  it("defaults to no apps domain and ACME", async () => {
    const { owner } = await install();
    const res = await owner.json("/v1/instance/settings");
    expect(res).toEqual({
      status: 200,
      body: { apps_domain: null, tls_mode: "acme", log_retention_days: 7 },
    });
  });

  it("is owner-only", async () => {
    const { owner, workspaceId } = await install();
    expect((await call("/v1/instance/settings")).status).toBe(401);
    for (const role of ["admin", "member", "viewer"] as const) {
      const c = await addMember(owner, workspaceId, `${role}@example.com`, role);
      expect((await c.json("/v1/instance/settings")).status).toBe(403);
      const patch = await c.json("/v1/instance/settings", {
        method: "PATCH",
        json: { tls_mode: "off" },
      });
      expect(patch.status).toBe(403);
    }
  });

  it.each([
    [{}, 400],
    [{ apps_domain: "Apps.Example.com" }, 400],
    [{ apps_domain: "localhost" }, 400],
    [{ apps_domain: "-bad.example.com" }, 400],
    [{ tls_mode: "letsencrypt" }, 400],
    [{ apps_domain: "127.0.0.1.nip.io" }, 200],
    [{ apps_domain: null, tls_mode: "internal" }, 200],
    [{ log_retention_days: 0 }, 400],
    [{ log_retention_days: 366 }, 400],
    [{ log_retention_days: 1.5 }, 400],
    [{ log_retention_days: 30 }, 200],
  ])("validates %j", async (body, status) => {
    const { owner } = await install();
    const res = await owner.json("/v1/instance/settings", { method: "PATCH", json: body });
    expect(res.status).toBe(status);
  });

  it("pushes new desired state to every connected node and audits the change", async () => {
    const { owner, workspaceId } = await install();
    const a = await connectWorkloadAgent(await joinNode(owner, workspaceId));
    const b = await connectWorkloadAgent(await joinNode(owner, workspaceId, { name: "b" }));
    const genA = a.desired()!.generation;
    const res = await owner.json("/v1/instance/settings", {
      method: "PATCH",
      json: { apps_domain: "apps.example.com", tls_mode: "internal" },
    });
    expect(res.body).toEqual({
      apps_domain: "apps.example.com",
      tls_mode: "internal",
      log_retention_days: 7,
    });
    for (const agent of [a, b]) {
      await eventually(async () => {
        const d = agent.desired()!;
        return d.apps_domain === "apps.example.com" && d.tls_mode === "internal" ? true : undefined;
      });
    }
    expect(a.desired()!.generation).toBeGreaterThan(genA);
    const audit = await env.DB.prepare(
      "SELECT workspace_id, metadata FROM audit_logs WHERE action = 'instance.settings_updated'",
    ).first<{ workspace_id: string | null; metadata: string }>();
    expect(audit?.workspace_id).toBe(workspaceId);
    expect(JSON.parse(audit!.metadata)).toEqual({
      changed: ["apps_domain", "tls_mode"],
      before: { apps_domain: null, tls_mode: "acme" },
      after: { apps_domain: "apps.example.com", tls_mode: "internal" },
    });
    const cleared = await owner.json("/v1/instance/settings", {
      method: "PATCH",
      json: { apps_domain: null },
    });
    expect(cleared.body).toEqual({
      apps_domain: null,
      tls_mode: "internal",
      log_retention_days: 7,
    });
  });
});

describe("instance settings audit", () => {
  it("records a change in every workspace the caller owns, visible in each audit log", async () => {
    const { owner, workspaceId } = await install();
    const second = await owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Second" },
    });
    const third = await owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Third" },
    });
    // Admin elsewhere: owners only, so this workspace gets no record.
    const other = await addMember(owner, third.body.id, "o@example.com", "admin");
    const otherOwned = await other.json("/v1/workspaces", {
      method: "POST",
      json: { name: "Other's" },
    });
    expect(otherOwned.status).toBe(201);

    const res = await owner.json("/v1/instance/settings", {
      method: "PATCH",
      json: { log_retention_days: 30 },
    });
    expect(res.status).toBe(200);
    const rows = await env.DB.prepare(
      "SELECT workspace_id FROM audit_logs WHERE action = 'instance.settings_updated' ORDER BY workspace_id",
    ).all<{ workspace_id: string }>();
    expect(rows.results.map((r) => r.workspace_id)).toEqual(
      [workspaceId, second.body.id, third.body.id].sort(),
    );
    for (const id of [workspaceId, second.body.id]) {
      const log = await owner.json<{ items: { action: string; metadata: unknown }[] }>(
        `/v1/workspaces/${id}/audit-logs`,
      );
      expect(log.body.items[0]).toMatchObject({
        action: "instance.settings_updated",
        metadata: { changed: ["log_retention_days"], after: { log_retention_days: 30 } },
      });
    }
  });

  it("records nothing and pushes nothing when nothing changed", async () => {
    const { owner, workspaceId } = await install();
    const agent = await connectWorkloadAgent(await joinNode(owner, workspaceId));
    const generation = agent.desired()!.generation;
    const res = await owner.json("/v1/instance/settings", {
      method: "PATCH",
      json: { tls_mode: "acme", log_retention_days: 7 },
    });
    expect(res.status).toBe(200);
    const n = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_logs WHERE action = 'instance.settings_updated'",
    ).first<{ n: number }>();
    expect(n?.n).toBe(0);
    expect(agent.desired()!.generation).toBe(generation);
  });

  it("refuses API tokens even when their creator is an owner", async () => {
    const { owner, workspaceId } = await install();
    const created = await owner.json<{ secret: string }>(`/v1/workspaces/${workspaceId}/tokens`, {
      method: "POST",
      json: { name: "ci", scopes: ["workspace:read"], expires_in_days: null },
    });
    const res = await call("/v1/instance/settings", {
      headers: { authorization: `Bearer ${created.body.secret}` },
    });
    expect(res.status).toBe(403);
  });
});
