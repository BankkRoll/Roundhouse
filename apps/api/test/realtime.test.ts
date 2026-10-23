/**
 * The project realtime socket: upgrade authentication (session, token,
 * membership, Origin) reported as close codes, presence (browsers only),
 * deployment fan-out, subscription-scoped log lines, per-user connection
 * caps, and the periodic session, token and membership re-check.
 */
import { env, introspectWorkflow, runDurableObjectAlarm, SELF } from "cloudflare:test";
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

function upgrade(
  projectId: string,
  cookie: string,
  headers: Record<string, string> = {},
  query = "",
) {
  return SELF.fetch(`${ORIGIN}/v1/projects/${projectId}/realtime${query}`, {
    headers: { upgrade: "websocket", origin: ORIGIN, cookie, ...headers },
  });
}

/** Completes an upgrade the server closes at once and returns its close code. */
async function closeCodeOf(res: Response): Promise<{ code: number; reason: string }> {
  const ws = res.webSocket;
  if (res.status !== 101 || !ws) throw new Error(`expected an upgrade, got ${res.status}`);
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason }));
  });
  ws.accept();
  return closed;
}

async function open(
  projectId: string,
  c: Client | { bearer: string },
  query = "",
): Promise<Socket> {
  const res =
    "bearer" in c
      ? await upgrade(projectId, "", { authorization: `Bearer ${c.bearer}`, origin: "" }, query)
      : await upgrade(projectId, c.cookie, {}, query);
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
    expect((await closeCodeOf(await upgrade(p.id, ""))).code).toBe(RoomCloseCode.unauthorized);
    expect(
      (await closeCodeOf(await upgrade(p.id, "", { authorization: "Bearer tok_nope" }))).code,
    ).toBe(RoomCloseCode.unauthorized);
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
    expect((await closeCodeOf(await upgrade(p.id, outsider.cookie))).code).toBe(
      RoomCloseCode.notFound,
    );
    expect((await closeCodeOf(await upgrade("prj_missing", owner.cookie))).code).toBe(
      RoomCloseCode.notFound,
    );
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
      const updated = await sock.waitFor(
        (m) =>
          m.type === "deployment.updated" &&
          (m.deployment as { id: string; status: string }).id === d.id &&
          (m.deployment as { status: string }).status === "active",
      );
      expect(updated.deployment).toMatchObject({ project_id: s.project.id });
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

  it("re-checks project access on every subscribe, not just membership", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    const sock = await open(p.id, member);
    // Changed behind the API's back, so no revalidation reaches the room.
    await env.DB.prepare("UPDATE workspaces SET member_default_project_role = 'none' WHERE id = ?")
      .bind(workspaceId)
      .run();
    sock.ws.send(
      JSON.stringify({ type: "subscribe", topic: { kind: "build_logs", build_id: "bld_x" } }),
    );
    expect((await sock.closed).code).toBe(RoomCloseCode.forbidden);
    expect(sock.messages).toContainEqual({ type: "access.revoked", reason: "project_access" });
  });
});

async function createToken(owner: Client, workspaceId: string, scopes: string[]) {
  const res = await owner.json<{ token: { id: string }; secret: string }>(
    `/v1/workspaces/${workspaceId}/tokens`,
    { method: "POST", json: { name: "watcher", scopes, expires_in_days: 30 } },
  );
  if (res.status !== 201) throw new Error(`token: ${res.status}`);
  return { id: res.body.token.id, bearer: res.body.secret };
}

function room(projectId: string) {
  return env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId));
}

