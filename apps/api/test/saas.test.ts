/**
 * Cloudflare for SaaS custom domains (ADR 0009): the check state table, the
 * gates on the setting, setup (origin records, fallback origin), the custom
 * hostname lifecycle of a domain, and the origin firewall's ranges in
 * desired state. Cloudflare is the in-process fake (`./fake-cloudflare`).
 */
import { env } from "cloudflare:test";
import { createDb, domains, nodes } from "@roundhouse/db";
import {
  DOMAIN_VERIFY_WINDOW_MS,
  ownershipRecordName,
  ownershipRecordValue,
} from "@roundhouse/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCloudflareTransport } from "../src/lib/certificates/cloudflare-dns";
import { buildDesiredState } from "../src/lib/desired-state";
import {
  DEFAULT_DNS_RESOLVER,
  FALLBACK_DNS_RESOLVER,
  setDnsTransport,
} from "../src/lib/domains/dns";
import {
  planSaasCheck,
  runSaasTick,
  type SaasHostnameState,
  workspaceOrigin,
} from "../src/lib/domains/saas";
import { type FakeCloudflare, fakeCloudflare } from "./fake-cloudflare";
import type { Client } from "./helpers";
import { markReady, meshCluster } from "./mesh-helpers";
import { createProject, createService } from "./pipeline-helpers";

const ZONE_ID = "0123456789abcdef0123456789abcdef";
const ZONE = "saas.example.net";
// Test-only token; never a real credential.
const TOKEN = "test-cloudflare-token-0000000001";

let cf: FakeCloudflare;
const txt = new Map<string, string[]>();

beforeEach(() => {
  cf = fakeCloudflare({ zoneId: ZONE_ID, zoneName: ZONE, token: TOKEN });
  setCloudflareTransport(cf.fetch);
  txt.clear();
  setDnsTransport((async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const endpoint = `${url.origin}${url.pathname}`;
    if (endpoint !== DEFAULT_DNS_RESOLVER && endpoint !== FALLBACK_DNS_RESOLVER) {
      return new Response(null, { status: 404 });
    }
    const name = url.searchParams.get("name")!;
    const values = url.searchParams.get("type") === "TXT" ? (txt.get(name) ?? []) : [];
    return Response.json({
      Status: 0,
      ...(values.length ? { Answer: values.map((v) => ({ name, type: 16, data: `"${v}"` })) } : {}),
    });
  }) as typeof fetch);
});

afterEach(() => {
  setCloudflareTransport(null);
  setDnsTransport(null);
});

// -----------------------------------------------------------------------------
// State table
// -----------------------------------------------------------------------------

