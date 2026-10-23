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
import { addMember, type Client, call, eventually, install, joinBody, joinNode } from "./helpers";

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
  failure_message: string | null;
  server_id: string | null;
  node_id: string | null;
  cancel_requested_at: number | null;
  estimated_monthly_cost: { monthly_cents: number; currency: string } | null;
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
    expect(await reconcileProviders(db, env)).toEqual({
      cleanedUp: 0,
      missing: 0,
      errors: 0,
      cancelled: 0,
    });
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

function cancel(owner: Client, workspaceId: string, id: string) {
  return owner.json<Provision>(`/v1/workspaces/${workspaceId}/node-provisions/${id}/cancel`, {
    method: "POST",
  });
}

async function offerPrice(owner: Client, workspaceId: string, plan: string, region: string) {
  const { body } = await owner.json<{
    offers: { plan: string; region: string; monthly_cents: number; currency: string }[];
  }>(`/v1/workspaces/${workspaceId}/providers/hetzner/offers?role=node`);
  const o = body.offers.find((x) => x.plan === plan && x.region === region)!;
  return { monthly_cents: o.monthly_cents, currency: o.currency };
}

/** Inserts a run as if a workflow were handling it, without starting one. */
async function insertRun(workspaceId: string, fields: Record<string, unknown>) {
  const row: Record<string, unknown> = {
    id: `prov_${crypto.randomUUID().replaceAll("-", "")}`,
    workspace_id: workspaceId,
    provider: "hetzner",
    name: "web-9",
    plan: "cx23",
    region: "fsn1",
    builder: 0,
    status: "queued",
    created_at: Date.now(),
    updated_at: Date.now(),
    ...fields,
  };
  const cols = Object.keys(row);
  await env.DB.prepare(
    `INSERT INTO node_provisions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
  )
    .bind(...Object.values(row))
    .run();
  return row.id as string;
}

async function liveJoinTokens(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM node_join_tokens WHERE expires_at > ? AND used_at IS NULL",
  )
    .bind(Date.now())
    .first<{ n: number }>();
  return row!.n;
}

describe("cost estimates", () => {
  it("records the chosen offer's catalogue price and shows it on the managed node only", async () => {
    const { owner, workspaceId } = await install();
    await connect(owner, workspaceId);
    const price = await offerPrice(owner, workspaceId, "cx23", "fsn1");
    const { body } = await provision(owner, workspaceId);
    await waitFor(owner, workspaceId, body.id, ["booting"]);
    const priced = await eventually(async () => {
      const { body: p } = await getProvision(owner, workspaceId, body.id);
      return p.estimated_monthly_cost ? p : undefined;
    }, 10_000);
    expect(priced.estimated_monthly_cost).toEqual(price);

    const joined = await call("/v1/nodes/join", {
      method: "POST",
      json: joinBody(joinTokenFromUserData(), { name: "web-1" }),
    });
    const { node_id } = (await joined.json()) as { node_id: string };
    await waitFor(owner, workspaceId, body.id, ["joined"]);
    await joinNode(owner, workspaceId, { name: "by-hand" });

    const detail = await owner.json<{ estimated_monthly_cost: unknown }>(
      `/v1/workspaces/${workspaceId}/nodes/${node_id}`,
    );
    expect(detail.body.estimated_monthly_cost).toEqual(price);
    const list = await owner.json<{
      nodes: { name: string; estimated_monthly_cost: unknown }[];
    }>(`/v1/workspaces/${workspaceId}/nodes`);
    expect(list.body.nodes.map((n) => [n.name, n.estimated_monthly_cost])).toEqual([
      ["by-hand", null],
      ["web-1", price],
    ]);
  });

  it("leaves the estimate unknown, and the run going, when the catalogue can't be read", async () => {
    introspector = await introspectWorkflow(env.PROVISION_WORKFLOW);
    const { owner, workspaceId } = await install();
    await connect(owner, workspaceId);
    let created = false;
    fake.intercept((req) => {
      if (fake.isCreate(req)) created = true;
      // The adapter reads the catalogue before creating (its offer check);
      // fail only the read for the price, after the server exists.
      return created && req.method === "GET" && req.path === "/server_types"
        ? fake.errorResponse(503)
        : undefined;
    });
    const { body } = await provision(owner, workspaceId);
    const [instance] = await eventually(async () => {
      const found = await introspector!.get();
      return found.length ? found : undefined;
    });
    expect(await instance!.waitForStepResult({ name: "record-price" })).toEqual({
      recorded: false,
    });
    const { body: p } = await getProvision(owner, workspaceId, body.id);
    expect(p).toMatchObject({ status: "booting", estimated_monthly_cost: null });
  }, 30_000);
});

describe("cancelling a run", () => {
  it("cancels a booting run: deletes the server, revokes the join token, audits once", async () => {
    const { owner, workspaceId } = await install();
    await connect(owner, workspaceId);
    const { body } = await provision(owner, workspaceId);
    const booting = await waitFor(owner, workspaceId, body.id, ["booting"]);
    const token = joinTokenFromUserData();

    const res = await cancel(owner, workspaceId, body.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "cancelled",
      failure_reason: "cancelled",
      server_id: booting.server_id,
      cancel_requested_at: expect.any(Number),
    });
    expect(fake.servers.size).toBe(0);
    expect(await liveJoinTokens()).toBe(0);
    const late = await call("/v1/nodes/join", { method: "POST", json: joinBody(token) });
    expect(late.status).toBe(401);

    const again = await cancel(owner, workspaceId, body.id);
    expect(again).toMatchObject({ status: 200, body: { status: "cancelled" } });
    const audit = await env.DB.prepare(
      "SELECT metadata FROM audit_logs WHERE action = 'node.provision_cancelled'",
    ).all<{ metadata: string }>();
    expect(audit.results.map((r) => JSON.parse(r.metadata))).toEqual([
      {
        provider: "hetzner",
        name: "web-1",
        from_status: "booting",
        status: "cancelled",
        server_id: booting.server_id,
      },
    ]);
    // Past the join timeout, nothing has overwritten the cancel.
    await new Promise((r) => setTimeout(r, 9000));
    expect((await getProvision(owner, workspaceId, body.id)).body.status).toBe("cancelled");
  }, 30_000);

  it("lets a run creating its server finish the cancel once the server exists", async () => {
    const { owner, workspaceId } = await install();
    await connect(owner, workspaceId);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fake.intercept(async (req) => {
      if (fake.isCreate(req)) await gate;
      return undefined;
    });
    const { body } = await provision(owner, workspaceId);
    await eventually(async () => {
      const { body: p } = await getProvision(owner, workspaceId, body.id);
      return p.step === "create_server" ? p : undefined;
    }, 10_000);

    const res = await cancel(owner, workspaceId, body.id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "creating", cancel_requested_at: expect.any(Number) });
    release();

    const done = await waitFor(owner, workspaceId, body.id, ["cancelled", "cleanup_failed"]);
    expect(done).toMatchObject({ status: "cancelled", server_id: expect.any(String) });
    expect(fake.requests.some((r) => fake.isDelete(r))).toBe(true);
    expect(fake.servers.size).toBe(0);
    expect(await liveJoinTokens()).toBe(0);
  }, 30_000);

  it("cancels a queued run without a provider call", async () => {
    const { owner, workspaceId } = await install();
    await connect(owner, workspaceId);
    const id = await insertRun(workspaceId, { status: "queued" });
    const before = fake.requests.length;
    const res = await cancel(owner, workspaceId, id);
    expect(res).toMatchObject({ status: 200, body: { status: "cancelled", server_id: null } });
    expect(fake.requests.length).toBe(before);
  });

  it("ends cleanup_failed when the delete fails, and the reconcile finishes it", async () => {
    const { owner, workspaceId } = await install();
    await connect(owner, workspaceId);
    let refuseDeletes = true;
    fake.intercept((req) =>
      refuseDeletes && fake.isDelete(req) ? fake.errorResponse(500) : undefined,
    );
    const { body } = await provision(owner, workspaceId);
    const booting = await waitFor(owner, workspaceId, body.id, ["booting"]);
    const res = await cancel(owner, workspaceId, body.id);
    expect(res.body).toMatchObject({
      status: "cleanup_failed",
      server_id: booting.server_id,
      failure_message: expect.stringContaining(`Deleting server ${booting.server_id} failed`),
    });
    expect(fake.servers.size).toBe(1);

    refuseDeletes = false;
    expect(await reconcileProviders(createDb(env.DB), env)).toMatchObject({ cleanedUp: 1 });
    expect((await getProvision(owner, workspaceId, body.id)).body.status).toBe("cancelled");
    expect(fake.servers.size).toBe(0);
  }, 30_000);

  it("finishes a stale cancel in the reconcile, deleting the server found by its labels", async () => {
    const { owner, workspaceId } = await install();
    await connect(owner, workspaceId);
    const id = await insertRun(workspaceId, {
      status: "creating",
      cancel_requested_at: Date.now() - 2 * 60 * 60 * 1000,
    });
    const serverId = fake.seedServer({
      name: "web-9",
      labels: {
        "roundhouse.managed": "true",
        "roundhouse.node": "web-9",
        "roundhouse.role": "node",
        "roundhouse.workspace": workspaceId,
      },
    });
    const other = fake.seedServer({
      name: "web-10",
      labels: {
        "roundhouse.managed": "true",
        "roundhouse.node": "web-10",
        "roundhouse.role": "node",
        "roundhouse.workspace": workspaceId,
      },
    });
    expect(await reconcileProviders(createDb(env.DB), env)).toMatchObject({ cancelled: 1 });
    const { body } = await getProvision(owner, workspaceId, id);
    expect(body).toMatchObject({ status: "cancelled", server_id: serverId });
    expect(fake.serverIds()).toEqual([other]);
  });

  it("refuses finished runs, other roles, and other workspaces", async () => {
    const { owner, workspaceId } = await install();
    await connect(owner, workspaceId);
    const failed = await insertRun(workspaceId, { status: "failed" });
    const joined = await insertRun(workspaceId, { status: "joined", name: "web-8" });
    expect((await cancel(owner, workspaceId, failed)).status).toBe(409);
    const j = await cancel(owner, workspaceId, joined);
    expect(j.status).toBe(409);
    expect(j.body).toMatchObject({ error: { message: expect.stringContaining("already joined") } });

    const queued = await insertRun(workspaceId, { status: "queued", name: "web-7" });
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    expect((await cancel(member, workspaceId, queued)).status).toBe(403);
    const { body: other } = await owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Other" },
    });
    expect((await cancel(owner, other.id, queued)).status).toBe(404);
    expect((await getProvision(owner, workspaceId, queued)).body.status).toBe("queued");
  });
});
