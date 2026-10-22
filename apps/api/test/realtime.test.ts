/**
 * The project realtime socket: upgrade authentication (session, membership,
 * Origin), presence, deployment fan-out, subscription-scoped log lines,
 * per-user connection caps and membership re-checks.
 */
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_SOCKETS_PER_USER, RoomCloseCode } from "../src/durable/project-room";
import { addMember, type Client, eventually, install, ORIGIN } from "./helpers";
import { createProject, deploy, type Stage, stage, waitForStatus } from "./pipeline-helpers";

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
beforeEach(async () => {
  introspector = await introspectWorkflow(env.DEPLOY_WORKFLOW);
});
afterEach(async () => {
  await introspector?.dispose();
});

interface Socket {
  ws: WebSocket;
  messages: Record<string, unknown>[];
  /** Resolves with the first message (already received or future) matching `predicate`. */
  waitFor(
    predicate: (m: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>>;
  closed: Promise<{ code: number; reason: string }>;
}

function upgrade(projectId: string, cookie: string, headers: Record<string, string> = {}) {
  return SELF.fetch(`${ORIGIN}/v1/projects/${projectId}/realtime`, {
    headers: { upgrade: "websocket", origin: ORIGIN, cookie, ...headers },
  });
}

async function open(projectId: string, c: Client): Promise<Socket> {
  const res = await upgrade(projectId, c.cookie);
  const ws = res.webSocket;
  if (!ws) throw new Error(`upgrade failed: ${res.status} ${await res.text()}`);
  ws.accept();
  const messages: Record<string, unknown>[] = [];
  const listeners = new Set<() => void>();
  ws.addEventListener("message", (e) => {
    messages.push(JSON.parse(e.data as string));
    for (const l of [...listeners]) l();
  });
  return {
    ws,
    messages,
    closed: new Promise((resolve) => {
      ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason }));
    }),
    waitFor(predicate, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const hit = messages.find(predicate);
          if (!hit) return false;
          clearTimeout(timer);
          listeners.delete(check);
          resolve(hit);
          return true;
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error("realtime message not received in time"));
        }, timeoutMs);
        if (!check()) listeners.add(check);
      });
    },
  };
}

describe("realtime upgrade", () => {
  it("requires a WebSocket upgrade, a session, membership and our Origin", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const plain = await SELF.fetch(`${ORIGIN}/v1/projects/${p.id}/realtime`, {
      headers: { cookie: owner.cookie },
    });
    expect(plain.status).toBe(426);
    expect((await upgrade(p.id, "")).status).toBe(401);
    expect((await upgrade(p.id, owner.cookie, { origin: "https://evil.test" })).status).toBe(403);
    const noOrigin = await SELF.fetch(`${ORIGIN}/v1/projects/${p.id}/realtime`, {
      headers: { upgrade: "websocket", cookie: owner.cookie },
    });
    expect(noOrigin.status).toBe(403);

    const ws2 = await owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Other" },
    });
    const outsider = await addMember(owner, ws2.body.id, "o@example.com", "admin");
    expect((await upgrade(p.id, outsider.cookie)).status).toBe(404);
    const viewer = await addMember(owner, workspaceId, "v@example.com", "viewer");
    const ok = await upgrade(p.id, viewer.cookie);
    expect(ok.status).toBe(101);
    ok.webSocket?.accept();
    ok.webSocket?.close();
  });

  it("caps sockets per user", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const sockets: Socket[] = [];
    for (let i = 0; i < MAX_SOCKETS_PER_USER; i++) sockets.push(await open(p.id, owner));
    const extra = await upgrade(p.id, owner.cookie);
    expect(extra.status).toBe(429);
    for (const s of sockets) s.ws.close();
  });
});