describe("SaaS check state table", () => {
  const now = Date.UTC(2026, 9, 27);
  const row = (over: Partial<typeof domains.$inferSelect> = {}) =>
    ({
      id: "dom_1",
      serviceId: "svc_1",
      environmentId: "env_1",
      hostname: "shop.example.com",
      type: "custom",
      targetPort: 8080,
      verificationStatus: "pending",
      tlsStatus: "pending",
      status: "pending_dns",
      mode: "cloudflare_saas",
      verificationToken: "abc",
      apex: false,
      dnsStatus: "unknown",
      ownershipStatus: "unknown",
      dnsObserved: null,
      error: null,
      checkAttempts: 0,
      pendingSince: new Date(now - 1000),
      lastCheckedAt: null,
      nextCheckAt: null,
      verifiedAt: null,
      hsts: null,
      tlsIssuer: null,
      tlsNotBefore: null,
      tlsNotAfter: null,
      tlsError: null,
      tlsUpdatedAt: null,
      cfCustomHostnameId: "cf1",
      cfStatus: null,
      cfSslStatus: null,
      cfErrors: null,
      cfDcv: null,
      createdAt: new Date(now - 1000),
      updatedAt: new Date(now - 1000),
      ...over,
    }) as typeof domains.$inferSelect;
  const state = (status: string, ssl: string | null = "pending_validation"): SaasHostnameState => ({
    id: "cf1",
    status,
    sslStatus: ssl,
    errors: status === "active" ? [] : ["custom hostname does not CNAME to this zone."],
    dcv: [],
  });
  const ownership = (ok: boolean) => ({
    cname: [],
    addresses: [],
    txt: ok ? [ownershipRecordValue("abc")] : [],
  });

  it.each([
    ["pending, any TXT", state("pending"), true, "pending_dns", "pending"],
    ["active without TXT", state("active"), false, "pending_verification", "pending"],
    ["active with TXT", state("active"), true, "issuing", "verified"],
  ])("%s", (_name, cf, txtOk, status, verification) => {
    const plan = planSaasCheck(row(), {
      now,
      cf,
      seen: ownership(txtOk),
      tlsMode: "managed",
    });
    expect(plan.patch.status ?? row().status).toBe(status);
    expect(plan.patch.verificationStatus ?? "pending").toBe(verification);
    expect(plan.patch.cfStatus).toBe(cf.status);
  });

  it("goes active only once the edge certificate and the origin certificate both are", () => {
    const issuing = row({ verificationStatus: "verified", status: "issuing", tlsStatus: "issued" });
    expect(
      planSaasCheck(issuing, {
        now,
        cf: state("active"),
        seen: ownership(true),
        tlsMode: "managed",
      }).patch.status,
    ).toBeUndefined();
    expect(
      planSaasCheck(issuing, {
        now,
        cf: state("active", "active"),
        seen: ownership(true),
        tlsMode: "managed",
      }).patch.status,
    ).toBe("active");
    const noOriginCert = row({ verificationStatus: "verified", status: "issuing" });
    expect(
      planSaasCheck(noOriginCert, {
        now,
        cf: state("active", "active"),
        seen: ownership(true),
        tlsMode: "managed",
      }).patch.status,
    ).toBeUndefined();
  });

  it("fails on blocked, moved or deleted, and after 72 hours", () => {
    for (const s of ["blocked", "moved", "deleted"]) {
      const plan = planSaasCheck(row(), {
        now,
        cf: state(s),
        seen: ownership(true),
        tlsMode: "managed",
      });
      expect(plan).toMatchObject({
        event: "failed",
        patch: { status: "failed", nextCheckAt: null },
      });
    }
    const late = planSaasCheck(row({ pendingSince: new Date(now - DOMAIN_VERIFY_WINDOW_MS) }), {
      now,
      cf: state("pending"),
      seen: ownership(false),
      tlsMode: "managed",
    });
    expect(late).toMatchObject({ event: "failed", patch: { verificationStatus: "failed" } });
  });

  it("keeps the state and retries when Cloudflare doesn't answer", () => {
    const plan = planSaasCheck(row(), {
      now,
      cf: null,
      cfError: "HTTP 500",
      seen: null,
      tlsMode: "managed",
    });
    expect(plan.event).toBeNull();
    expect(plan.patch.status).toBeUndefined();
    expect(plan.patch.error).toContain("HTTP 500");
    expect(+plan.patch.nextCheckAt!).toBeGreaterThan(now);
  });

  it("copies Cloudflare's errors verbatim", () => {
    const plan = planSaasCheck(row(), {
      now,
      cf: state("pending"),
      seen: ownership(false),
      tlsMode: "managed",
    });
    expect(plan.patch.cfErrors).toEqual(["custom hostname does not CNAME to this zone."]);
  });
});

// -----------------------------------------------------------------------------
// Setting and lifecycle
// -----------------------------------------------------------------------------

async function managed(owner: Client) {
  const res = await owner.json("/v1/instance/settings", {
    method: "PATCH",
    json: { tls_mode: "managed" },
  });
  expect(res.status).toBe(200);
}

type DomainSettings = {
  custom_domains: {
    mode: string;
    saas: { cname_target: string; fallback_origin: string; fallback_status: string | null } | null;
    quota: { used: number; included: number };
  };
};

function putSaas(owner: Client, json: Record<string, unknown>) {
  return owner.json<DomainSettings & { error: { code: string } }>("/v1/instance/domains", {
    method: "PUT",
    json,
  });
}

const SAAS_ON = {
  custom_domains_mode: "cloudflare_saas",
  saas: { zone_id: ZONE_ID, api_token: TOKEN },
};

