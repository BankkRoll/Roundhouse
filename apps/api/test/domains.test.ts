/**
 * Custom domains (ADR 0009, direct mode) end to end against an in-memory
 * DNS-over-HTTPS resolver: hostname rules, uniqueness and takeover, the
 * `pending_dns → pending_verification → issuing → active` lifecycle, the
 * 72-hour failure and its resumption, the cron pass, RBAC with environment
 * protection, audit, and the route reaching (and leaving) a node's desired
 * state.
 */
import { env } from "cloudflare:test";
import { CERTS_PROTOCOL_VERSION, type DesiredState } from "@roundhouse/protocol";
import { DOMAIN_VERIFY_WINDOW_MS } from "@roundhouse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOMAIN_ROUTES, policyOf } from "../src/contracts";
import { app } from "../src/index";
import { planCheck, runDomainChecks } from "../src/lib/domains/check";
import {
  DEFAULT_DNS_RESOLVER,
  FALLBACK_DNS_RESOLVER,
  setDnsTransport,
  txtValue,
} from "../src/lib/domains/dns";
import {
  evaluateOwnership,
  evaluateRouting,
  type RoutingTargets,
} from "../src/lib/domains/records";
import { summarizeReports } from "../src/lib/domains/tls";
import { addMember, type Client, install, joinNode } from "./helpers";
import {
  connectWorkloadAgent,
  createProject,
  createService,
  deploy,
  IMAGE_SERVICE,
  isDesired,
  stage,
  waitForStatus,
} from "./pipeline-helpers";

// -----------------------------------------------------------------------------
// Fake resolver
// -----------------------------------------------------------------------------

interface FakeRecord {
  A?: string[];
  AAAA?: string[];
  CNAME?: string;
  TXT?: string[];
  SOA?: true;
}

const TYPES = { A: 1, CNAME: 5, SOA: 6, TXT: 16, AAAA: 28 } as const;

/** A DoH JSON resolver over a map of records, plus HTTPS probes of custom hosts. */
class FakeDns {
  zone = new Map<string, FakeRecord>();
  primaryDown = false;
  queries: string[] = [];
  probes: string[] = [];
  probe: () => Response | Error = () => new Response(null, { status: 404 });

  set(name: string, record: FakeRecord) {
    this.zone.set(name, { ...this.zone.get(name), ...record });
  }

  fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const endpoint = `${url.origin}${url.pathname}`;
    if (endpoint !== DEFAULT_DNS_RESOLVER && endpoint !== FALLBACK_DNS_RESOLVER) {
      this.probes.push(url.hostname);
      const out = this.probe();
      if (out instanceof Error) throw out;
      return out;
    }
    if (endpoint === DEFAULT_DNS_RESOLVER && this.primaryDown) {
      return new Response("down", { status: 503 });
    }
    const name = url.searchParams.get("name")!;
    const type = url.searchParams.get("type") as keyof typeof TYPES;
    this.queries.push(`${endpoint === DEFAULT_DNS_RESOLVER ? "cf" : "google"} ${type} ${name}`);
    const answers: { name: string; type: number; data: string }[] = [];
    let current = name;
    for (let i = 0; i < 8; i++) {
      const rec = this.zone.get(current);
      if (rec?.CNAME && type !== "TXT") {
        answers.push({ name: `${current}.`, type: TYPES.CNAME, data: `${rec.CNAME}.` });
        current = rec.CNAME;
        continue;
      }
      if (type === "TXT") {
        for (const v of rec?.TXT ?? [])
          answers.push({ name: current, type: TYPES.TXT, data: `"${v}"` });
      } else if (type === "SOA") {
        if (rec?.SOA) answers.push({ name: current, type: TYPES.SOA, data: "ns. host. 1 2 3 4 5" });
      } else {
        for (const ip of rec?.[type] ?? [])
          answers.push({ name: current, type: TYPES[type], data: ip });
      }
      break;
    }
    const known = answers.length > 0 || this.zone.has(name);
    return Response.json({ Status: known ? 0 : 3, ...(answers.length ? { Answer: answers } : {}) });
  }) as typeof fetch;
}

let dns: FakeDns;

beforeEach(() => {
  dns = new FakeDns();
  setDnsTransport(dns.fetch);
});

afterEach(() => setDnsTransport(null));

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface DomainBody {
  id: string;
  hostname: string;
  type: string;
  status: string;
  apex: boolean;
  verification_status: string;
  tls_status: string;
  error: string | null;
  next_check_at: number | null;
  verified_at: number | null;
  records: {
    type: string;
    name: string;
    value: string;
    purpose: string;
    state: string;
    note: string | null;
  }[];
}

async function setIngress(
  owner: Client,
  tls: string,
  appsDomain: string | null = "apps.example.com",
) {
  const res = await owner.json("/v1/instance/settings", {
    method: "PATCH",
    json: { apps_domain: appsDomain, tls_mode: tls },
  });
  expect(res.status).toBe(200);
}

