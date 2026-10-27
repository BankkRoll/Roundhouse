import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { type DesiredState, EnvelopeSchema, verifyEnvelope } from "@roundhouse/protocol";
import { OFFLINE_AFTER_MS } from "@roundhouse/shared";
import { describe, expect, it } from "vitest";
import { CloseCode } from "../src/durable/node-connection";
import {
  addMember,
  call,
  connectAgent,
  eventually,
  heartbeat,
  hello,
  install,
  joinBody,
  joinNode,
} from "./helpers";

type ApiNode = {
  id: string;
  status: string;
  cpu_percent: number | null;
  mem_used: number | null;
  docker_version: string | null;
  last_heartbeat_at: number | null;
};

describe("join tokens", () => {
  it("returns an install command pointing at this control plane", async () => {
    const { owner, workspaceId } = await install();
    const res = await owner.json<{ token: string; install_command: string; expires_at: number }>(
      `/v1/workspaces/${workspaceId}/nodes/join-tokens`,
      { method: "POST" },
    );
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^njt_[A-Za-z0-9_-]{43}$/);
    expect(res.body.install_command).toBe(
      `curl -fsSL https://cp.test/install.sh | sudo bash -s -- --token ${res.body.token}`,
    );
    expect(res.body.expires_at - Date.now()).toBeGreaterThan(14 * 60 * 1000);
  });

  it("cannot be created by viewers or members", async () => {
    const { owner, workspaceId } = await install();
    for (const role of ["viewer", "member"] as const) {
      const c = await addMember(owner, workspaceId, `${role}@example.com`, role);
      const res = await c.json(`/v1/workspaces/${workspaceId}/nodes/join-tokens`, {
        method: "POST",
      });
      expect(res.status).toBe(403);
    }
  });
});

describe("POST /v1/nodes/join", () => {
  it("registers a pending node and returns its identity", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    expect(joined.node_id).toMatch(/^node_/);
    expect(joined.credential).toMatch(/^nc_/);
    expect(joined.connect_url).toBe(`wss://cp.test/v1/nodes/${joined.node_id}/connect`);
    expect(joined.control_public_key).toMatch(/^[A-Za-z0-9+/]{43}=$/);

    const list = await owner.json<{ nodes: ApiNode[] }>(`/v1/workspaces/${workspaceId}/nodes`);
    expect(list.body.nodes).toEqual([
      expect.objectContaining({ id: joined.node_id, status: "pending" }),
    ]);
    expect(JSON.stringify(list.body)).not.toContain(joined.credential);
  });

  it("is single-use, including under concurrency", async () => {
    const { owner, workspaceId } = await install();
    const { body } = await owner.json<{ token: string }>(
      `/v1/workspaces/${workspaceId}/nodes/join-tokens`,
      { method: "POST" },
    );
    const attempts = await Promise.all(
      [0, 1, 2].map(() => call("/v1/nodes/join", { method: "POST", json: joinBody(body.token) })),
    );
    expect(attempts.map((r) => r.status).sort()).toEqual([201, 401, 401]);
  });

  it("rejects unknown and expired tokens", async () => {
    const { owner, workspaceId } = await install();
    const bogus = await call("/v1/nodes/join", { method: "POST", json: joinBody("njt_nope") });
    expect(bogus.status).toBe(401);
    expect(await bogus.json()).toMatchObject({ error: { code: "invalid_token" } });

    const { body } = await owner.json<{ token: string }>(
      `/v1/workspaces/${workspaceId}/nodes/join-tokens`,
      { method: "POST" },
    );
    await env.DB.prepare("UPDATE node_join_tokens SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    const expired = await call("/v1/nodes/join", { method: "POST", json: joinBody(body.token) });
    expect(expired.status).toBe(401);
  });

  it("validates the request body", async () => {
    await install();
    const res = await call("/v1/nodes/join", {
      method: "POST",
      json: joinBody("njt_x", { arch: "riscv64" }),
    });
    expect(res.status).toBe(400);
  });

  it("audits the join", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const audit = await owner.json<{
      items: { action: string; actor_type: string; target_id: string }[];
    }>(`/v1/workspaces/${workspaceId}/audit-logs`);
    expect(audit.body.items[0]).toMatchObject({
      action: "node.joined",
      actor_type: "node",
      actor_name: "hel-1",
      target_id: joined.node_id,
    });
  });
});

