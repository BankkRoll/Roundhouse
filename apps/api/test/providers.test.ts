/**
 * Cloud providers end to end against the in-memory Hetzner API from
 * `@roundhouse/providers`' tests: connecting a write-only token, offers,
 * provisioning through `ProvisionWorkflow` until the agent joins, failure
 * paths, deprovisioning on node delete, and the reconcile pass.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { createDb } from "@roundhouse/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeHetzner } from "../../../packages/providers/test/fakes/hetzner";
import { PROVIDER_ROUTES, policyOf } from "../src/contracts";
import { app } from "../src/index";
import { setProviderTransport } from "../src/lib/cloud-providers";
import { reconcileProviders } from "../src/lib/provisioning";
import { addMember, type Client, call, eventually, install, joinBody } from "./helpers";

const RW = "hz-rw-0123456789abcdefWXYZ";
const RO = "hz-ro-0123456789abcdefRDNL";
const BAD = "hz-bad-0123456789abcdefBAD";

let fake: FakeHetzner;
let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;

beforeEach(() => {
  fake = new FakeHetzner();
  fake.tokens.set(RW, "rw");
  fake.tokens.set(RO, "ro");
  setProviderTransport({ fetch: fake.fetch, sleep: async () => {}, maxRetries: 0 });
});

afterEach(async () => {
  setProviderTransport(null);
  await introspector?.dispose();
  introspector = undefined;
});

interface Provision {
  id: string;
  status: string;
  step: string | null;
  failure_reason: string | null;
  server_id: string | null;
  node_id: string | null;
}

async function connect(owner: Client, workspaceId: string, token = RW) {
  return owner.json<Record<string, unknown>>(`/v1/workspaces/${workspaceId}/integrations/hetzner`, {
    method: "PUT",
    json: { token },
  });
}

async function provision(owner: Client, workspaceId: string, overrides = {}) {
  return owner.json<Provision>(`/v1/workspaces/${workspaceId}/nodes/provision`, {
    method: "POST",
    json: { provider: "hetzner", plan: "cx23", region: "fsn1", name: "web-1", ...overrides },
  });
}

function getProvision(owner: Client, workspaceId: string, id: string) {
  return owner.json<Provision>(`/v1/workspaces/${workspaceId}/node-provisions/${id}`);
}

async function waitFor(owner: Client, workspaceId: string, id: string, statuses: string[]) {
  return eventually(async () => {
    const { body } = await getProvision(owner, workspaceId, id);
    return statuses.includes(body.status) ? body : undefined;
  }, 15_000);
}

/** The join token cloud-init would write, read back out of the fake's create request. */
function joinTokenFromUserData(): string {
  const create = fake.requests.find((r) => r.method === "POST" && r.path === "/servers");
  const userData = String((create?.body as { user_data?: string } | undefined)?.user_data);
  const match = /content: "(njt_[A-Za-z0-9_-]+)\\n"/.exec(userData);
  if (!match) throw new Error("no join token in user data");
  return match[1]!;
}

describe("cloud provider contracts", () => {
  it("serves every route with its policy, and needs fresh sessions for billable changes", () => {
    const live = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } });
    for (const [name, route] of Object.entries(PROVIDER_ROUTES)) {
      const op = (live.paths?.[route.path] as Record<string, Record<string, unknown>>)?.[
        route.method
      ];
      expect(op, name).toBeDefined();
      const policy = policyOf(route);
      if (route.method !== "get") expect(policy.reauth, name).toBe(true);
      else expect(policy.audit, name).toEqual([]);
    }
    expect(policyOf(PROVIDER_ROUTES.connectIntegration).auth).toBe("session_only");
  });
});