async function setup(tls = "off") {
  const installed = await install();
  await setIngress(installed.owner, tls);
  const project = await createProject(installed.owner, installed.workspaceId);
  const svc = await createService(installed.owner, project.id, {
    ...IMAGE_SERVICE,
    config: { networking: { generated_domain: true } },
  });
  const envId = project.environments[0]!.id;
  const list = await installed.owner.json<{ domains: DomainBody[] }>(
    `/v1/services/${svc.service.id}/domains?environment_id=${envId}`,
  );
  return {
    ...installed,
    project,
    envId,
    serviceId: svc.service.id,
    generated: list.body.domains[0]!.hostname,
  };
}

function add(c: Client, s: { serviceId: string; envId: string }, hostname: string) {
  return c.json<DomainBody>(`/v1/services/${s.serviceId}/domains`, {
    method: "POST",
    json: { environment_id: s.envId, hostname },
  });
}

function check(c: Client, id: string) {
  return c.json<DomainBody>(`/v1/domains/${id}/check`, { method: "POST" });
}

/** Lets a manual check through the cooldown. */
async function forgetLastCheck(id: string) {
  await env.DB.prepare("UPDATE domains SET last_checked_at = NULL WHERE id = ?").bind(id).run();
}

function txtFor(d: DomainBody) {
  return d.records.find((r) => r.purpose === "ownership")!.value;
}

async function auditActions(workspaceId: string) {
  const rows = await env.DB.prepare(
    "SELECT action, actor_type, metadata FROM audit_logs WHERE workspace_id = ? AND action LIKE 'domain.%' ORDER BY seq",
  )
    .bind(workspaceId)
    .all<{ action: string; actor_type: string; metadata: string }>();
  return rows.results.map((r) => ({ ...r, metadata: JSON.parse(r.metadata) }));
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("custom domain contracts", () => {
  it("serves every route with services:read for reads and services:manage for changes", () => {
    const live = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } });
    for (const [name, route] of Object.entries(DOMAIN_ROUTES)) {
      const op = (live.paths?.[route.path] as Record<string, Record<string, unknown>>)?.[
        route.method
      ];
      expect(op, name).toBeDefined();
      expect(policyOf(route).action, name).toBe(
        route.method === "get" ? "services:read" : "services:manage",
      );
    }
    expect(policyOf(DOMAIN_ROUTES.addDomain).audit).toContain("domain.added");
    expect(policyOf(DOMAIN_ROUTES.removeDomain).audit).toEqual(["domain.removed"]);
  });
});