describe("Cloudflare for SaaS setting", () => {
  it("needs managed TLS, a valid token and every ingress server on a ready mesh", async () => {
    const c = await meshCluster(2);
    const notManaged = await putSaas(c.owner, SAAS_ON);
    expect(notManaged.status).toBe(409);
    expect(notManaged.body.error.code).toBe("saas_requires_managed_tls");

    await managed(c.owner);
    const unready = await putSaas(c.owner, SAAS_ON);
    expect(unready.status).toBe(409);
    expect(unready.body.error.code).toBe("saas_requires_mesh");

    await markReady(c.members.map((m) => m.id));
    const badToken = await putSaas(c.owner, {
      ...SAAS_ON,
      saas: { zone_id: ZONE_ID, api_token: "wrong-token-but-long-enough" },
    });
    expect(badToken.status).toBe(422);
    expect(badToken.body.error.code).toBe("cloudflare_saas_invalid");
    expect(cf.records.size).toBe(0);
  });

  it("sets up origin records and the fallback origin, and never returns the token", async () => {
    const c = await meshCluster(2, { ready: true });
    await managed(c.owner);
    const res = await putSaas(c.owner, SAAS_ON);
    expect(res.status).toBe(200);
    expect(res.body.custom_domains).toMatchObject({
      mode: "cloudflare_saas",
      saas: {
        cname_target: `customers.${ZONE}`,
        fallback_origin: `origin.${ZONE}`,
        fallback_status: "pending_deployment",
      },
      quota: { used: 0, included: 100 },
    });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    const byName = (name: string) =>
      [...cf.records.values()].filter((r) => r.name === name).map((r) => `${r.type} ${r.content}`);
    expect(byName(`origin.${ZONE}`)).toEqual(["A 203.0.113.10"]);
    expect(byName(workspaceOrigin(c.workspaceId, ZONE))).toEqual(["A 203.0.113.10"]);
    expect(byName(`customers.${ZONE}`)).toEqual([`CNAME origin.${ZONE}`]);
    expect([...cf.records.values()].every((r) => r.proxied)).toBe(true);
    expect(cf.fallback.origin).toBe(`origin.${ZONE}`);

    // The minute tick follows the fallback origin until it is active.
    await runSaasTick(env, Date.now(), async () => {});
    const after = await c.owner.json<DomainSettings>("/v1/instance/domains");
    expect(after.body.custom_domains.saas!.fallback_status).toBe("active");

    const audit = await env.DB.prepare(
      "SELECT metadata FROM audit_logs WHERE action = 'instance.settings_updated' ORDER BY seq DESC LIMIT 1",
    ).first<{ metadata: string }>();
    expect(audit!.metadata).toContain("custom_domains_mode");
    expect(audit!.metadata).not.toContain(TOKEN);

    // Origin certificates come from managed TLS, so it can't be left now.
    const leave = await c.owner.json<{ error: { code: string } }>("/v1/instance/settings", {
      method: "PATCH",
      json: { tls_mode: "acme" },
    });
    expect(leave.status).toBe(409);
    expect(leave.body.error.code).toBe("saas_requires_managed_tls");
  });

  it("moves origin records when the ingress servers change", async () => {
    const c = await meshCluster(2, { ready: true });
    await managed(c.owner);
    expect((await putSaas(c.owner, SAAS_ON)).status).toBe(200);
    await createDb(env.DB)
      .update(nodes)
      .set({ publicIp: "203.0.113.20" })
      .where(eq(nodes.id, c.members[1]!.id));
    await runSaasTick(env, Date.now(), async () => {});
    const origin = [...cf.records.values()]
      .filter((r) => r.name === `origin.${ZONE}`)
      .map((r) => r.content)
      .sort();
    expect(origin).toEqual(["203.0.113.10", "203.0.113.20"]);
  });

  it("puts Cloudflare's ranges in desired state with the origin firewall on", async () => {
    const c = await meshCluster(2, { ready: true });
    await managed(c.owner);
    const res = await putSaas(c.owner, {
      ...SAAS_ON,
      saas: { zone_id: ZONE_ID, api_token: TOKEN, ingress_firewall: "cloudflare_only" },
    });
    expect(res.status).toBe(200);
    const body = await buildDesiredState(createDb(env.DB), env, c.members[0]!.id);
    expect(body!.ingress!.allowed_sources).toEqual([
      "173.245.48.0/20",
      "103.21.244.0/22",
      "104.16.0.0/13",
      "2400:cb00::/32",
      "2606:4700::/32",
    ]);
    // Turned off again (same zone, stored token): everyone is admitted.
    const off = await putSaas(c.owner, { saas: { zone_id: ZONE_ID, ingress_firewall: "off" } });
    expect(off.status).toBe(200);
    const open = await buildDesiredState(createDb(env.DB), env, c.members[0]!.id);
    expect(open!.ingress!.allowed_sources).toBeNull();
  });
});