describe("realtime messages", () => {
  it("announces presence of everyone connected", async () => {
    const { owner, workspaceId, userId } = await install();
    const p = await createProject(owner, workspaceId);
    const viewer = await addMember(owner, workspaceId, "v@example.com", "viewer");
    const a = await open(p.id, owner);
    await a.waitFor((m) => m.type === "presence");
    const b = await open(p.id, viewer);
    const both = await a.waitFor(
      (m) => m.type === "presence" && (m.users as unknown[]).length === 2,
    );
    expect((both.users as { user_id: string }[]).map((u) => u.user_id)).toContain(userId);
    b.ws.close();
    await a.waitFor(
      (m) =>
        m.type === "presence" &&
        (m.users as unknown[]).length === 1 &&
        a.messages.indexOf(m) > a.messages.indexOf(both),
    );
    a.ws.close();
  });

  it("fans deployment updates and events out to every socket", async () => {
    const s = await stage();
    const a = await open(s.project.id, s.owner);
    const b = await open(s.project.id, s.owner);
    const d = await deploy(s.owner, s.serviceId, s.envId);
    for (const sock of [a, b]) {
      await sock.waitFor(
        (m) =>
          m.type === "deployment.updated" &&
          (m.deployment as { id: string; status: string }).id === d.id &&
          (m.deployment as { status: string }).status === "active",
      );
      await sock.waitFor(
        (m) =>
          m.type === "deployment.event" &&
          (m.event as { type: string }).type === "rollout_finished",
      );
    }
    a.ws.close();
    b.ws.close();
  });

  it("sends log lines only to sockets subscribed to them", async () => {
    const s: Stage = await stage();
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const active = await waitForStatus(s.owner, d.id, ["active"]);
    const wl = active.placements![0]!.workload_id;
    const subscribed = await open(s.project.id, s.owner);
    const idle = await open(s.project.id, s.owner);
    subscribed.ws.send(
      JSON.stringify({
        type: "subscribe",
        topic: { kind: "deployment_logs", deployment_id: d.id },
      }),
    );
    // A round trip through the room proves the subscription landed first.
    await new Promise((r) => setTimeout(r, 100));
    s.agent.send({
      type: "logs",
      source: { type: "runtime", workload_id: wl, deployment_id: d.id },
      lines: [{ ts: Date.now(), stream: "stderr", text: "boom" }],
    });
    const msg = await subscribed.waitFor((m) => m.type === "log.lines");
    expect(msg).toEqual({
      type: "log.lines",
      source: { type: "runtime", service_id: s.serviceId, deployment_id: d.id, workload_id: wl },
      lines: [{ ts: expect.any(Number), stream: "stderr", text: "boom" }],
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(idle.messages.some((m) => m.type === "log.lines")).toBe(false);

    subscribed.ws.send(
      JSON.stringify({
        type: "unsubscribe",
        topic: { kind: "deployment_logs", deployment_id: d.id },
      }),
    );
    await new Promise((r) => setTimeout(r, 100));
    const before = subscribed.messages.length;
    s.agent.send({
      type: "logs",
      source: { type: "runtime", workload_id: wl, deployment_id: d.id },
      lines: [{ ts: Date.now(), stream: "stdout", text: "again" }],
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(subscribed.messages.slice(before).some((m) => m.type === "log.lines")).toBe(false);
    subscribed.ws.close();
    idle.ws.close();
  });

  it("replays a topic's recent lines to a new subscriber", async () => {
    const s: Stage = await stage();
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const active = await waitForStatus(s.owner, d.id, ["active"]);
    const wl = active.placements![0]!.workload_id;
    // Lines forwarded live before anyone subscribed, and possibly not yet in
    // a stored page, as when a viewer opens the logs right after a deploy.
    const watcher = await open(s.project.id, s.owner);
    s.agent.send({
      type: "logs",
      source: { type: "runtime", workload_id: wl, deployment_id: d.id },
      lines: [{ ts: Date.now(), stream: "stdout", text: "starting up" }],
    });
    // The node's object publishes to the room before it stores the line, so
    // once the line is stored the room has seen it.
    await eventually(async () => {
      const page = await s.owner.json<{ lines: { text: string }[] }>(
        `/v1/deployments/${d.id}/logs`,
      );
      return page.body.lines.some((l) => l.text === "starting up") ? true : undefined;
    }, 8000);
    expect(watcher.messages.some((m) => m.type === "log.lines")).toBe(false);

    const late = await open(s.project.id, s.owner);
    late.ws.send(
      JSON.stringify({
        type: "subscribe",
        topic: { kind: "deployment_logs", deployment_id: d.id },
      }),
    );
    const msg = await late.waitFor((m) => m.type === "log.lines");
    expect(msg).toEqual({
      type: "log.lines",
      source: { type: "runtime", service_id: s.serviceId, deployment_id: d.id, workload_id: wl },
      lines: [{ ts: expect.any(Number), stream: "stdout", text: "starting up" }],
    });
    watcher.ws.close();
    late.ws.close();
  });

  it("closes on invalid client messages", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const sock = await open(p.id, owner);
    sock.ws.send(JSON.stringify({ type: "subscribe", topic: { kind: "everything" } }));
    expect((await sock.closed).code).toBe(RoomCloseCode.policy);
  });

  it("stops subscriptions once membership is revoked", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const viewer = await addMember(owner, workspaceId, "v@example.com", "viewer");
    const sock = await open(p.id, viewer);
    const members = await owner.json<{ members: { id: string; email: string }[] }>(
      `/v1/workspaces/${workspaceId}/members`,
    );
    const member = members.body.members.find((m) => m.email === "v@example.com")!;
    await owner.request(`/v1/workspaces/${workspaceId}/members/${member.id}`, { method: "DELETE" });
    sock.ws.send(
      JSON.stringify({ type: "subscribe", topic: { kind: "build_logs", build_id: "bld_x" } }),
    );
    expect((await sock.closed).code).toBe(RoomCloseCode.forbidden);
  });
});