describe("adding a custom domain", () => {
  it("normalises the hostname, lists the records to create and checks DNS once", async () => {
    const s = await setup();
    const res = await add(s.owner, s, " Shop.Example.COM. ");
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      hostname: "shop.example.com",
      type: "custom",
      status: "pending_dns",
      verification_status: "pending",
      tls_status: "disabled",
      apex: false,
    });
    expect(res.body.records).toEqual([
      {
        type: "CNAME",
        name: "shop.example.com",
        value: s.generated,
        purpose: "routing",
        state: "missing",
        note: null,
      },
      {
        type: "TXT",
        name: "_roundhouse.shop.example.com",
        value: expect.stringMatching(/^rh-verify=[0-9a-f]{64}$/),
        purpose: "ownership",
        state: "missing",
        note: null,
      },
    ]);
    expect(res.body.error).toContain("No CNAME or A/AAAA record found for shop.example.com.");
    expect(res.body.next_check_at).toBeGreaterThan(Date.now());
    expect(dns.queries).toEqual(
      expect.arrayContaining([
        "cf A shop.example.com",
        "cf AAAA shop.example.com",
        "cf TXT _roundhouse.shop.example.com",
        "cf SOA shop.example.com",
      ]),
    );

    const list = await s.owner.json<{ domains: DomainBody[] }>(
      `/v1/services/${s.serviceId}/domains?environment_id=${s.envId}`,
    );
    expect(list.body.domains.map((d) => [d.type, d.status, d.records.length])).toEqual([
      ["custom", "pending_dns", 2],
      ["generated", "active", 0],
    ]);
    expect(await auditActions(s.workspaceId)).toEqual([
      {
        action: "domain.added",
        actor_type: "user",
        metadata: {
          hostname: "shop.example.com",
          service_id: s.serviceId,
          environment_id: s.envId,
        },
      },
    ]);
  });

  it("converts internationalised names to punycode", async () => {
    const s = await setup();
    const res = await add(s.owner, s, "bücher.example.com");
    expect(res.status).toBe(201);
    expect(res.body.hostname).toBe("xn--bcher-kva.example.com");
  });

  it.each([
    ["not a host", 400, "invalid_request"],
    ["localhost", 400, "invalid_request"],
    ["under_score.example.com", 400, "invalid_request"],
    ["*.example.com", 422, "hostname_not_allowed"],
    ["203.0.113.7", 422, "hostname_not_allowed"],
    ["api.corp.internal", 422, "hostname_not_allowed"],
    ["printer.local", 422, "hostname_not_allowed"],
    ["apps.example.com", 422, "hostname_not_allowed"],
    ["anything.apps.example.com", 422, "hostname_not_allowed"],
    ["cp.test", 422, "hostname_not_allowed"],
  ])("refuses %s", async (hostname, status, code) => {
    const s = await setup();
    const res = await add(s.owner, s, hostname);
    expect(res.status).toBe(status);
    expect((res.body as unknown as { error: { code: string } }).error.code).toBe(code);
  });

  it("refuses the ingress hostname and services without a port", async () => {
    const s = await setup();
    await env.DB.prepare(
      "INSERT INTO instance_settings (key, value, created_at, updated_at) VALUES ('ingress_hostname', '\"ingress.example.net\"', 0, 0)",
    ).run();
    expect((await add(s.owner, s, "ingress.example.net")).status).toBe(422);

    const worker = await createService(s.owner, s.project.id, {
      name: "worker",
      source: IMAGE_SERVICE.source,
      config: { networking: { port: null } },
    });
    const res = await add(
      s.owner,
      { serviceId: worker.service.id, envId: s.envId },
      "w.example.com",
    );
    expect(res.status).toBe(409);
  });

  it("offers the ingress hostname as the CNAME target when it is set", async () => {
    const s = await setup();
    await env.DB.prepare(
      "INSERT INTO instance_settings (key, value, created_at, updated_at) VALUES ('ingress_hostname', '\"ingress.example.net\"', 0, 0)",
    ).run();
    const res = await add(s.owner, s, "shop.example.com");
    expect(res.body.records[0]).toMatchObject({ type: "CNAME", value: "ingress.example.net" });
  });

  it("keeps hostnames unique across the install, except long-failed or orphaned ones", async () => {
    const s = await setup();
    const first = await add(s.owner, s, "shop.example.com");
    const ws = await s.owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Other" },
    });
    const p2 = await createProject(s.owner, ws.body.id);
    const svc2 = await createService(s.owner, p2.id, IMAGE_SERVICE);
    const target = { serviceId: svc2.service.id, envId: p2.environments[0]!.id };

    const taken = await add(s.owner, target, "shop.example.com");
    expect(taken.status).toBe(409);
    expect((taken.body as unknown as { error: { code: string } }).error.code).toBe("domain_taken");

    // Failed, but only for a day: still held.
    const day = Date.now() - 24 * 3600_000;
    await env.DB.prepare("UPDATE domains SET status = 'failed', updated_at = ? WHERE id = ?")
      .bind(day, first.body.id)
      .run();
    expect((await add(s.owner, target, "shop.example.com")).status).toBe(409);

    await env.DB.prepare("UPDATE domains SET updated_at = ? WHERE id = ?")
      .bind(Date.now() - 8 * 24 * 3600_000, first.body.id)
      .run();
    const claimed = await add(s.owner, target, "shop.example.com");
    expect(claimed.status).toBe(201);
    expect(txtFor(claimed.body)).not.toBe(txtFor(first.body));
    expect((await s.owner.request(`/v1/domains/${first.body.id}`)).status).toBe(404);
    expect((await auditActions(s.workspaceId)).at(-1)).toMatchObject({
      action: "domain.removed",
      actor_type: "system",
      metadata: { hostname: "shop.example.com", reason: "claimed_elsewhere" },
    });
  });

  it("caps custom domains per service and environment", async () => {
    const s = await setup();
    for (let i = 0; i < 20; i++) {
      expect((await add(s.owner, s, `d${i}.example.com`)).status).toBe(201);
    }
    expect((await add(s.owner, s, "d20.example.com")).status).toBe(409);
  });
});