describe("SaaS custom domains", () => {
  async function saasStage() {
    const c = await meshCluster(2, { ready: true });
    await managed(c.owner);
    expect((await putSaas(c.owner, SAAS_ON)).status).toBe(200);
    const project = await createProject(c.owner, c.workspaceId);
    const web = await createService(c.owner, project.id, {
      name: "web",
      source: { type: "image", image: "nginx:1.27" },
      config: { networking: { port: 8080 } },
    });
    return { ...c, project, web, environmentId: project.environments[0]!.id };
  }

  it("creates the custom hostname for the workspace's origin and verifies it", async () => {
    const s = await saasStage();
    // The customer published the ownership TXT before adding the domain.
    const added = await s.owner.json<{
      id: string;
      mode: string;
      status: string;
      records: { type: string; name: string; value: string; purpose: string }[];
      cf: { status: string } | null;
    }>(`/v1/services/${s.web.service.id}/domains`, {
      method: "POST",
      json: { environment_id: s.environmentId, hostname: "shop.example.com" },
    });
    expect(added.status).toBe(201);
    const [created] = [...cf.hostnames.values()];
    expect(created).toMatchObject({
      hostname: "shop.example.com",
      custom_origin_server: workspaceOrigin(s.workspaceId, ZONE),
    });
    expect(added.body.mode).toBe("cloudflare_saas");
    expect(added.body.records[0]).toMatchObject({
      type: "CNAME",
      name: "shop.example.com",
      value: `customers.${ZONE}`,
      purpose: "routing",
    });
    // DCV records only arrive on GET; the first check read them.
    expect(added.body.records.filter((r) => r.purpose === "cf_dcv").map((r) => r.name)).toContain(
      "_cf-custom-hostname.shop.example.com",
    );

    const [row] = await createDb(env.DB)
      .select()
      .from(domains)
      .where(eq(domains.id, added.body.id));
    txt.set(ownershipRecordName("shop.example.com"), [
      ownershipRecordValue(row!.verificationToken!),
    ]);
    const { checkDomain } = await import("../src/lib/domains/check");
    const checked = await checkDomain({ db: createDb(env.DB), env }, row!, s.workspaceId);
    expect(checked).toMatchObject({
      verificationStatus: "verified",
      status: "issuing",
      cfStatus: "active",
    });

    const quota = await s.owner.json<DomainSettings>("/v1/instance/domains");
    expect(quota.body.custom_domains.quota.used).toBe(1);
    const off = await putSaas(s.owner, { saas: null });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe("saas_in_use");
  });

  it("keeps the domain while Cloudflare can't delete its hostname, then deletes both", async () => {
    const s = await saasStage();
    const added = await s.owner.json<{ id: string }>(`/v1/services/${s.web.service.id}/domains`, {
      method: "POST",
      json: { environment_id: s.environmentId, hostname: "shop.example.com" },
    });
    cf.failNext(/^DELETE \/zones\/.+\/custom_hostnames\//);
    const refused = await s.owner.json<{ error: { code: string } }>(
      `/v1/domains/${added.body.id}`,
      {
        method: "DELETE",
      },
    );
    expect(refused.status).toBe(502);
    expect(refused.body.error.code).toBe("cloudflare_unavailable");
    expect([...cf.hostnames.values()][0]!.deleted).toBe(false);

    const removed = await s.owner.json(`/v1/domains/${added.body.id}`, { method: "DELETE" });
    expect(removed.status).toBe(204);
    expect([...cf.hostnames.values()][0]!.deleted).toBe(true);
  });

  it("counts a hostname Cloudflare no longer knows as deleted", async () => {
    const s = await saasStage();
    const added = await s.owner.json<{ id: string }>(`/v1/services/${s.web.service.id}/domains`, {
      method: "POST",
      json: { environment_id: s.environmentId, hostname: "shop.example.com" },
    });
    cf.hostnames.clear();
    const removed = await s.owner.json(`/v1/domains/${added.body.id}`, { method: "DELETE" });
    expect(removed.status).toBe(204);
  });

  it("refuses wildcards without Enterprise, and creates nothing when Cloudflare fails", async () => {
    const s = await saasStage();
    const wildcard = await s.owner.json<{ error: { code: string } }>(
      `/v1/services/${s.web.service.id}/domains`,
      { method: "POST", json: { environment_id: s.environmentId, hostname: "*.example.com" } },
    );
    expect(wildcard.status).toBe(422);
    expect(wildcard.body.error.code).toBe("wildcard_requires_enterprise");

    cf.failNext(/^POST \/zones\/.+\/custom_hostnames$/);
    const failed = await s.owner.json<{ error: { code: string } }>(
      `/v1/services/${s.web.service.id}/domains`,
      { method: "POST", json: { environment_id: s.environmentId, hostname: "shop.example.com" } },
    );
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe("cloudflare_unavailable");
    expect(
      await createDb(env.DB).select().from(domains).where(eq(domains.hostname, "shop.example.com")),
    ).toEqual([]);
  });

  it("only instance admins change the SaaS setting", async () => {
    const s = await saasStage();
    const { addMember } = await import("./helpers");
    const member = await addMember(s.owner, s.workspaceId, "saas-admin@example.com", "admin");
    const res = await member.json("/v1/instance/domains", { method: "PUT", json: { saas: null } });
    expect(res.status).toBe(403);
  });
});