describe("agent connection", () => {
  it("rejects missing, wrong, and non-websocket requests", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const url = `/v1/nodes/${joined.node_id}/connect`;

    expect((await call(url)).status).toBe(426);
    expect((await call(url, { headers: { upgrade: "websocket" } })).status).toBe(401);
    expect(
      (await call(url, { headers: { upgrade: "websocket", authorization: "Bearer nc_wrong" } }))
        .status,
    ).toBe(401);

    const other = await joinNode(owner, workspaceId, { name: "fsn-2" });
    const crossed = await call(url, {
      headers: { upgrade: "websocket", authorization: `Bearer ${other.credential}` },
    });
    expect(crossed.status).toBe(401);
  });

  it("answers hello with signed welcome + desired_state frames", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const agent = await connectAgent(joined);
    agent.send(hello(joined.node_id));

    const welcome = await verifyEnvelope(
      EnvelopeSchema.parse(JSON.parse(await agent.next())),
      joined.control_public_key,
      joined.node_id,
    );
    expect(welcome).toMatchObject({
      ok: true,
      message: { type: "welcome", heartbeat_interval_ms: 10_000 },
    });
    const desired = await verifyEnvelope(
      EnvelopeSchema.parse(JSON.parse(await agent.next())),
      joined.control_public_key,
      joined.node_id,
    );
    expect(desired.ok).toBe(true);
    const msg = (desired as { message: DesiredState }).message;
    expect(msg).toMatchObject({ type: "desired_state", generation: 0, workloads: [] });
    expect(msg.exp - msg.iat).toBeLessThanOrEqual(5 * 60 * 1000);

    agent.ws.close();
  });

  it("marks the node online and records heartbeat usage", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const agent = await connectAgent(joined);
    agent.send(hello(joined.node_id, { docker_version: "28.0.0" }));
    await agent.next();
    await agent.next();
    agent.send(heartbeat(1, 42.5));

    const node = await eventually(async () => {
      const { body } = await owner.json<ApiNode>(
        `/v1/workspaces/${workspaceId}/nodes/${joined.node_id}`,
      );
      return body.cpu_percent === 42.5 ? body : undefined;
    });
    expect(node).toMatchObject({
      status: "online",
      docker_version: "28.0.0",
      mem_used: 11 * 2 ** 30,
    });
    expect(node.last_heartbeat_at).toBeGreaterThan(Date.now() - 5000);
    agent.ws.close();
  });

  it.each([
    ["heartbeat before hello", (_id: string) => heartbeat()],
    ["invalid JSON", (_id: string) => "{nope"],
    ["unknown message type", (_id: string) => ({ type: "rm_rf" })],
    ["hello for another node", (_id: string) => hello("node_someone_else")],
    ["future protocol version", (id: string) => hello(id, { protocol_version: 99 })],
    ["extra-large frame", (id: string) => hello(id, { kernel: "x".repeat(70 * 1024) })],
  ])("closes the socket on %s", async (_name, frame) => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const agent = await connectAgent(joined);
    agent.send(frame(joined.node_id));
    const closed = await agent.closed;
    expect([CloseCode.policy, CloseCode.tooBig]).toContain(closed.code);
  });

  it("lets a reconnect supersede the previous socket", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const first = await connectAgent(joined);
    const second = await connectAgent(joined);
    expect((await first.closed).code).toBe(CloseCode.replaced);
    second.send(hello(joined.node_id));
    expect(JSON.parse(await second.next())).toMatchObject({ v: 1 });
    second.ws.close();
  });

  it("marks silent nodes offline when the alarm fires", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const agent = await connectAgent(joined);
    agent.send(hello(joined.node_id));
    await agent.next();

    const stub = env.NODE_CONNECTION.get(env.NODE_CONNECTION.idFromName(joined.node_id));
    await runInDurableObject(stub, async (_obj, state) => {
      await state.storage.put("last_seen", Date.now() - OFFLINE_AFTER_MS - 1);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const { body } = await owner.json<ApiNode>(
      `/v1/workspaces/${workspaceId}/nodes/${joined.node_id}`,
    );
    expect(body.status).toBe("offline");
    const audit = await owner.json<{ items: { action: string }[] }>(
      `/v1/workspaces/${workspaceId}/audit-logs`,
    );
    expect(audit.body.items[0]!.action).toBe("node.went_offline");
  });

  it("reports stale nodes as offline even if the alarm hasn't run", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    await env.DB.prepare("UPDATE nodes SET status = 'online', last_heartbeat_at = ? WHERE id = ?")
      .bind(Date.now() - OFFLINE_AFTER_MS - 1000, joined.node_id)
      .run();
    const { body } = await owner.json<ApiNode>(
      `/v1/workspaces/${workspaceId}/nodes/${joined.node_id}`,
    );
    expect(body.status).toBe("offline");
  });
});

