/**
 * Managed TLS (ADR 0009) end to end against a fake CA, a fake Cloudflare
 * DNS API and an in-memory DoH resolver: the Domains & TLS settings, the
 * certificate rows the tick keeps, HTTP-01 through the public responder,
 * DNS-01 for the apps wildcard and a delegated custom wildcard, storage,
 * distribution to a node (`cert_request` → sealed `cert_sync` → `cert_ack`
 * → domain active), failures with backoff, renewal with `replaces`, and the
 * workflow started by the minute tick.
 */
import { env, SELF } from "cloudflare:test";
import { createDb } from "@roundhouse/db";
import {
  CERTS_PROTOCOL_VERSION,
  type CertSync,
  type ControlMessage,
  certKeyAad,
  type DesiredState,
  openBox,
} from "@roundhouse/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POLICY_KEY, policyOf, TLS_ROUTES } from "../src/contracts";
import { app } from "../src/index";
import { setCloudflareTransport } from "../src/lib/certificates/cloudflare-dns";
import { inlineSteps } from "../src/lib/certificates/order";
import { runCertificateAttempt, setAcmeTransport } from "../src/lib/certificates/pipeline";
import { claimDueCertificates, syncCertificates } from "../src/lib/certificates/schedule";
import { managedTlsProblems } from "../src/lib/certificates/settings";
import { runMinuteTick } from "../src/lib/dispatch";
import {
  DEFAULT_DNS_RESOLVER,
  FALLBACK_DNS_RESOLVER,
  setDnsTransport,
} from "../src/lib/domains/dns";
import { CA_DIRECTORY, FakeCa } from "./fake-ca";
import { type Client, install, joinNode, NODE_ENCRYPTION_PRIVATE_KEY, ORIGIN } from "./helpers";
import {
  connectWorkloadAgent,
  createProject,
  createService,
  deploy,
  type FakeWorkloadAgent,
  IMAGE_SERVICE,
  isDesired,
  waitForStatus,
} from "./pipeline-helpers";

// -----------------------------------------------------------------------------
// Fakes: DoH resolver and Cloudflare DNS API sharing one zone
// -----------------------------------------------------------------------------

const ZONE_ID = "0123456789abcdef0123456789abcdef";
// Not a credential: the fake API below accepts exactly this string.
const CF_TOKEN = "test-dns-edit-token-not-real-0000";

class FakeDns {
  a = new Map<string, string[]>();
  cname = new Map<string, string>();
  txt = new Map<string, string[]>();
  cfRecords = new Map<string, { name: string; value: string }>();
  cfCalls: string[] = [];
  zoneName = "example.com";