describe("realtime principals", () => {
  it("accepts an API token without an Origin and keeps it out of presence", async () => {
    const { owner, workspaceId, userId } = await install();
    const p = await createProject(owner, workspaceId);
    const token = await createToken(owner, workspaceId, ["projects:read"]);
    const watcher = await open(p.id, token);
    const browser = await open(p.id, owner);
    const presence = await watcher.waitFor(
      (m) => m.type === "presence" && (m.users as unknown[]).length > 0,
    );
    // The creator is listed once, for the browser tab, never for the token.
    expect(presence.users).toEqual([expect.objectContaining({ user_id: userId })]);
    browser.ws.close();
    watcher.ws.close();
  });

  it("refuses a token without projects:read or for another workspace", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const narrow = await createToken(owner, workspaceId, ["nodes:read"]);
    const res = await upgrade(p.id, "", { authorization: `Bearer ${narrow.bearer}`, origin: "" });
    expect((await closeCodeOf(res)).code).toBe(RoomCloseCode.forbidden);

    const other = await owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Other" },
    });
    const elsewhere = await createToken(owner, other.body.id, ["projects:read"]);
    const res2 = await upgrade(p.id, "", { authorization: `Bearer ${elsewhere.bearer}` });
    expect((await closeCodeOf(res2)).code).toBe(RoomCloseCode.notFound);
  });

  it("leaves CLI sockets out of presence", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const viewer = await addMember(owner, workspaceId, "v@example.com", "viewer");
    const cli = await open(p.id, viewer, "?client=cli");
    const browser = await open(p.id, owner);
    const presence = await browser.waitFor(
      (m) => m.type === "presence" && (m.users as unknown[]).length > 0,
    );
    expect((presence.users as { name: string }[]).map((u) => u.name)).toEqual(["Mara Okafor"]);
    // The CLI still gets every broadcast, presence included.
    await cli.waitFor((m) => m.type === "presence");
    expect((await upgrade(p.id, owner.cookie, {}, "?client=robot")).status).toBe(400);
    cli.ws.close();
    browser.ws.close();
  });
});

describe("periodic re-check", () => {
  it("closes a socket whose session expired with 4401 and keeps checking the rest", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const viewer = await addMember(owner, workspaceId, "v@example.com", "viewer");
    const expiring = await open(p.id, viewer);
    const staying = await open(p.id, owner);
    expect(await room(p.id).connectionCount()).toBe(2);
    await env.DB.prepare(
      "UPDATE sessions SET expires_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)",
    )
      .bind(Date.now() - 1000, "v@example.com")
      .run();
    expect(await runDurableObjectAlarm(room(p.id))).toBe(true);
    expect(await expiring.closed).toMatchObject({ code: RoomCloseCode.unauthorized });
    // A socket that is still valid keeps the alarm armed.
    expect(await runDurableObjectAlarm(room(p.id))).toBe(true);
    // The remaining socket is told the expired viewer left, so it is still open.
    await staying.waitFor(
      (m) => m.type === "presence" && (m.users as { name: string }[]).length === 1,
    );
    expect(await room(p.id).connectionCount()).toBe(1);
    staying.ws.close();
  });

  it("closes a removed member's socket with 4403 without waiting for a subscribe", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const viewer = await addMember(owner, workspaceId, "v@example.com", "viewer");
    const sock = await open(p.id, viewer);
    const members = await owner.json<{ members: { id: string; email: string }[] }>(
      `/v1/workspaces/${workspaceId}/members`,
    );
    const member = members.body.members.find((m) => m.email === "v@example.com")!;
    await owner.request(`/v1/workspaces/${workspaceId}/members/${member.id}`, { method: "DELETE" });
    await runDurableObjectAlarm(room(p.id));
    expect(await sock.closed).toMatchObject({ code: RoomCloseCode.forbidden });
  });

  it("closes a revoked token's socket with 4401", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const token = await createToken(owner, workspaceId, ["projects:read"]);
    const sock = await open(p.id, token);
    await owner.request(`/v1/workspaces/${workspaceId}/tokens/${token.id}`, { method: "DELETE" });
    await runDurableObjectAlarm(room(p.id));
    expect(await sock.closed).toMatchObject({ code: RoomCloseCode.unauthorized });
  });

  it("closes every socket of a deleted project with 4404 and stops the alarm", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const sock = await open(p.id, owner);
    await owner.request(`/v1/projects/${p.id}`, { method: "DELETE" });
    expect(await runDurableObjectAlarm(room(p.id))).toBe(true);
    expect(await sock.closed).toMatchObject({ code: RoomCloseCode.notFound });
    await eventually(async () => ((await room(p.id).connectionCount()) === 0 ? true : undefined));
    expect(await runDurableObjectAlarm(room(p.id))).toBe(false);
  });
});