describe("verification", () => {
  it("routes nothing on a dangling CNAME until the ownership TXT appears", async () => {
    const s = await setup("off");
    dns.set("shop.example.com", { CNAME: s.generated });
    dns.set(s.generated, { A: ["203.0.113.10"] });
    const added = await add(s.owner, s, "shop.example.com");
    expect(added.body).toMatchObject({
      status: "pending_verification",
      verification_status: "pending",
    });
    expect(added.body.records.map((r) => r.state)).toEqual(["ok", "missing"]);
    expect(added.body.error).toBe("TXT _roundhouse.shop.example.com not found.");

    dns.set("_roundhouse.shop.example.com", { TXT: ["rh-verify=someone-elses-token"] });
    await forgetLastCheck(added.body.id);
    const wrong = await check(s.owner, added.body.id);
    expect(wrong.body.verification_status).toBe("pending");
    expect(wrong.body.records[1]!.state).toBe("wrong");

    dns.set("_roundhouse.shop.example.com", { TXT: [txtFor(added.body)] });
    await forgetLastCheck(added.body.id);
    const ok = await check(s.owner, added.body.id);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      status: "active",
      verification_status: "verified",
      tls_status: "disabled",
      error: null,
    });
    expect(ok.body.records.map((r) => r.state)).toEqual(["ok", "ok"]);
    expect((await auditActions(s.workspaceId)).map((a) => [a.action, a.actor_type])).toEqual([
      ["domain.added", "user"],
      ["domain.verified", "user"],
    ]);
  });

  it("accepts A records that all point at the workspace's servers, and detects apexes", async () => {
    const s = await stage();
    await setIngress(s.owner, "internal", null);
    await env.DB.prepare("UPDATE nodes SET public_ip = '203.0.113.10' WHERE id = ?")
      .bind(s.joined.node_id)
      .run();
    dns.set("example.org", { SOA: true, A: ["203.0.113.10", "198.51.100.1"] });
    const added = await add(s.owner, s, "example.org");
    expect(added.body.apex).toBe(true);
    expect(added.body.records[0]).toMatchObject({
      type: "A",
      value: "203.0.113.10",
      state: "wrong",
    });
    expect(added.body.error).toContain("points to 203.0.113.10, 198.51.100.1");

    dns.set("example.org", { A: ["203.0.113.10"], TXT: [] });
    dns.set("_roundhouse.example.org", { TXT: [txtFor(added.body)] });
    await forgetLastCheck(added.body.id);
    const ok = await check(s.owner, added.body.id);
    expect(ok.body).toMatchObject({ status: "active", tls_status: "issued" });
  });

  it("in acme mode, waits in issuing without probing while no node serves the domain", async () => {
    const s = await setup("acme");
    dns.set("shop.example.com", { CNAME: s.generated });
    const pending = await add(s.owner, s, "shop.example.com");
    dns.set("_roundhouse.shop.example.com", { TXT: [txtFor(pending.body)] });
    await forgetLastCheck(pending.body.id);
    const verified = await check(s.owner, pending.body.id);
    expect(verified.body).toMatchObject({ status: "issuing", tls_status: "pending" });
    await forgetLastCheck(pending.body.id);
    const again = await check(s.owner, pending.body.id);
    expect(again.body).toMatchObject({ status: "issuing", tls_status: "pending" });
    expect(dns.probes).toEqual([]);
  });

  it("in acme mode, probes HTTPS when only older agents serve the domain", async () => {
    const s = await stage();
    await setIngress(s.owner, "acme");
    const deployment = await deploy(s.owner, s.serviceId, s.envId);
    await waitForStatus(s.owner, deployment.id, ["active"]);
    await env.DB.prepare("UPDATE nodes SET public_ip = '203.0.113.10' WHERE id = ?")
      .bind(s.joined.node_id)
      .run();
    dns.set("shop.example.com", { A: ["203.0.113.10"] });
    const pending = await add(s.owner, s, "shop.example.com");
    dns.set("_roundhouse.shop.example.com", { TXT: [txtFor(pending.body)] });
    await forgetLastCheck(pending.body.id);
    const verified = await check(s.owner, pending.body.id);
    expect(verified.body).toMatchObject({ status: "issuing", tls_status: "pending" });
    expect(dns.probes).toEqual([]);

    dns.probe = () => new TypeError("TLS handshake failed");
    await forgetLastCheck(pending.body.id);
    const waiting = await check(s.owner, pending.body.id);
    expect(waiting.body.status).toBe("issuing");
    expect(waiting.body.error).toBe("Waiting for the certificate: TLS handshake failed.");

    dns.probe = () => new Response(null, { status: 502 });
    await forgetLastCheck(pending.body.id);
    const active = await check(s.owner, pending.body.id);
    expect(active.body).toMatchObject({ status: "active", tls_status: "issued", error: null });
    expect(dns.probes).toEqual(["shop.example.com", "shop.example.com"]);
  });

  it("falls back to the second resolver when the first is down", async () => {
    const s = await setup();
    dns.primaryDown = true;
    dns.set("shop.example.com", { CNAME: s.generated });
    const added = await add(s.owner, s, "shop.example.com");
    expect(added.body.status).toBe("pending_verification");
    expect(dns.queries.some((q) => q.startsWith("google A shop.example.com"))).toBe(true);
  });

  it("throttles manual checks and refuses them for generated domains", async () => {
    const s = await setup();
    const added = await add(s.owner, s, "shop.example.com");
    const again = await check(s.owner, added.body.id);
    expect(again.status).toBe(429);
    const list = await s.owner.json<{ domains: DomainBody[] }>(
      `/v1/services/${s.serviceId}/domains?environment_id=${s.envId}`,
    );
    const generated = list.body.domains.find((d) => d.type === "generated")!;
    expect((await check(s.owner, generated.id)).status).toBe(409);
  });
});