  doh = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const endpoint = `${url.origin}${url.pathname}`;
    if (endpoint !== DEFAULT_DNS_RESOLVER && endpoint !== FALLBACK_DNS_RESOLVER) {
      return new Response(null, { status: 404 });
    }
    let name = url.searchParams.get("name")!;
    const type = url.searchParams.get("type")!;
    const answers: { name: string; type: number; data: string }[] = [];
    for (let i = 0; i < 8; i++) {
      const target = this.cname.get(name);
      if (!target) break;
      answers.push({ name: `${name}.`, type: 5, data: `${target}.` });
      if (type === "CNAME") break;
      name = target;
    }
    if (type === "TXT") {
      const values = [
        ...(this.txt.get(name) ?? []),
        ...[...this.cfRecords.values()].filter((r) => r.name === name).map((r) => r.value),
      ];
      for (const v of values) answers.push({ name, type: 16, data: `"${v}"` });
    }
    if (type === "A")
      for (const ip of this.a.get(name) ?? []) answers.push({ name, type: 1, data: ip });
    return Response.json({ Status: 0, ...(answers.length ? { Answer: answers } : {}) });
  }) as typeof fetch;

  cloudflare = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    this.cfCalls.push(`${method} ${url.pathname}`);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${CF_TOKEN}`) {
      return Response.json(
        { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
        { status: 403 },
      );
    }
    const base = `/client/v4/zones/${ZONE_ID}`;
    if (method === "GET" && url.pathname === base) {
      return Response.json({ success: true, result: { id: ZONE_ID, name: this.zoneName } });
    }
    if (method === "GET" && url.pathname === `${base}/dns_records`) {
      return Response.json({ success: true, result: [] });
    }
    if (method === "POST" && url.pathname === `${base}/dns_records`) {
      const body = JSON.parse(String(init?.body));
      const id = `rec${this.cfRecords.size + 1}`;
      this.cfRecords.set(id, {
        name: body.name,
        value: String(body.content).replace(/^"|"$/g, ""),
      });
      return Response.json({ success: true, result: { id } });
    }
    if (method === "DELETE" && url.pathname.startsWith(`${base}/dns_records/`)) {
      const id = url.pathname.split("/").at(-1)!;
      if (!this.cfRecords.delete(id)) {
        return Response.json({ success: false, errors: [] }, { status: 404 });
      }
      return Response.json({ success: true, result: { id } });
    }
    return Response.json({ success: false, errors: [{ message: "not found" }] }, { status: 404 });
  }) as typeof fetch;
}

let dns: FakeDns;
let ca: FakeCa;
/** Attempts claimed by routes and ticks, run inline by {@link issueDue}. */
let started: { certificateId: string; attempt: number }[] = [];
const realWorkflow = env.CERT_WORKFLOW;

beforeEach(() => {
  dns = new FakeDns();
  ca = new FakeCa();
  // Caddy on an ingress node proxies the CA's request to the public responder.
  ca.hooks.http01 = async (_name, token) => {
    const res = await SELF.fetch(`${ORIGIN}/v1/acme/http-01/${token}`);
    return res.status === 200 ? res.text() : null;
  };
  ca.hooks.dns01 = async (name) => {
    const res = await dns.doh(`${DEFAULT_DNS_RESOLVER}?name=_acme-challenge.${name}&type=TXT`);
    const body = (await res.json()) as { Answer?: { type: number; data: string }[] };
    return (body.Answer ?? []).filter((a) => a.type === 16).map((a) => a.data.replace(/"/g, ""));
  };
  setDnsTransport(dns.doh);
  setCloudflareTransport(dns.cloudflare);
  setAcmeTransport(ca.fetch);
  started = [];
  env.CERT_WORKFLOW = {
    create: async (o: { params: { certificateId: string; attempt: number } }) => {
      started.push(o.params);
      return {};
    },
  } as unknown as typeof env.CERT_WORKFLOW;
});

afterEach(() => {
  env.CERT_WORKFLOW = realWorkflow;
  setDnsTransport(null);
  setCloudflareTransport(null);
  setAcmeTransport(null);
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const db = () => createDb(env.DB);

interface DomainBody {
  id: string;
  hostname: string;
  status: string;
  tls_status: string;
  records: { type: string; name: string; value: string; purpose: string; state: string }[];
  tls: {
    status: string;
    issuer: string | null;
    not_after: number | null;
    nodes: { state: string }[];
  };
  error: string | null;
}

interface CertBody {
  id: string;
  kind: string;
  hostnames: string[];
  status: string;
  issuer: string | null;
  not_after: number | null;
  renew_after: number | null;
  error: string | null;
  failures: number;
  next_attempt_at: number | null;
  nodes: { acked: number; sent: number };
}

async function settings(owner: Client, json: Record<string, unknown>) {
  const res = await owner.json("/v1/instance/settings", { method: "PATCH", json });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

async function domainSettings(owner: Client, json: Record<string, unknown>) {
  return owner.json<Record<string, unknown> & { error?: { code: string; message: string } }>(
    "/v1/instance/domains",
    { method: "PUT", json },
  );
}

async function certificatesOf(owner: Client) {
  return (await owner.json<{ certificates: CertBody[] }>("/v1/instance/certificates")).body
    .certificates;
}

/** Claims what is due and runs every claimed attempt inline, as the workflow would. */
async function issueDue(now = Date.now()) {
  await syncCertificates(db(), now);
  await claimDueCertificates(env, db(), now);
  const outcomes = [];
  for (const p of started.splice(0)) {
    outcomes.push(await runCertificateAttempt(env, db(), p, inlineSteps));
  }
  return outcomes;
}

/**
 * An installed control plane with a protocol 6 node running a service, a
 * verified custom domain `shop.example.com` on it, and the fake CA.
 */
async function stage(options: { dns01?: boolean; generated?: boolean } = {}) {
  const installed = await install();
  const joined = await joinNode(installed.owner, installed.workspaceId);
  await env.DB.prepare("UPDATE nodes SET public_ip = '203.0.113.10' WHERE id = ?")
    .bind(joined.node_id)
    .run();
  const agent = await connectWorkloadAgent(
    joined,
    {},
    { protocol_version: CERTS_PROTOCOL_VERSION },
  );
  await settings(installed.owner, { apps_domain: "apps.example.com", tls_mode: "acme" });
  expect((await domainSettings(installed.owner, { acme_directory_url: CA_DIRECTORY })).status).toBe(
    200,
  );
  if (options.dns01) {
    const set = await domainSettings(installed.owner, {
      cloudflare_dns: { zone_id: ZONE_ID, api_token: CF_TOKEN },
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
  }
  const project = await createProject(installed.owner, installed.workspaceId);
  const created = await createService(installed.owner, project.id, {
    ...IMAGE_SERVICE,
    config: { networking: { generated_domain: options.generated === true } },
  });
  const s = {
    ...installed,
    joined,
    agent,
    envId: project.environments[0]!.id,
    serviceId: created.service.id,
  };
  const deployment = await deploy(s.owner, s.serviceId, s.envId);
  await waitForStatus(s.owner, deployment.id, ["active"]);
  await settings(s.owner, { tls_mode: "managed" });
  return s;
}

async function addVerified(s: Awaited<ReturnType<typeof stage>>, hostname: string) {
  const base = hostname.replace(/^\*\./, "");
  dns.a.set(hostname, ["203.0.113.10"]);
  const added = await s.owner.json<DomainBody>(`/v1/services/${s.serviceId}/domains`, {
    method: "POST",
    json: { environment_id: s.envId, hostname },
  });
  if (added.status !== 201) return added;
  const txt = added.body.records.find((r) => r.purpose === "ownership")!;
  dns.txt.set(txt.name, [txt.value]);
  const delegation = added.body.records.find((r) => r.purpose === "acme_delegation");
  if (delegation) dns.cname.set(`_acme-challenge.${base}`, delegation.value);
  await env.DB.prepare("UPDATE domains SET last_checked_at = NULL WHERE id = ?")
    .bind(added.body.id)
    .run();
  const checked = await s.owner.json<DomainBody>(`/v1/domains/${added.body.id}/check`, {
    method: "POST",
  });
  expect(checked.body.status).toBe("issuing");
  return checked;
}

async function domainUntil(
  owner: Client,
  id: string,
  done: (d: DomainBody) => boolean,
): Promise<DomainBody> {
  let d = (await owner.json<DomainBody>(`/v1/domains/${id}`)).body;
  for (let i = 0; i < 80 && !done(d); i++) {
    await new Promise((r) => setTimeout(r, 50));
    d = (await owner.json<DomainBody>(`/v1/domains/${id}`)).body;
  }
  return d;
}

const managesHost =
  (host: string) =>
  (m: ControlMessage): m is DesiredState =>
    isDesired(m) && !!m.ingress?.managed_hosts.includes(host);

/** Plays the agent's side of distribution: request, open, acknowledge. */
async function fetchAndAck(agent: FakeWorkloadAgent, nodeId: string, desired: DesiredState) {
  const ids = (desired.certificates ?? []).map((c) => c.id);
  agent.send({ type: "cert_request", ids });
  const wanted = new Set((desired.certificates ?? []).map((c) => c.sha256));
  const sync = await agent.waitFor(
    (m): m is CertSync & ControlMessage =>
      m.type === "cert_sync" &&
      m.upserts.length > 0 &&
      m.upserts.every((u) => wanted.has(u.sha256)),
  );
  for (const u of sync.upserts) {
    const opened = JSON.parse(
      new TextDecoder().decode(
        await openBox(
          NODE_ENCRYPTION_PRIVATE_KEY,
          u.key_sealed,
          "cert-key",
          certKeyAad(nodeId, u.id, u.sha256),
        ),
      ),
    ) as { key_pem: string };
    expect(opened.key_pem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    const manifest = desired.certificates!.find((c) => c.id === u.id)!;
    expect(u.sha256).toBe(manifest.sha256);
  }
  agent.send({ type: "cert_ack", ids: sync.upserts.map((u) => u.id) });
  return sync;
}

async function auditOf(action: string) {
  const rows = await env.DB.prepare(
    "SELECT workspace_id, metadata FROM audit_logs WHERE action = ? ORDER BY seq",
  )
    .bind(action)
    .all<{ workspace_id: string | null; metadata: string }>();
  return rows.results.map((r) => ({
    workspaceId: r.workspace_id,
    metadata: JSON.parse(r.metadata),
  }));
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("Domains & TLS settings", () => {
  it("serves every route session-only to instance admins, with a fresh session for changes", () => {
    const live = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } });
    for (const [name, route] of Object.entries(TLS_ROUTES)) {
      const op = (live.paths?.[route.path] as Record<string, Record<string, unknown>>)?.[
        route.method
      ];
      expect(op?.[POLICY_KEY], name).toEqual(policyOf(route));
      expect(policyOf(route)).toMatchObject({ auth: "session_only", action: "instance:manage" });
    }
    expect(policyOf(TLS_ROUTES.putInstanceDomains)).toMatchObject({
      reauth: true,
      audit: ["instance.settings_updated"],
    });
  });

  it("checks the Cloudflare token against its zone, never returns it, and audits without it", async () => {
    const { owner } = await install();
    await settings(owner, { apps_domain: "apps.example.com" });
    const initial = await owner.json<Record<string, unknown>>("/v1/instance/domains");
    expect(initial.body).toMatchObject({
      tls_mode: "acme",
      ingress_hostname: null,
      cloudflare_dns: null,
      acme: { directory_url: "https://acme-v02.api.letsencrypt.org/directory", account_url: null },
      managed: { available: true, problems: [], apps_wildcard: false, wildcard_domains: false },
    });

    const bad = await domainSettings(owner, {
      cloudflare_dns: { zone_id: ZONE_ID, api_token: "wrong-token-for-this-zone" },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error?.code).toBe("cloudflare_dns_invalid");

    dns.zoneName = "other.org";
    const outside = await domainSettings(owner, {
      cloudflare_dns: { zone_id: ZONE_ID, api_token: CF_TOKEN },
    });
    expect(outside.status).toBe(422);
    expect(outside.body.error?.message).toMatch(/apps\.example\.com isn't in the zone other\.org/);

    dns.zoneName = "example.com";
    const ok = await domainSettings(owner, {
      cloudflare_dns: { zone_id: ZONE_ID, api_token: CF_TOKEN },
      ingress_hostname: "ingress.example.com",
      acme_email: "ops@example.com",
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      ingress_hostname: "ingress.example.com",
      cloudflare_dns: { zone_id: ZONE_ID, zone_name: "example.com" },
      acme: { email: "ops@example.com" },
      managed: { apps_wildcard: true, wildcard_domains: false },
    });
    expect(JSON.stringify(ok.body)).not.toContain(CF_TOKEN);
    const stored = await env.DB.prepare(
      "SELECT value FROM instance_settings WHERE key = 'cloudflare_dns'",
    ).first<{ value: string }>();
    expect(stored!.value).not.toContain(CF_TOKEN);
    const audits = await auditOf("instance.settings_updated");
    expect(audits.at(-1)!.metadata.changed).toEqual(
      expect.arrayContaining(["ingress_hostname", "acme_email", "cloudflare_dns"]),
    );
    expect(JSON.stringify(audits)).not.toContain(CF_TOKEN);

    const removed = await domainSettings(owner, { cloudflare_dns: null });
    expect(removed.body).toMatchObject({ cloudflare_dns: null, managed: { apps_wildcard: false } });
  });

  it("needs an https public origin for managed mode", () => {
    // Over plain HTTP (local development) servers can't forward challenges
    // to a CA-reachable origin; the settings route refuses with these words.
    expect(managedTlsProblems({ PUBLIC_ORIGIN: "http://127.0.0.1:8787" })).toEqual([
      expect.stringMatching(/^PUBLIC_ORIGIN must be the control plane's https:/),
    ]);
    expect(managedTlsProblems({})).toHaveLength(1);
    expect(managedTlsProblems({ PUBLIC_ORIGIN: "https://cp.example.com" })).toEqual([]);
  });
});

describe("HTTP-01 responder", () => {
  it("answers live HTTP-01 tokens only", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO certificates (id, hostnames, kind, challenge, status, created_at, updated_at) VALUES ('cer_x', '[\"a.example.com\"]', 'custom', 'http-01', 'pending', ?, ?)",
    )
      .bind(now, now)
      .run();
    const insert = (token: string, type: string, expires: number) =>
      env.DB.prepare(
        "INSERT INTO acme_challenges (token, key_authorization, certificate_id, type, expires_at, created_at, updated_at) VALUES (?, ?, 'cer_x', ?, ?, ?, ?)",
      )
        .bind(token, `${token}.thumb`, type, expires, now, now)
        .run();
    await insert("live_token_aaaaaaaaaaaaaaaa", "http-01", now + 60_000);
    await insert("dead_token_aaaaaaaaaaaaaaaa", "http-01", now - 1);
    await insert("dns_token_aaaaaaaaaaaaaaaaa", "dns-01", now + 60_000);
    const get = (t: string) => SELF.fetch(`${ORIGIN}/v1/acme/http-01/${t}`);
    const live = await get("live_token_aaaaaaaaaaaaaaaa");
    expect(live.status).toBe(200);
    expect(await live.text()).toBe("live_token_aaaaaaaaaaaaaaaa.thumb");
    expect((await get("dead_token_aaaaaaaaaaaaaaaa")).status).toBe(404);
    expect((await get("dns_token_aaaaaaaaaaaaaaaaa")).status).toBe(404);
    expect((await get("short")).status).toBe(404);
    expect((await get("unknown_token_aaaaaaaaaaaaa")).status).toBe(404);
  });
});

describe("managed certificates", () => {
  it("issues a custom domain over HTTP-01 and hands it to the node, which makes the domain active", async () => {
    const s = await stage();
    const checked = await addVerified(s, "shop.example.com");
    const desiredBefore = await s.agent.waitFor(
      (m): m is DesiredState =>
        isDesired(m) &&
        m.workloads.some((w) => w.routes.some((r) => r.hostname === "shop.example.com")),
    );
    expect(desiredBefore.ingress).toEqual({
      acme_challenge_upstream: { url: `${ORIGIN}/v1/acme/http-01`, host: "cp.test" },
      allowed_sources: null,
      managed_hosts: [],
    });

    expect(await issueDue()).toContain("issued");
    const certs = await certificatesOf(s.owner);
    const cert = certs.find((c) => c.hostnames[0] === "shop.example.com")!;
    expect(cert).toMatchObject({
      kind: "custom",
      status: "issued",
      issuer: "Roundhouse Test CA Fake Intermediate",
      error: null,
      failures: 0,
    });
    expect(cert.renew_after).toBeGreaterThan(Date.now() + 49 * 86_400_000);
    expect(cert.next_attempt_at).toBe(cert.renew_after);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM acme_challenges").first<{ n: number }>())!.n,
    ).toBe(0);
    const issued = await auditOf("certificate.issued");
    expect(issued).toEqual([
      expect.objectContaining({
        workspaceId: s.workspaceId,
        metadata: expect.objectContaining({ hostnames: ["shop.example.com"] }),
      }),
    ]);

    const desired = await s.agent.waitFor(managesHost("shop.example.com"));
    expect(desired.certificates).toEqual([
      expect.objectContaining({ id: cert.id, not_after: cert.not_after }),
    ]);
    await fetchAndAck(s.agent, s.joined.node_id, desired);
    const active = await domainUntil(s.owner, checked.body.id, (d) => d.status === "active");
    expect(active).toMatchObject({ status: "active", tls_status: "issued" });
    expect(active.tls).toMatchObject({
      status: "issued",
      issuer: "Roundhouse Test CA Fake Intermediate",
      not_after: cert.not_after,
      nodes: [expect.objectContaining({ state: "issued" })],
    });
    expect((await certificatesOf(s.owner)).find((c) => c.id === cert.id)!.nodes).toEqual({
      acked: 1,
      sent: 1,
    });
  }, 60_000);

  it("only answers a node's request for certificates in its own manifest", async () => {
    const s = await stage();
    await addVerified(s, "shop.example.com");
    await issueDue();
    const [cert] = await certificatesOf(s.owner);
    const other = await joinNode(s.owner, s.workspaceId);
    const stranger = await connectWorkloadAgent(
      other,
      {},
      { protocol_version: CERTS_PROTOCOL_VERSION },
    );
    stranger.send({ type: "cert_request", ids: [cert!.id] });
    await new Promise((r) => setTimeout(r, 300));
    expect(stranger.received.some((m) => m.type === "cert_sync")).toBe(false);
  }, 60_000);

  it("records a refused order, retries with backoff, and keeps the domain issuing", async () => {
    const s = await stage();
    const checked = await addVerified(s, "shop.example.com");
    ca.hooks.http01 = async () => null;
    const before = Date.now();
    expect(await issueDue(before)).toEqual(["failed"]);
    const [cert] = await certificatesOf(s.owner);
    expect(cert).toMatchObject({ status: "failed", failures: 1 });
    expect(cert!.error).toMatch(/The CA refused the order: shop\.example\.com: Invalid response/);
    expect(cert!.next_attempt_at).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(await auditOf("certificate.failed")).toHaveLength(1);
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM acme_challenges").first<{ n: number }>())!.n,
    ).toBe(0);
    const d = (await s.owner.json<DomainBody>(`/v1/domains/${checked.body.id}`)).body;
    expect(d).toMatchObject({ status: "issuing", tls: { status: "failed" } });
    expect(d.tls).toBeDefined();

    // Nothing is due before the backoff ends.
    expect(await issueDue(before + 60_000)).toEqual([]);
    ca.hooks.http01 = async (_n, token) =>
      (await SELF.fetch(`${ORIGIN}/v1/acme/http-01/${token}`)).text();
    expect(await issueDue(before + 6 * 60_000)).toEqual(["issued"]);
  }, 60_000);

  it("renews with replaces, keeps serving the old chain meanwhile, and needs a fresh ack", async () => {
    const s = await stage();
    const checked = await addVerified(s, "shop.example.com");
    await issueDue();
    const first = await s.agent.waitFor(managesHost("shop.example.com"));
    await fetchAndAck(s.agent, s.joined.node_id, first);
    await domainUntil(s.owner, checked.body.id, (d) => d.status === "active");
    const [cert] = await certificatesOf(s.owner);
    const row = await env.DB.prepare("SELECT ari_cert_id, sha256 FROM certificates WHERE id = ?")
      .bind(cert!.id)
      .first<{ ari_cert_id: string; sha256: string }>();
    expect(row!.ari_cert_id).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const due = cert!.renew_after! + 1;
    expect(await issueDue(due)).toEqual(["issued"]);
    expect(ca.replaced.at(-1)).toBe(row!.ari_cert_id);
    const renewed = (await certificatesOf(s.owner))[0]!;
    expect(renewed.status).toBe("issued");
    expect(await auditOf("certificate.renewed")).toHaveLength(1);
    const after = await env.DB.prepare("SELECT sha256 FROM certificates WHERE id = ?")
      .bind(cert!.id)
      .first<{ sha256: string }>();
    expect(after!.sha256).not.toBe(row!.sha256);
    const second = await s.agent.waitFor(
      (m): m is DesiredState => isDesired(m) && m.certificates?.[0]?.sha256 === after!.sha256,
    );
    // Domain stays active; its TLS state waits for the node to load the new chain.
    const waiting = (await s.owner.json<DomainBody>(`/v1/domains/${checked.body.id}`)).body;
    expect(waiting.status).toBe("active");
    await fetchAndAck(s.agent, s.joined.node_id, second);
    const done = await domainUntil(s.owner, checked.body.id, (d) => d.tls.status === "issued");
    expect(done.tls.status).toBe("issued");
  }, 60_000);

  it("stores only the newest attempt's chain", async () => {
    const s = await stage();
    await addVerified(s, "shop.example.com");
    await syncCertificates(db());
    const [cert] = await certificatesOf(s.owner);
    await env.DB.prepare("UPDATE certificates SET attempts = 2 WHERE id = ?").bind(cert!.id).run();
    expect(
      await runCertificateAttempt(env, db(), { certificateId: cert!.id, attempt: 1 }, inlineSteps),
    ).toBe("superseded");
    expect((await certificatesOf(s.owner))[0]!.status).toBe("pending");
  }, 60_000);

  it("issues the apps wildcard over DNS-01 and removes the TXT record afterwards", async () => {
    const s = await stage({ dns01: true, generated: true });
    const outcomes = await issueDue();
    expect(outcomes).toContain("issued");
    const certs = await certificatesOf(s.owner);
    const wildcard = certs.find((c) => c.kind === "apps_wildcard")!;
    expect(wildcard).toMatchObject({ hostnames: ["*.apps.example.com"], status: "issued" });
    // The generated hostname is covered by the wildcard, not a certificate of its own.
    expect(certs.filter((c) => c.kind === "generated")).toEqual([]);
    expect(dns.cfCalls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
    expect(dns.cfRecords.size).toBe(0);
    expect(await auditOf("certificate.issued")).toEqual([
      expect.objectContaining({ workspaceId: null }),
    ]);
  }, 60_000);

  it("issues per-name certificates for generated hostnames without DNS-01", async () => {
    const s = await stage({ generated: true });
    await issueDue();
    const certs = await certificatesOf(s.owner);
    expect(certs.map((c) => c.kind)).toEqual(["generated"]);
    expect(certs[0]!.hostnames[0]).toMatch(/\.apps\.example\.com$/);
  }, 60_000);

  it("refuses wildcard domains without DNS-01", async () => {
    const plain = await stage();
    const refused = await addVerified(plain, "*.shop.example.com");
    expect((refused.body as unknown as { error: { message: string } }).error.message).toMatch(
      /Cloudflare DNS token/,
    );
  }, 60_000);

  it("issues wildcard domains through their _acme-challenge delegation", async () => {
    const s = await stage({ dns01: true });
    const added = await addVerified(s, "*.store.example.com");
    expect(added.status).toBe(200);
    const delegation = added.body.records.find((r) => r.purpose === "acme_delegation")!;
    expect(delegation).toMatchObject({
      name: "_acme-challenge.store.example.com",
      value: expect.stringMatching(/\.acme\.apps\.example\.com$/),
      state: "ok",
    });
    expect(await issueDue()).toEqual(expect.arrayContaining(["issued"]));
    const cert = (await certificatesOf(s.owner)).find(
      (c) => c.hostnames[0] === "*.store.example.com",
    )!;
    expect(cert).toMatchObject({ kind: "custom", status: "issued" });
    const written = dns.cfCalls.filter((c) => c.startsWith("POST"));
    expect(written.length).toBeGreaterThanOrEqual(2);
    const desired = await s.agent.waitFor(managesHost("*.store.example.com"));
    expect(
      desired.workloads.flatMap((w) => w.routes).some((r) => r.hostname === "*.store.example.com"),
    ).toBe(true);
  }, 90_000);

  it("starts a certificate workflow from the minute tick", async () => {
    const s = await stage();
    await addVerified(s, "shop.example.com");
    env.CERT_WORKFLOW = realWorkflow;
    const report = await runMinuteTick(env, Date.now());
    expect(report.certificates).toBeGreaterThanOrEqual(1);
    let cert: CertBody | undefined;
    for (let i = 0; i < 100; i++) {
      cert = (await certificatesOf(s.owner)).find((c) => c.hostnames[0] === "shop.example.com");
      if (cert?.status === "issued") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(cert?.status).toBe("issued");
  }, 60_000);
});