describe("removing a node", () => {
  it("disconnects the agent and revokes its credential", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const agent = await connectAgent(joined);
    agent.send(hello(joined.node_id));
    await agent.next();

    const del = await owner.request(`/v1/workspaces/${workspaceId}/nodes/${joined.node_id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(204);
    expect((await agent.closed).code).toBe(CloseCode.removed);

    const reconnect = await call(`/v1/nodes/${joined.node_id}/connect`, {
      headers: { upgrade: "websocket", authorization: `Bearer ${joined.credential}` },
    });
    expect(reconnect.status).toBe(401);
    const list = await owner.json<{ nodes: unknown[] }>(`/v1/workspaces/${workspaceId}/nodes`);
    expect(list.body.nodes).toEqual([]);
  });

  it("is limited to admins and owners", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    const res = await member.request(`/v1/workspaces/${workspaceId}/nodes/${joined.node_id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });
});

describe("node labels", () => {
  it("replaces a server's labels for nodes:manage, validates them and audits the change", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const path = `/v1/workspaces/${workspaceId}/nodes/${joined.node_id}/labels`;
    const put = (labels: Record<string, string>, c = owner) =>
      c.json<{ labels: Record<string, string> }>(path, { method: "PUT", json: { labels } });

    const saved = await put({ pool: "untrusted", "example.com/zone": "eu-1" });
    expect(saved.status).toBe(200);
    expect(saved.body.labels).toEqual({ pool: "untrusted", "example.com/zone": "eu-1" });
    const listed = await owner.json<{ nodes: { id: string; labels: Record<string, string> }[] }>(
      `/v1/workspaces/${workspaceId}/nodes`,
    );
    expect(listed.body.nodes[0]!.labels).toEqual(saved.body.labels);

    expect((await put({ Pool: "x" })).status).toBe(400);
    expect((await put({ pool: "a b" })).status).toBe(400);
    expect(
      (await put(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"])))).status,
    ).toBe(400);
    const member = await addMember(owner, workspaceId, "member@example.com", "member");
    expect((await put({}, member)).status).toBe(403);
    expect((await put({}, owner)).body.labels).toEqual({});
    expect(
      (
        await owner.json(`/v1/workspaces/${workspaceId}/nodes/node_nope/labels`, {
          method: "PUT",
          json: { labels: {} },
        })
      ).status,
    ).toBe(404);

    const audit = await env.DB.prepare(
      "SELECT metadata FROM audit_logs WHERE action = 'node.labels_updated' ORDER BY seq",
    ).all<{ metadata: string }>();
    expect(audit.results.map((r) => JSON.parse(r.metadata).after)).toEqual([
      { pool: "untrusted", "example.com/zone": "eu-1" },
      {},
    ]);
  });
});

describe("install.sh", () => {
  it("is served with this control plane's URL substituted", async () => {
    const res = await call("/install.sh");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("shellscript");
    const text = await res.text();
    expect(text.startsWith("#!")).toBe(true);
    expect(text).toContain("https://cp.test");
    expect(text).not.toContain("__CONTROL_PLANE_URL__");
  });
});