describe("revocation on access change", () => {
  async function userIdOf(owner: Client, workspaceId: string, email: string) {
    const { body } = await owner.json<{
      members: { id: string; user_id: string; email: string }[];
    }>(`/v1/workspaces/${workspaceId}/members`);
    return body.members.find((m) => m.email === email)!;
  }

  it("closes a removed member's sockets at once, saying why, and leaves others open", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const viewer = await addMember(owner, workspaceId, "v@example.com", "viewer");
    const gone = await open(p.id, viewer);
    const staying = await open(p.id, owner);
    const member = await userIdOf(owner, workspaceId, "v@example.com");
    await owner.request(`/v1/workspaces/${workspaceId}/members/${member.id}`, { method: "DELETE" });
    expect((await gone.closed).code).toBe(RoomCloseCode.forbidden);
    expect(gone.messages).toContainEqual({ type: "access.revoked", reason: "membership" });
    expect(await room(p.id).connectionCount()).toBe(1);
    staying.ws.close();
  });

  it("closes a socket when a role change takes the project away", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    await owner.request(`/v1/workspaces/${workspaceId}/access-settings`, {
      method: "PATCH",
      json: { viewer_default_project_role: "none" },
    });
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    const sock = await open(p.id, member);
    const m = await userIdOf(owner, workspaceId, "m@example.com");
    await owner.request(`/v1/workspaces/${workspaceId}/members/${m.id}`, {
      method: "PATCH",
      json: { role: "viewer" },
    });
    expect((await sock.closed).code).toBe(RoomCloseCode.forbidden);
    expect(sock.messages).toContainEqual({ type: "access.revoked", reason: "project_access" });
  });

  it("closes sockets when the workspace's default project role is lowered to none", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    const sock = await open(p.id, member);
    const mine = await open(p.id, owner);
    await owner.request(`/v1/workspaces/${workspaceId}/access-settings`, {
      method: "PATCH",
      json: { member_default_project_role: "none" },
    });
    expect((await sock.closed).code).toBe(RoomCloseCode.forbidden);
    expect(await room(p.id).connectionCount()).toBe(1);
    mine.ws.close();
  });

  it("closes a socket whose project grant is revoked, or whose team loses them", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    await owner.request(`/v1/workspaces/${workspaceId}/access-settings`, {
      method: "PATCH",
      json: { member_default_project_role: "none" },
    });
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    const m = await userIdOf(owner, workspaceId, "m@example.com");

    const grant = await owner.json<{ id: string }>(`/v1/projects/${p.id}/access`, {
      method: "PUT",
      json: { principal: { type: "user", id: m.user_id }, role: "viewer" },
    });
    const direct = await open(p.id, member);
    await owner.request(`/v1/projects/${p.id}/access/${grant.body.id}`, { method: "DELETE" });
    expect((await direct.closed).code).toBe(RoomCloseCode.forbidden);
    expect(direct.messages).toContainEqual({ type: "access.revoked", reason: "project_access" });

    const team = await owner.json<{ id: string }>(`/v1/workspaces/${workspaceId}/teams`, {
      method: "POST",
      json: { name: "Ops", user_ids: [m.user_id] },
    });
    await owner.request(`/v1/projects/${p.id}/access`, {
      method: "PUT",
      json: { principal: { type: "team", id: team.body.id }, role: "developer" },
    });
    const viaTeam = await open(p.id, member);
    await owner.request(`/v1/teams/${team.body.id}/members`, {
      method: "PUT",
      json: { user_ids: [] },
    });
    expect((await viaTeam.closed).code).toBe(RoomCloseCode.forbidden);
  });

  it("closes a revoked token's socket at once with 4401", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const token = await createToken(owner, workspaceId, ["projects:read"]);
    const sock = await open(p.id, token);
    const browser = await open(p.id, owner);
    await owner.request(`/v1/workspaces/${workspaceId}/tokens/${token.id}`, { method: "DELETE" });
    expect((await sock.closed).code).toBe(RoomCloseCode.unauthorized);
    expect(await room(p.id).connectionCount()).toBe(1);
    browser.ws.close();
  });

  it("closes every socket of a deleted project at once with 4404", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const sock = await open(p.id, owner);
    await owner.request(`/v1/projects/${p.id}`, { method: "DELETE" });
    expect((await sock.closed).code).toBe(RoomCloseCode.notFound);
  });
});