describe("the schedule", () => {
  it("checks due domains from the cron, fails them after 72 hours, and resumes on a manual check", async () => {
    const s = await setup();
    const added = await add(s.owner, s, "shop.example.com");
    const db = env as unknown as Parameters<typeof runDomainChecks>[0];

    // Not due yet.
    expect(await runDomainChecks(db, Date.now())).toEqual({ checked: 0, verified: 0, failed: 0 });

    const later = Date.now() + 2 * 60_000;
    expect(await runDomainChecks(db, later)).toMatchObject({ checked: 1, failed: 0 });

    const expired = Date.now() + DOMAIN_VERIFY_WINDOW_MS + 60_000;
    expect(await runDomainChecks(db, expired)).toMatchObject({ checked: 1, failed: 1 });
    const failed = await s.owner.json<DomainBody>(`/v1/domains/${added.body.id}`);
    expect(failed.body).toMatchObject({
      status: "failed",
      verification_status: "failed",
      next_check_at: null,
    });
    expect(failed.body.error).toMatch(/^Not verified within 72 hours\./);
    expect(await runDomainChecks(db, expired + 3_600_000)).toMatchObject({ checked: 0 });
    expect((await auditActions(s.workspaceId)).map((a) => [a.action, a.actor_type])).toEqual([
      ["domain.added", "user"],
      ["domain.failed", "system"],
    ]);

    dns.set("shop.example.com", { CNAME: s.generated });
    dns.set("_roundhouse.shop.example.com", { TXT: [txtFor(added.body)] });
    await forgetLastCheck(added.body.id);
    const resumed = await check(s.owner, added.body.id);
    expect(resumed.body).toMatchObject({ status: "active", verification_status: "verified" });
  });

  it("verifies from the cron and drops domains of deleted services", async () => {
    const s = await setup();
    const added = await add(s.owner, s, "shop.example.com");
    dns.set("shop.example.com", { CNAME: s.generated });
    dns.set("_roundhouse.shop.example.com", { TXT: [txtFor(added.body)] });
    const db = env as unknown as Parameters<typeof runDomainChecks>[0];
    expect(await runDomainChecks(db, Date.now() + 2 * 60_000)).toMatchObject({
      checked: 1,
      verified: 1,
    });
    expect((await auditActions(s.workspaceId)).at(-1)).toMatchObject({
      action: "domain.verified",
      actor_type: "system",
    });

    const second = await add(s.owner, s, "two.example.com");
    expect(second.status).toBe(201);
    await s.owner.request(`/v1/services/${s.serviceId}`, { method: "DELETE" });
    expect(await runDomainChecks(db, Date.now() + 2 * 60_000)).toMatchObject({ checked: 1 });
    const row = await env.DB.prepare("SELECT next_check_at FROM domains WHERE id = ?")
      .bind(second.body.id)
      .first<{ next_check_at: number | null }>();
    expect(row?.next_check_at).toBeNull();
  });
});

describe("access", () => {
  it("lets viewers read, members change, and protected environments narrow changes", async () => {
    const s = await setup();
    const added = await add(s.owner, s, "shop.example.com");
    const viewer = await addMember(s.owner, s.workspaceId, "viewer@example.com", "viewer");
    const member = await addMember(s.owner, s.workspaceId, "member@example.com", "member");

    expect((await viewer.json(`/v1/domains/${added.body.id}`)).status).toBe(200);
    expect((await add(viewer, s, "v.example.com")).status).toBe(403);
    expect(
      (await viewer.request(`/v1/domains/${added.body.id}`, { method: "DELETE" })).status,
    ).toBe(403);
    expect((await add(member, s, "m.example.com")).status).toBe(201);

    const adminsOnly = { roles: [], userIds: [], teamIds: [] };
    await env.DB.prepare("UPDATE environments SET protected = 1, protection_rules = ? WHERE id = ?")
      .bind(
        JSON.stringify({ deploy: adminsOnly, config: adminsOnly, variables: adminsOnly }),
        s.envId,
      )
      .run();
    expect((await add(member, s, "m2.example.com")).status).toBe(403);
    await forgetLastCheck(added.body.id);
    expect((await check(member, added.body.id)).status).toBe(403);
    expect(
      (await member.request(`/v1/domains/${added.body.id}`, { method: "DELETE" })).status,
    ).toBe(403);
    expect((await member.json(`/v1/domains/${added.body.id}`)).status).toBe(200);
    expect((await add(s.owner, s, "o.example.com")).status).toBe(201);
  });

  it("hides domains of other workspaces", async () => {
    const s = await setup();
    const added = await add(s.owner, s, "shop.example.com");
    const ws = await s.owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Other" },
    });
    const stranger = await addMember(s.owner, ws.body.id, "stranger@example.com", "admin");
    expect((await stranger.json(`/v1/domains/${added.body.id}`)).status).toBe(404);
    expect(
      (await stranger.request(`/v1/domains/${added.body.id}`, { method: "DELETE" })).status,
    ).toBe(404);
  });
});

