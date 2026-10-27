/**
 * The TCP proxy (ADR 0004, "TCP proxy"): allowlist validation (IPv4, IPv6,
 * the explicit `/0` acknowledgement), the public port, what the node's
 * desired state publishes (only to agents that enforce the allowlist, dual
 * stack for IPv6 sources), the `ROUNDHOUSE_TCP_PROXY_*` built-ins and
 * `DATABASE_PUBLIC_URL`, the replica rule, RBAC, reauth and audit.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { createDb, environments } from "@roundhouse/db";
import type { DesiredState, WorkloadSpec } from "@roundhouse/protocol";
import { TCP_PROXY_PORT_RANGE } from "@roundhouse/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/errors";
import { resolveServiceEnvironment } from "../src/lib/resolve-env";
import { setS3Transport } from "../src/lib/s3";
import { normalizeAllowlist, publishHostIp } from "../src/lib/tcp-proxies";
import { projectKey } from "../src/lib/variables";
import { allAuditText, auditRows } from "./backups-helpers";
import { type DatabaseStage, databaseStage, FULL_CAPABILITIES } from "./data-stage";
import { addMember, eventually } from "./helpers";
import { createService, settleDeployments } from "./pipeline-helpers";

let introspector: { dispose(): Promise<void> } | undefined;
beforeEach(async () => {
  introspector = await introspectWorkflow(env.DEPLOY_WORKFLOW);
});
afterEach(async () => {
  await settleDeployments();
  await introspector?.dispose();
  setS3Transport();
});

interface ProxyBody {
  id: string;
  public_port: number;
  container_port: number;
  allowed_cidrs: string[];
  host: string | null;
  node_id: string | null;
  status: string;
  open_to_all: boolean;
  error: { code: string; message: string };
}

const put = (s: DatabaseStage, body: Record<string, unknown>) =>
  s.owner.json<ProxyBody>(`/v1/services/${s.serviceId}/tcp-proxies`, {
    method: "PUT",
    json: { environment_id: s.envId, ...body },
  });

/** The service's workload in the latest desired state that has it published (or not). */
function workloadOf(s: DatabaseStage, published: boolean): Promise<WorkloadSpec> {
  return eventually(async () => {
    const desired = [...s.home.agent.received]
      .reverse()
      .find((m): m is DesiredState => m.type === "desired_state");
    const w = desired?.workloads.find((x) => x.service_id === s.serviceId);
    if (!w) return undefined;
    return w.ports.some((p) => p.publish) === published ? w : undefined;
  }, 8000);
}

describe("allowlists", () => {
  it("normalises IPv4 and IPv6 sources and refuses what admits nobody", () => {
    expect(
      normalizeAllowlist(
        ["203.0.113.7", "10.1.2.3/8", " 2001:DB8:0:0::1/32 ", "2001:db8::7", "10.0.0.0/8"],
        false,
      ),
    ).toEqual(["203.0.113.7/32", "10.0.0.0/8", "2001:db8::/32", "2001:db8::7/128"]);
    expect(normalizeAllowlist(["::/0", "0.0.0.0/0"], true)).toEqual(["::/0", "0.0.0.0/0"]);
    expect(() => normalizeAllowlist(["0.0.0.0/0"], false)).toThrow(ApiError);
    expect(() => normalizeAllowlist(["::/0"], false)).toThrow(/acknowledge_open/);
    expect(() => normalizeAllowlist(["::ffff:10.0.0.0/104"], false)).toThrow(/IPv4-mapped/);
    expect(() => normalizeAllowlist(["10.0.0.0/33", "example.com"], false)).toThrow(
      /Not an IP address/,
    );
    expect(publishHostIp(["203.0.113.7/32"])).toBe("0.0.0.0");
    expect(publishHostIp(["203.0.113.7/32", "2001:db8::/32"])).toBe("::");
  });
});

