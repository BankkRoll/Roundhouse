/**
 * Instance settings: owner-only access, hostname validation, and desired
 * state pushed to every node when they change.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { addMember, call, eventually, install, joinNode } from "./helpers";
import { connectWorkloadAgent } from "./pipeline-helpers";

describe("instance settings", () => {
  it("defaults to no apps domain and ACME", async () => {
    const { owner } = await install();
    const res = await owner.json("/v1/instance/settings");
    expect(res).toEqual({ status: 200, body: { apps_domain: null, tls_mode: "acme" } });
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
    expect(res.body).toEqual({ apps_domain: "apps.example.com", tls_mode: "internal" });
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
    expect(JSON.parse(audit!.metadata).after).toEqual({
      apps_domain: "apps.example.com",
      tls_mode: "internal",
    });
    const cleared = await owner.json("/v1/instance/settings", {
      method: "PATCH",
      json: { apps_domain: null },
    });
    expect(cleared.body).toEqual({ apps_domain: null, tls_mode: "internal" });
  });
});