describe("removal", () => {
  it("removes custom domains only, with an audit entry", async () => {
    const s = await setup();
    const added = await add(s.owner, s, "shop.example.com");
    const list = await s.owner.json<{ domains: DomainBody[] }>(
      `/v1/services/${s.serviceId}/domains?environment_id=${s.envId}`,
    );
    const generated = list.body.domains.find((d) => d.type === "generated")!;
    expect(
      (await s.owner.request(`/v1/domains/${generated.id}`, { method: "DELETE" })).status,
    ).toBe(409);
    expect(
      (await s.owner.request(`/v1/domains/${added.body.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect((await s.owner.request(`/v1/domains/${added.body.id}`)).status).toBe(404);
    expect((await auditActions(s.workspaceId)).map((a) => a.action)).toEqual([
      "domain.added",
      "domain.removed",
    ]);
  });
});

describe("routing", () => {
  it("puts a verified custom domain into the node's routes and takes it out on removal", async () => {
    const s = await stage();
    const deployment = await deploy(s.owner, s.serviceId, s.envId);
    await waitForStatus(s.owner, deployment.id, ["active"]);
    await env.DB.prepare("UPDATE nodes SET public_ip = '203.0.113.10' WHERE id = ?")
      .bind(s.joined.node_id)
      .run();
    const routed = (m: DesiredState) =>
      m.workloads.some((w) => w.routes.some((r) => r.hostname === "shop.example.com"));

    dns.set("shop.example.com", { A: ["203.0.113.10"] });
    const pending = await add(s.owner, s, "shop.example.com");
    expect(pending.body.status).toBe("pending_verification");
    expect(s.agent.received.filter(isDesired).some(routed)).toBe(false);

    dns.set("_roundhouse.shop.example.com", { TXT: [txtFor(pending.body)] });
    await forgetLastCheck(pending.body.id);
    expect((await check(s.owner, pending.body.id)).body.verification_status).toBe("verified");
    const withRoute = await s.agent.waitFor((m): m is DesiredState => isDesired(m) && routed(m));
    expect(withRoute.workloads[0]!.routes).toContainEqual({
      hostname: "shop.example.com",
      container_port: 8080,
    });

    await s.owner.request(`/v1/domains/${pending.body.id}`, { method: "DELETE" });
    await s.agent.waitFor(
      (m): m is DesiredState => isDesired(m) && m.generation > withRoute.generation && !routed(m),
    );
  }, 30_000);
});

describe("check evaluation", () => {
  const targets: RoutingTargets = {
    cname: "web-production-ab12.apps.example.com",
    appsDomain: "apps.example.com",
    ingressHostname: null,
    addresses: ["203.0.113.10", "2001:db8::1"],
    servingAddresses: ["203.0.113.10", "2001:db8::1"],
    nodes: [],
  };
  const seen = (o: Partial<{ cname: string[]; addresses: string[]; txt: string[] }>) => ({
    cname: [],
    addresses: [],
    txt: [],
    ...o,
  });

  it.each([
    [seen({}), "missing"],
    [seen({ cname: ["web-production-ab12.apps.example.com"], addresses: ["192.0.2.1"] }), "ok"],
    [seen({ cname: ["other-x.apps.example.com"] }), "ok"],
    [seen({ cname: ["lb.example.net", "apps.example.com"] }), "ok"],
    [seen({ cname: ["shop.herokudns.com"], addresses: ["192.0.2.1"] }), "wrong"],
    [seen({ addresses: ["203.0.113.10", "2001:db8::1"] }), "ok"],
    [seen({ addresses: ["203.0.113.10", "192.0.2.1"] }), "wrong"],
    [seen({ cname: ["evilapps.example.com"] }), "wrong"],
  ])("judges routing %j as %s", (s, state) => {
    expect(evaluateRouting(s, targets)).toBe(state);
  });

  it("judges ownership by exact match", () => {
    expect(evaluateOwnership(seen({}), "abc")).toBe("missing");
    expect(evaluateOwnership(seen({ txt: ["v=spf1 -all", "rh-verify=abc"] }), "abc")).toBe("ok");
    expect(evaluateOwnership(seen({ txt: ["rh-verify=abcd"] }), "abc")).toBe("wrong");
  });

  it("decodes chunked TXT data", () => {
    expect(txtValue('"rh-verify=ab" "cd"')).toBe("rh-verify=abcd");
    expect(txtValue('"say \\"hi\\""')).toBe('say "hi"');
    expect(txtValue("bare")).toBe("bare");
  });

  it("never fails a domain on resolver errors and keeps verified domains routed", () => {
    const now = Date.now();
    const base = {
      id: "dom_1",
      serviceId: "svc_1",
      environmentId: "env_1",
      hostname: "shop.example.com",
      type: "custom" as const,
      targetPort: 8080,
      verificationStatus: "pending" as const,
      tlsStatus: "pending" as const,
      status: "pending_dns" as const,
      mode: "direct" as const,
      verificationToken: "abc",
      apex: false,
      dnsStatus: "unknown" as const,
      ownershipStatus: "unknown" as const,
      dnsObserved: null,
      error: null,
      checkAttempts: 3,
      pendingSince: new Date(now - DOMAIN_VERIFY_WINDOW_MS - 1),
      lastCheckedAt: null,
      nextCheckAt: null,
      verifiedAt: null,
      hsts: null,
      tlsIssuer: null,
      tlsNotBefore: null,
      tlsNotAfter: null,
      tlsError: null,
      tlsUpdatedAt: null,
      cfCustomHostnameId: null,
      cfStatus: null,
      cfSslStatus: null,
      cfErrors: null,
      cfDcv: null,
      createdAt: new Date(now - DOMAIN_VERIFY_WINDOW_MS - 1),
      updatedAt: new Date(now),
    };
    const lookupFailed = planCheck(base, {
      now,
      seen: null,
      lookupError: "HTTP 503",
      targets,
      tlsMode: "acme",
    });
    expect(lookupFailed.event).toBeNull();
    expect(lookupFailed.patch.status).toBeUndefined();
    expect(lookupFailed.patch.nextCheckAt).toEqual(new Date(now + 10 * 60_000));

    const verified = planCheck(
      { ...base, verificationStatus: "verified", status: "active", verifiedAt: new Date(now - 1) },
      { now, seen: { ...seen({}), apex: false }, targets, tlsMode: "acme" },
    );
    expect(verified.event).toBeNull();
    expect(verified.patch.verificationStatus).toBeUndefined();
    expect(verified.patch.error).toMatch(/^Records changed since verification:/);
  });
});

describe("TLS and HSTS", () => {
  async function v6Stage() {
    const installed = await install();
    const joined = await joinNode(installed.owner, installed.workspaceId);
    const agent = await connectWorkloadAgent(
      joined,
      {},
      { protocol_version: CERTS_PROTOCOL_VERSION },
    );
    const project = await createProject(installed.owner, installed.workspaceId);
    const created = await createService(installed.owner, project.id, IMAGE_SERVICE);
    const s = {
      ...installed,
      joined,
      agent,
      envId: project.environments[0]!.id,
      serviceId: created.service.id,
    };
    await setIngress(s.owner, "acme");
    const deployment = await deploy(s.owner, s.serviceId, s.envId);
    await waitForStatus(s.owner, deployment.id, ["active"]);
    await env.DB.prepare("UPDATE nodes SET public_ip = '203.0.113.10' WHERE id = ?")
      .bind(joined.node_id)
      .run();
    dns.set("shop.example.com", { A: ["203.0.113.10"] });
    const pending = await add(s.owner, s, "shop.example.com");
    dns.set("_roundhouse.shop.example.com", { TXT: [txtFor(pending.body)] });
    await forgetLastCheck(pending.body.id);
    const verified = await check(s.owner, pending.body.id);
    expect(verified.body).toMatchObject({ verification_status: "verified", status: "issuing" });
    return { ...s, domainId: pending.body.id };
  }

  const routeOf = (m: DesiredState, host: string) =>
    m.workloads.flatMap((w) => w.routes).find((r) => r.hostname === host);

  interface TlsBody extends DomainBody {
    hsts: { enabled: boolean };
    tls: {
      status: string;
      issuer: string | null;
      not_after: number | null;
      nodes: { node_id: string; state: string; error: string | null }[];
    };
    routing_nodes: { id: string; public_ip: string | null; serves: boolean }[];
  }

  async function domainUntil(
    s: { owner: Client; domainId: string },
    done: (d: TlsBody) => boolean,
  ) {
    let d = (await s.owner.json<TlsBody>(`/v1/domains/${s.domainId}`)).body;
    for (let i = 0; i < 60 && !done(d); i++) {
      await new Promise((r) => setTimeout(r, 50));
      d = (await s.owner.json<TlsBody>(`/v1/domains/${s.domainId}`)).body;
    }
    return d;
  }

  it("sends routes with HSTS and the ingress settings to protocol 6 agents", async () => {
    const s = await v6Stage();
    const routed = await s.agent.waitFor(
      (m): m is DesiredState => isDesired(m) && !!routeOf(m, "shop.example.com"),
    );
    expect(routeOf(routed, "shop.example.com")?.hsts).toEqual({
      max_age: 31_536_000,
      include_subdomains: false,
      preload: false,
    });
    expect(routed.ingress).toEqual({
      acme_challenge_upstream: null,
      allowed_sources: null,
      managed_hosts: [],
    });
    expect(routed.certificates).toEqual([]);
  }, 30_000);

  it("validates and applies a domain's HSTS policy", async () => {
    const s = await v6Stage();
    const patch = (json: unknown) =>
      s.owner.json<TlsBody & { error?: { code: string } }>(`/v1/domains/${s.domainId}`, {
        method: "PATCH",
        json,
      });
    const preload = { enabled: true, max_age: 31_536_000, include_subdomains: true, preload: true };
    const notApex = await patch({ hsts: preload, confirm_preload: "shop.example.com" });
    expect(notApex.status).toBe(422);
    expect(notApex.body.error?.code).toBe("invalid_hsts");
    expect((await patch({ hsts: { ...preload, include_subdomains: false } })).status).toBe(422);

    const off = await patch({
      hsts: { enabled: false, max_age: 0, include_subdomains: false, preload: false },
    });
    expect(off.status).toBe(200);
    expect(off.body.hsts).toMatchObject({ enabled: false });
    const updated = await s.agent.waitFor(
      (m): m is DesiredState =>
        isDesired(m) && !!routeOf(m, "shop.example.com") && !routeOf(m, "shop.example.com")!.hsts,
    );
    expect(routeOf(updated, "shop.example.com")).toEqual({
      hostname: "shop.example.com",
      container_port: 8080,
    });
    expect((await auditActions(s.workspaceId)).map((a) => a.action)).toContain("domain.updated");
  }, 30_000);

  it("requires typed consent to preload an apex", async () => {
    const s = await v6Stage();
    await env.DB.prepare("UPDATE domains SET apex = 1 WHERE id = ?").bind(s.domainId).run();
    const hsts = { enabled: true, max_age: 31_536_000, include_subdomains: true, preload: true };
    const missing = await s.owner.json<{ error: { code: string } }>(`/v1/domains/${s.domainId}`, {
      method: "PATCH",
      json: { hsts },
    });
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe("preload_confirmation_required");
    const confirmed = await s.owner.json(`/v1/domains/${s.domainId}`, {
      method: "PATCH",
      json: { hsts, confirm_preload: "shop.example.com" },
    });
    expect(confirmed.status).toBe(200);
  }, 30_000);

  it("moves an issuing domain to active on the serving node's cert_status", async () => {
    const s = await v6Stage();
    const notAfter = Date.now() + 80 * 86_400_000;
    s.agent.send({
      type: "cert_status",
      hostname: "shop.example.com",
      state: "issued",
      issuer: "R11",
      not_after: notAfter,
    });
    const issued = await domainUntil(s, (d) => d.status === "active");
    expect(issued).toMatchObject({ status: "active", tls_status: "issued" });
    expect(issued.tls).toMatchObject({ status: "issued", issuer: "R11", not_after: notAfter });
    expect(issued.tls.nodes).toEqual([
      expect.objectContaining({ node_id: s.joined.node_id, state: "issued", error: null }),
    ]);

    s.agent.send({
      type: "cert_status",
      hostname: "shop.example.com",
      state: "failed",
      error: "rate limited",
    });
    const failed = await domainUntil(s, (d) => d.tls.status === "failed");
    expect(failed.tls.status).toBe("failed");
    expect(failed.status).toBe("active");
  }, 30_000);

  it("ignores cert_status for hostnames the node doesn't serve", async () => {
    const s = await v6Stage();
    const other = await joinNode(s.owner, s.workspaceId);
    const stranger = await connectWorkloadAgent(
      other,
      {},
      { protocol_version: CERTS_PROTOCOL_VERSION },
    );
    stranger.send({ type: "cert_status", hostname: "shop.example.com", state: "issued" });
    await new Promise((r) => setTimeout(r, 300));
    const d = await s.owner.json<DomainBody>(`/v1/domains/${s.domainId}`);
    expect(d.body).toMatchObject({ status: "issuing", tls_status: "pending" });
  }, 30_000);

  it("points DNS at the servers that run the service when some don't", async () => {
    const s = await v6Stage();
    const other = await joinNode(s.owner, s.workspaceId);
    await env.DB.prepare("UPDATE nodes SET public_ip = '198.51.100.7' WHERE id = ?")
      .bind(other.node_id)
      .run();
    const d = await s.owner.json<TlsBody>(`/v1/domains/${s.domainId}`);
    expect(d.body.routing_nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: s.joined.node_id, serves: true }),
        expect.objectContaining({ id: other.node_id, serves: false }),
      ]),
    );
    expect(d.body.records.filter((r) => r.purpose === "routing")).toEqual([
      expect.objectContaining({
        type: "A",
        value: "203.0.113.10",
        note: expect.stringMatching(/served by 1 of 2 servers/),
      }),
    ]);
  }, 30_000);

  it("refuses acme with several ingress servers", async () => {
    const installed = await install();
    const settings = (json: unknown) =>
      installed.owner.json<{ error: { code: string } }>("/v1/instance/settings", {
        method: "PATCH",
        json,
      });
    await setIngress(installed.owner, "internal");
    await joinNode(installed.owner, installed.workspaceId);
    await joinNode(installed.owner, installed.workspaceId);
    const acme = await settings({ tls_mode: "acme" });
    expect(acme.status).toBe(409);
    expect(acme.body.error.code).toBe("acme_mode_single_ingress_only");
    const read = await installed.owner.json<{ ingress_nodes: number }>("/v1/instance/settings");
    expect(read.body.ingress_nodes).toBe(2);
  });
});

describe("TLS summaries", () => {
  const nodes = [
    { id: "node_a", name: "a" },
    { id: "node_b", name: "b" },
  ];
  const report = (nodeId: string, state: "issued" | "failed" | "pending", notAfter?: number) => ({
    domainId: "dom_1",
    nodeId,
    state,
    issuer: state === "issued" ? "LE" : null,
    notAfter: notAfter ? new Date(notAfter) : null,
    error: state === "failed" ? "boom" : null,
    reportedAt: new Date(),
  });

  it("is issued only once every serving node reported a certificate", () => {
    expect(summarizeReports(nodes, [report("node_a", "issued", 5)]).status).toBe("pending");
    const all = summarizeReports(nodes, [
      report("node_a", "issued", 9),
      report("node_b", "issued", 5),
    ]);
    expect(all).toMatchObject({ status: "issued", issuer: "LE", notAfter: 5 });
  });

  it("fails while any serving node fails and ignores nodes that don't serve", () => {
    const reports = [report("node_a", "issued", 9), report("node_b", "failed")];
    expect(summarizeReports(nodes, reports)).toMatchObject({ status: "failed", error: "b: boom" });
    expect(summarizeReports([nodes[0]!], reports).status).toBe("issued");
    expect(summarizeReports([], []).status).toBe("pending");
  });
});