describe("integrations", () => {
  it("validates, seals and never returns the token", async () => {
    const { owner, workspaceId } = await install();

    const bad = await connect(owner, workspaceId, BAD);
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: { code: "provider_token_invalid" } });

    const ro = await connect(owner, workspaceId, RO);
    expect(ro.status).toBe(409);
    expect(ro.body).toMatchObject({ error: { code: "provider_read_only" } });

    const ok = await connect(owner, workspaceId);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      provider: "hetzner",
      connected: true,
      token_last4: "WXYZ",
      token_fingerprint: expect.stringMatching(/^[a-f0-9]{8}$/),
    });
    expect(JSON.stringify(ok.body)).not.toContain(RW);

    const list = await owner.json<{ integrations: { provider: string; connected: boolean }[] }>(
      `/v1/workspaces/${workspaceId}/integrations`,
    );
    expect(list.body.integrations.map((i) => [i.provider, i.connected])).toEqual([
      ["hetzner", true],
      ["digitalocean", false],
      ["vultr", false],
      ["linode", false],
    ]);

    const stored = await env.DB.prepare("SELECT token_sealed FROM provider_credentials").first<{
      token_sealed: string;
    }>();
    expect(stored!.token_sealed).not.toContain(RW);
    const audit = await env.DB.prepare(
      "SELECT action, metadata FROM audit_logs WHERE action LIKE 'provider.%'",
    ).all<{ action: string; metadata: string }>();
    expect(audit.results.map((r) => r.action)).toEqual(["provider.connected"]);
    expect(audit.results[0]!.metadata).not.toContain(RW);
  });

  it("re-seals under the same row when the token is replaced, and binds the ciphertext to it", async () => {
    const { owner, workspaceId } = await install();
    await connect(owner, workspaceId);
    const first = await env.DB.prepare("SELECT id, token_sealed FROM provider_credentials").first<{
      id: string;
      token_sealed: string;
    }>();
    const other = "hz-rw-other-0123456789abcd";
    fake.tokens.set(other, "rw");
    const replaced = await connect(owner, workspaceId, other);
    expect(replaced.body).toMatchObject({ token_last4: "abcd" });
    const second = await env.DB.prepare("SELECT id, token_sealed FROM provider_credentials").first<{
      id: string;
      token_sealed: string;
    }>();
    expect(second!.id).toBe(first!.id);
    expect(second!.token_sealed).not.toBe(first!.token_sealed);

    // A ciphertext moved to another row no longer opens: offers fail closed.
    await env.DB.prepare("UPDATE provider_credentials SET id = 'pcr_moved'").run();
    const offers = await owner.request(
      `/v1/workspaces/${workspaceId}/providers/hetzner/offers?role=builder`,
    );
    expect(offers.status).toBe(500);
  });

  it("is limited to owners and admins, and connecting to browser sessions", async () => {
    const { owner, workspaceId } = await install();
    const member = await addMember(owner, workspaceId, "dev@example.com", "member");
    expect((await connect(member, workspaceId)).status).toBe(403);
    expect((await member.request(`/v1/workspaces/${workspaceId}/integrations`)).status).toBe(403);
    expect((await member.request(`/v1/workspaces/${workspaceId}/node-provisions`)).status).toBe(
      200,
    );

    const { body } = await owner.json<{ secret: string }>(`/v1/workspaces/${workspaceId}/tokens`, {
      method: "POST",
      json: { name: "ci", scopes: ["nodes:read", "nodes:manage"], expires_in_days: null },
    });
    const res = await call(`/v1/workspaces/${workspaceId}/integrations/hetzner`, {
      method: "PUT",
      json: { token: RW },
      headers: { authorization: `Bearer ${body.secret}` },
    });
    expect(res.status).toBe(403);
  });

  it("refuses to disconnect while managed servers exist, unless forced", async () => {
    const { owner, workspaceId } = await install();
    await connect(owner, workspaceId);
    const { body: run } = await provision(owner, workspaceId);
    await waitFor(owner, workspaceId, run.id, ["booting"]);
    const path = `/v1/workspaces/${workspaceId}/integrations/hetzner`;
    expect((await owner.request(path, { method: "DELETE" })).status).toBe(409);
    expect((await owner.request(`${path}?force=true`, { method: "DELETE" })).status).toBe(204);
    expect((await owner.json<{ connected: boolean }>(path)).body.connected).toBe(false);
    // Without the token the unjoined server can't be deleted: it is flagged, not forgotten.
    const left = await eventually(async () => {
      const { body } = await getProvision(owner, workspaceId, run.id);
      return body.status === "cleanup_failed" ? body : undefined;
    }, 20_000);
    expect(left).toMatchObject({ failure_reason: "join_timeout", server_id: expect.any(String) });
    expect(fake.servers.size).toBe(1);
  }, 30_000);
});

