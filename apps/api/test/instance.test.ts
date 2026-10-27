/**
 * Instance settings: owner-only access, hostname validation, desired state
 * pushed to every node when ingress changes, log retention, and the audit
 * record written to every workspace the caller owns.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { policyOf, updateInstanceSettings } from "../src/contracts";
import { addMember, call, eventually, install, joinNode } from "./helpers";
import { connectWorkloadAgent } from "./pipeline-helpers";

describe("instance settings", () => {
  it("defaults to no apps domain and ACME", async () => {
    const { owner } = await install();
    const res = await owner.json("/v1/instance/settings");
    expect(res).toEqual({
      status: 200,
      body: {
        apps_domain: null,
        tls_mode: "acme",
        log_retention_days: 7,
        mcp_enabled: false,
        ingress_nodes: 0,
      },
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
      mcp_enabled: false,
      ingress_nodes: 2,
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
    expect(audit?.workspace_id).toBeNull();
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
      mcp_enabled: false,
      ingress_nodes: 2,
    });
  });
});

describe("mcp_enabled", () => {
  it("is off by default, toggled by instance admins only, audited, and needs a fresh session", async () => {
    const { owner, workspaceId } = await install();
    const admin = await addMember(owner, workspaceId, "ws-admin@example.com", "admin");
    expect(
      (await admin.json("/v1/instance/settings", { method: "PATCH", json: { mcp_enabled: true } }))
        .status,
    ).toBe(403);

    const on = await owner.json<{ mcp_enabled: boolean }>("/v1/instance/settings", {
      method: "PATCH",
      json: { mcp_enabled: true },
    });
    expect(on).toMatchObject({ status: 200, body: { mcp_enabled: true } });
    const audit = await env.DB.prepare(
      "SELECT workspace_id, metadata FROM audit_logs WHERE action = 'instance.settings_updated'",
    ).first<{ workspace_id: string | null; metadata: string }>();
    expect(audit!.workspace_id).toBeNull();
    expect(JSON.parse(audit!.metadata)).toEqual({
      changed: ["mcp_enabled"],
      before: { mcp_enabled: false },
      after: { mcp_enabled: true },
    });

    // Toggling goes through the instance-settings policy: instance admins,
    // browser sessions only, fresh session required.
    expect(policyOf(updateInstanceSettings)).toEqual({
      auth: "session_only",
      action: "instance:manage",
      audit: ["instance.settings_updated"],
      reauth: true,
    });
  });

  it("rejects a non-boolean value", async () => {
    const { owner } = await install();
    const res = await owner.json("/v1/instance/settings", {
      method: "PATCH",
      json: { mcp_enabled: "yes" },
    });
    expect(res.status).toBe(400);
  });
});

describe("instance settings audit", () => {
  it("records one instance-level entry, in no workspace's audit log", async () => {
    const { owner, workspaceId } = await install();
    const res = await owner.json("/v1/instance/settings", {
      method: "PATCH",
      json: { log_retention_days: 30 },
    });
    expect(res.status).toBe(200);
    const rows = await env.DB.prepare(
      "SELECT workspace_id, metadata FROM audit_logs WHERE action = 'instance.settings_updated'",
    ).all<{ workspace_id: string | null; metadata: string }>();
    expect(rows.results.map((r) => r.workspace_id)).toEqual([null]);
    expect(JSON.parse(rows.results[0]!.metadata)).toMatchObject({
      changed: ["log_retention_days"],
      after: { log_retention_days: 30 },
    });
    const log = await owner.json<{ items: { action: string }[] }>(
      `/v1/workspaces/${workspaceId}/audit-logs`,
    );
    expect(log.body.items.map((i) => i.action)).not.toContain("instance.settings_updated");
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