describe("publishing a database's port", () => {
  it("allocates a port, publishes it behind the allowlist, and adds DATABASE_PUBLIC_URL", async () => {
    const s = await databaseStage();
    const res = await put(s, { allowed_cidrs: ["198.51.100.4", "2001:db8::/48"] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      container_port: 5432,
      allowed_cidrs: ["198.51.100.4/32", "2001:db8::/48"],
      status: "active",
      host: "203.0.113.10",
      node_id: s.home.joined.node_id,
      open_to_all: false,
    });
    expect(res.body.public_port).toBeGreaterThanOrEqual(TCP_PROXY_PORT_RANGE.min);
    expect(res.body.public_port).toBeLessThanOrEqual(TCP_PROXY_PORT_RANGE.max);

    const w = await workloadOf(s, true);
    expect(w.ports.find((p) => p.publish)).toEqual({
      container_port: 5432,
      protocol: "http",
      publish: { host_port: res.body.public_port, host_ip: "::" },
    });
    expect(w.publish_allowed_cidrs).toEqual(["198.51.100.4/32", "2001:db8::/48"]);

    const db = createDb(env.DB);
    const [environment] = await db.select().from(environments).where(eq(environments.id, s.envId));
    const resolved = await resolveServiceEnvironment(db, await projectKey(db, env, s.project.id), {
      projectId: s.project.id,
      serviceId: s.serviceId,
      environment: environment!,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.env.ROUNDHOUSE_TCP_PROXY_DOMAIN).toBe("203.0.113.10");
      expect(resolved.env.ROUNDHOUSE_TCP_PROXY_PORT).toBe(String(res.body.public_port));
      expect(resolved.env.DATABASE_PUBLIC_URL).toBe(
        `postgresql://postgres:${resolved.env.POSTGRES_PASSWORD}@203.0.113.10:${res.body.public_port}/app`,
      );
    }
    const tier = await env.DB.prepare(
      "SELECT tier FROM variables WHERE service_id = ? AND key = 'DATABASE_PUBLIC_URL'",
    )
      .bind(s.serviceId)
      .first<{ tier: string }>();
    expect(tier?.tier).toBe("secret");

    const [audit] = await auditRows("tcp_proxy.enabled");
    expect(audit!.metadata).toMatchObject({
      public_port: res.body.public_port,
      allowed_cidrs: ["198.51.100.4/32", "2001:db8::/48"],
      variables_set: ["DATABASE_PUBLIC_URL"],
    });
    if (resolved.ok) expect(await allAuditText()).not.toContain(resolved.env.POSTGRES_PASSWORD);

    // An allowlist edit keeps the port and applies in place.
    const edited = await put(s, { allowed_cidrs: ["198.51.100.0/24"] });
    expect(edited.body.public_port).toBe(res.body.public_port);
    const after = await eventually(async () => {
      const x = await workloadOf(s, true);
      return x.publish_allowed_cidrs?.[0] === "198.51.100.0/24" ? x : undefined;
    });
    expect(after.ports.find((p) => p.publish)?.publish?.host_ip).toBe("0.0.0.0");
    expect(await auditRows("tcp_proxy.updated")).toHaveLength(1);

    const get = await s.owner.json<ProxyBody>(
      `/v1/services/${s.serviceId}/tcp-proxies?environment_id=${s.envId}`,
    );
    expect(get.body.allowed_cidrs).toEqual(["198.51.100.0/24"]);

    // Off: the port and the variable go.
    const off = await s.owner.json(
      `/v1/services/${s.serviceId}/tcp-proxies?environment_id=${s.envId}`,
      { method: "DELETE" },
    );
    expect(off.status).toBe(204);
    await workloadOf(s, false);
    const gone = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM variables WHERE service_id = ? AND key = 'DATABASE_PUBLIC_URL'",
    )
      .bind(s.serviceId)
      .first<{ n: number }>();
    expect(gone?.n).toBe(0);
    const [disabled] = await auditRows("tcp_proxy.disabled");
    expect(disabled!.metadata).toMatchObject({ variables_deleted: ["DATABASE_PUBLIC_URL"] });
    const missing = await s.owner.json(
      `/v1/services/${s.serviceId}/tcp-proxies?environment_id=${s.envId}`,
    );
    expect(missing.status).toBe(404);
  }, 90_000);

  it("admits every address only when told to, and says so", async () => {
    const s = await databaseStage();
    const refused = await put(s, { allowed_cidrs: ["0.0.0.0/0"] });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("confirmation_required");
    const invalid = await put(s, { allowed_cidrs: ["203.0.113.0/40"] });
    expect(invalid.status).toBe(422);
    const open = await put(s, { allowed_cidrs: ["0.0.0.0/0"], acknowledge_open: true });
    expect(open.status).toBe(200);
    expect(open.body.open_to_all).toBe(true);
    const [audit] = await auditRows("tcp_proxy.enabled");
    expect(audit!.metadata).toMatchObject({ open_to_all: true });
  }, 60_000);

  it("never publishes on a node whose agent can't enforce the allowlist", async () => {
    const s = await databaseStage({
      hello: () => ({ capabilities: { ...FULL_CAPABILITIES, tcp_proxy: false } }),
    });
    const res = await put(s, { allowed_cidrs: ["198.51.100.4"] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("tcp_proxy_unsupported");
    // Even with a proxy row in place, the desired state publishes nothing there.
    await env.DB.prepare(
      `INSERT INTO tcp_proxies (id, project_id, service_id, environment_id, container_port, public_port, allowed_cidrs, created_at, updated_at)
       VALUES ('tcp_test', ?, ?, ?, 5432, 20001, '["198.51.100.4/32"]', ?, ?)`,
    )
      .bind(s.project.id, s.serviceId, s.envId, Date.now(), Date.now())
      .run();
    const get = await s.owner.json<ProxyBody>(
      `/v1/services/${s.serviceId}/tcp-proxies?environment_id=${s.envId}`,
    );
    expect(get.body.status).toBe("unsupported");
    const resize = await s.owner.json(`/v1/volumes/${s.volumeId}`, {
      method: "PATCH",
      json: { size_mb: 6144 },
    });
    expect(resize.status).toBe(200);
    const w = await workloadOf(s, false);
    expect(w.publish_allowed_cidrs).toBeUndefined();
  }, 60_000);

  it("keeps a published service at one replica", async () => {
    const s = await databaseStage();
    const app = await createService(s.owner, s.project.id);
    const scaled = await s.owner.json(`/v1/services/${app.service.id}`, {
      method: "PATCH",
      json: { environment_id: s.envId, deploy: { replicas: 2 } },
    });
    expect(scaled.status).toBe(200);
    const published = await s.owner.json<ProxyBody>(`/v1/services/${app.service.id}/tcp-proxies`, {
      method: "PUT",
      json: { environment_id: s.envId, container_port: 8080, allowed_cidrs: ["198.51.100.4"] },
    });
    expect(published.status).toBe(422);
    await s.owner.json(`/v1/services/${app.service.id}`, {
      method: "PATCH",
      json: { environment_id: s.envId, deploy: { replicas: 1 } },
    });
    const ok = await s.owner.json<ProxyBody>(`/v1/services/${app.service.id}/tcp-proxies`, {
      method: "PUT",
      json: { environment_id: s.envId, container_port: 8080, allowed_cidrs: ["198.51.100.4"] },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("pending");
    const scale = await s.owner.json<{ error: { code: string } }>(
      `/v1/services/${app.service.id}`,
      {
        method: "PATCH",
        json: { environment_id: s.envId, deploy: { replicas: 2 } },
      },
    );
    expect(scale.status).toBe(422);
    expect(scale.body.error.code).toBe("volume_requires_single_replica");
    // Not a database: no DATABASE_PUBLIC_URL.
    const vars = await env.DB.prepare("SELECT COUNT(*) AS n FROM variables WHERE service_id = ?")
      .bind(app.service.id)
      .first<{ n: number }>();
    expect(vars?.n).toBe(0);
  }, 60_000);

  it("needs services:manage and a fresh session to publish, not to unpublish", async () => {
    const s = await databaseStage();
    const viewer = await addMember(s.owner, s.workspaceId, "view@example.com", "viewer");
    const denied = await viewer.json(`/v1/services/${s.serviceId}/tcp-proxies`, {
      method: "PUT",
      json: { environment_id: s.envId, allowed_cidrs: ["198.51.100.4"] },
    });
    expect(denied.status).toBe(403);
    expect((await put(s, { allowed_cidrs: ["198.51.100.4"] })).status).toBe(200);
    await env.DB.prepare("UPDATE sessions SET created_at = ?, reauthenticated_at = NULL")
      .bind(Date.now() - 24 * 60 * 60 * 1000)
      .run();
    const stale = await put(s, { allowed_cidrs: ["198.51.100.5"] });
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe("reauth_required");
    const off = await s.owner.json(
      `/v1/services/${s.serviceId}/tcp-proxies?environment_id=${s.envId}`,
      { method: "DELETE" },
    );
    expect(off.status).toBe(204);
  }, 60_000);
});