describe("offers", () => {
  it("lists priced offers with recommendations and caches them", async () => {
    const { owner, workspaceId } = await install();
    const path = `/v1/workspaces/${workspaceId}/providers/hetzner/offers?role=node`;
    const before = await owner.json<{ error: { code: string } }>(path);
    expect(before.status).toBe(409);
    expect(before.body.error.code).toBe("provider_not_connected");

    await connect(owner, workspaceId);
    const { status, body } = await owner.json<{
      offers: { id: string; monthly_cents: number; currency: string }[];
      recommendations: { offer_id: string; reason: string }[];
    }>(path);
    expect(status).toBe(200);
    expect(body.offers.length).toBeGreaterThan(0);
    expect(body.recommendations.length).toBeGreaterThan(0);
    const ids = new Set(body.offers.map((o) => o.id));
    for (const r of body.recommendations) expect(ids.has(r.offer_id)).toBe(true);

    const calls = fake.requests.length;
    expect((await owner.json(path)).status).toBe(200);
    expect(fake.requests.length).toBe(calls);
  });
});

describe("provisioning", () => {
  it("creates the server, waits for the agent to join, and attaches the node", async () => {
    introspector = await introspectWorkflow(env.PROVISION_WORKFLOW);
    const { owner, workspaceId } = await install();
    await connect(owner, workspaceId);
    const started = await provision(owner, workspaceId, { builder: true });
    expect(started.status).toBe(202);
    expect(started.body.status).toBe("queued");

    const booting = await waitFor(owner, workspaceId, started.body.id, ["booting", "failed"]);
    expect(booting.status).toBe("booting");
    expect(booting.server_id).toBeTruthy();
    const created = fake.requests.find((r) => r.method === "POST" && r.path === "/servers")!;
    expect(created.body).toMatchObject({
      name: "web-1",
      labels: {
        "roundhouse.managed": "true",
        "roundhouse.node": "web-1",
        "roundhouse.role": "builder",
        "roundhouse.workspace": workspaceId,
      },
    });

    const token = joinTokenFromUserData();
    const joined = await call("/v1/nodes/join", {
      method: "POST",
      json: joinBody(token, { name: "web-1", hostname: "web-1" }),
    });
    expect(joined.status).toBe(201);
    const { node_id } = (await joined.json()) as { node_id: string };

    const done = await waitFor(owner, workspaceId, started.body.id, ["joined"]);
    expect(done.node_id).toBe(node_id);
    const node = await owner.json<Record<string, unknown>>(
      `/v1/workspaces/${workspaceId}/nodes/${node_id}`,
    );
    expect(node.body).toMatchObject({
      provider: "hetzner",
      region: "fsn1",
      provider_server_id: booting.server_id,
      provider_server_missing_at: null,
    });

    const [instance] = await introspector.get();
    await instance!.waitForStatus("complete");
    // SECURITY: persisted workflow output carries no secret.
    const output = JSON.stringify(await instance!.getOutput());
    expect(output).not.toContain(token);
    expect(output).not.toContain(RW);

    // Deleting the node deletes the cloud server (managed, right name).
    expect(fake.servers.size).toBe(1);
    const removed = await owner.request(`/v1/workspaces/${workspaceId}/nodes/${node_id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
    expect(fake.requests.some((r) => r.method === "DELETE" && r.path.startsWith("/servers/"))).toBe(
      true,
    );
    const actions = await env.DB.prepare(
      "SELECT action FROM audit_logs WHERE action LIKE 'node.%' ORDER BY seq",
    ).all<{ action: string }>();
    expect(actions.results.map((r) => r.action)).toEqual([
      "node.provision_requested",
      "node.joined",
      "node.provisioned",
      "node.removed",
      "node.deprovisioned",
    ]);
  });

  it("refuses duplicate names and unconnected providers", async () => {
    const { owner, workspaceId } = await install();
    const none = await provision(owner, workspaceId);
    expect(none.status).toBe(409);
    expect((none.body as unknown as { error: { code: string } }).error.code).toBe(
      "provider_not_connected",
    );
    await connect(owner, workspaceId);
    const first = await provision(owner, workspaceId);
    expect(first.status).toBe(202);
    expect((await provision(owner, workspaceId)).status).toBe(409);
    expect((await provision(owner, workspaceId, { name: "Bad_Name" })).status).toBe(400);
    await waitFor(owner, workspaceId, first.body.id, ["booting", "failed"]);
  });

  it("fails cleanly on an unavailable offer and revokes the join token", async () => {
    const { owner, workspaceId } = await install();
    await connect(owner, workspaceId);
    const { body } = await provision(owner, workspaceId, { plan: "cx999" });
    const failed = await waitFor(owner, workspaceId, body.id, ["failed", "cleanup_failed"]);
    expect(failed).toMatchObject({ status: "failed", failure_reason: "offer_unavailable" });
    expect(fake.servers.size).toBe(0);
    const tokens = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM node_join_tokens WHERE expires_at > ?",
    )
      .bind(Date.now())
      .first<{ n: number }>();
    expect(tokens!.n).toBe(0);
  });

  it("deletes a server whose agent never joins", async () => {
    const { owner, workspaceId } = await install();
    await connect(owner, workspaceId);
    const { body } = await provision(owner, workspaceId);
    await waitFor(owner, workspaceId, body.id, ["booting"]);
    const token = joinTokenFromUserData();
    const failed = await eventually(async () => {
      const { body: p } = await getProvision(owner, workspaceId, body.id);
      return p.status === "failed" || p.status === "cleanup_failed" ? p : undefined;
    }, 20_000);
    expect(failed.failure_reason).toBe("join_timeout");
    expect(failed.status).toBe("failed");
    expect(fake.requests.some((r) => r.method === "DELETE" && r.path.startsWith("/servers/"))).toBe(
      true,
    );
    const late = await call("/v1/nodes/join", { method: "POST", json: joinBody(token) });
    expect(late.status).toBe(401);
  }, 30_000);
});

describe("reconcile", () => {
  it("flags managed nodes whose server was deleted at the provider", async () => {
    const { owner, workspaceId } = await install();
    await connect(owner, workspaceId);
    const { body } = await provision(owner, workspaceId);
    await waitFor(owner, workspaceId, body.id, ["booting"]);
    const joined = await call("/v1/nodes/join", {
      method: "POST",
      json: joinBody(joinTokenFromUserData(), { name: "web-1" }),
    });
    const { node_id } = (await joined.json()) as { node_id: string };
    await waitFor(owner, workspaceId, body.id, ["joined"]);

    const db = createDb(env.DB);
    expect(await reconcileProviders(db, env)).toEqual({ cleanedUp: 0, missing: 0, errors: 0 });
    fake.servers.clear();
    expect(await reconcileProviders(db, env)).toMatchObject({ missing: 1 });
    const node = await owner.json<{ provider_server_missing_at: number | null }>(
      `/v1/workspaces/${workspaceId}/nodes/${node_id}`,
    );
    expect(node.body.provider_server_missing_at).toEqual(expect.any(Number));

    // Gone at the provider: removing the node still succeeds.
    const removed = await owner.request(`/v1/workspaces/${workspaceId}/nodes/${node_id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
  });

  it("keeps the cloud server when asked", async () => {
    const { owner, workspaceId } = await install();
    await connect(owner, workspaceId);
    const { body } = await provision(owner, workspaceId);
    await waitFor(owner, workspaceId, body.id, ["booting"]);
    const joined = await call("/v1/nodes/join", {
      method: "POST",
      json: joinBody(joinTokenFromUserData(), { name: "web-1" }),
    });
    const { node_id } = (await joined.json()) as { node_id: string };
    await waitFor(owner, workspaceId, body.id, ["joined"]);
    const removed = await owner.request(
      `/v1/workspaces/${workspaceId}/nodes/${node_id}?keep_server=true`,
      { method: "DELETE" },
    );
    expect(removed.status).toBe(204);
    expect(fake.servers.size).toBe(1);
  });
});
