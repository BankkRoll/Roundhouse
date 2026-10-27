/**
 * The web shell (ADR 0012 "Web shell", ADR 0014 §15): the upgrade's gate
 * (credential, Origin, `shell:open`, 2FA, freshness, protected
 * environments) reported as close codes, the relay through the node's
 * Durable Object to a fake protocol 7 agent (signed short-lived frames,
 * sealed input in `seq` order, output, exit), session records and audit
 * without terminal data, immediate revocation, node limits, the targets,
 * history and terminate routes, and MCP never offering a shell.
 */
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import {
  type ControlMessage,
  CREDENTIAL_FRAME_TTL_MS,
  DEFAULT_EXEC_COMMAND,
  EXEC_PROTOCOL_VERSION,
  type ExecInput,
  type ExecOpen,
  execInputAad,
  MAX_EXEC_SESSIONS_PER_NODE,
  openBox,
  SealedExecInputSchema,
} from "@roundhouse/protocol";
import { newId, SHELL_CLOSE_CODES } from "@roundhouse/shared";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_TOOLS } from "../src/mcp/tools";
import {
  addMember,
  type Client,
  eventually,
  type Installed,
  install,
  joinNode,
  NODE_ENCRYPTION_PRIVATE_KEY,
  nextTotpCode,
  ORIGIN,
  signInAs,
} from "./helpers";
import {
  connectWorkloadAgent,
  createProject,
  createService,
  type FakeWorkloadAgent,
} from "./pipeline-helpers";

const OWNER_EMAIL = "mara@example.com";
const OWNER_PASSWORD = "correct horse battery";

/** Sockets and agents a test opened, closed after it. */
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      // Already closed.
    }
  }
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface ShellStage {
  installed: Installed;
  owner: Client;
  workspaceId: string;
  projectId: string;
  envId: string;
  serviceId: string;
  deploymentId: string;
  workloadId: string;
  nodeId: string;
  agent: FakeWorkloadAgent;
}

/**
 * Installs, connects a protocol 7 agent and places one running replica of
 * an image service on it (rows written directly; the rollout itself is
 * covered elsewhere).
 */
async function shellStage(
  helloOverrides: Record<string, unknown> = { protocol_version: EXEC_PROTOCOL_VERSION },
): Promise<ShellStage> {
  const installed = await install();
  const { owner, workspaceId } = installed;
  const joined = await joinNode(owner, workspaceId);
  const agent = await connectWorkloadAgent(joined, {}, helloOverrides);
  cleanups.push(() => agent.ws.close());
  const project = await createProject(owner, workspaceId);
  const { service } = await createService(owner, project.id);
  const envId = project.environments[0]!.id;
  const deploymentId = newId("deployment");
  const workloadId = newId("workload");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO deployments (id, service_id, environment_id, config_version, status, trigger, created_at, updated_at) VALUES (?, ?, ?, 1, 'active', 'manual', ?, ?)",
    ).bind(deploymentId, service.id, envId, now, now),
    env.DB.prepare(
      "INSERT INTO placements (id, deployment_id, replica, node_id, workload_id, state, created_at, updated_at) VALUES (?, ?, 0, ?, ?, 'healthy', ?, ?)",
    ).bind(newId("placement"), deploymentId, joined.node_id, workloadId, now, now),
  ]);
  return {
    installed,
    owner,
    workspaceId,
    projectId: project.id,
    envId,
    serviceId: service.id,
    deploymentId,
    workloadId,
    nodeId: joined.node_id,
    agent,
  };
}

type Auth = Client | { bearer: string };

function upgrade(
  workloadId: string,
  auth: Auth | null,
  headers: Record<string, string> = {},
  query = "",
) {
  const authHeaders: Record<string, string> =
    auth === null
      ? { origin: ORIGIN }
      : "bearer" in auth
        ? { authorization: `Bearer ${auth.bearer}` }
        : { cookie: auth.cookie, origin: ORIGIN };
  return SELF.fetch(`${ORIGIN}/v1/workloads/${workloadId}/shell${query}`, {
    headers: { upgrade: "websocket", ...authHeaders, ...headers },
  });
}

/** Completes an upgrade the server closes at once and returns its close code. */
async function closeCodeOf(res: Response): Promise<number> {
  const ws = res.webSocket;
  if (res.status !== 101 || !ws) throw new Error(`expected an upgrade, got ${res.status}`);
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener("close", (e) => resolve(e.code));
  });
  ws.accept();
  return closed;
}

interface Terminal {
  ws: WebSocket;
  texts: Record<string, unknown>[];
  output: Uint8Array[];
  closed: Promise<{ code: number; reason: string }>;
  waitFor(predicate: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
}

async function connect(workloadId: string, auth: Auth, query = ""): Promise<Terminal> {
  const res = await upgrade(workloadId, auth, {}, query);
  const ws = res.webSocket;
  if (!ws) throw new Error(`upgrade failed: ${res.status} ${await res.text()}`);
  ws.accept();
  cleanups.push(() => ws.close());
  const texts: Record<string, unknown>[] = [];
  const output: Uint8Array[] = [];
  const listeners = new Set<() => void>();
  // Frames are handled in arrival order even though binary ones arrive as Blobs.
  let chain = Promise.resolve();
  ws.addEventListener("message", (e) => {
    chain = chain.then(async () => {
      if (typeof e.data === "string") texts.push(JSON.parse(e.data));
      else output.push(new Uint8Array(await (e.data as Blob).arrayBuffer()));
      for (const l of [...listeners]) l();
    });
  });
  return {
    ws,
    texts,
    output,
    closed: new Promise((resolve) => {
      ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason }));
    }),
    waitFor(predicate) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const hit = texts.find(predicate);
          if (!hit) return false;
          clearTimeout(timer);
          listeners.delete(check);
          resolve(hit);
          return true;
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error("shell message not received in time"));
        }, 8000);
        if (!check()) listeners.add(check);
      });
    },
  };
}

const isExec =
  <T extends ControlMessage["type"]>(type: T, sessionId?: string) =>
  (m: ControlMessage): m is Extract<ControlMessage, { type: T }> =>
    m.type === type &&
    (sessionId === undefined || (m as { session_id?: string }).session_id === sessionId);

/** Opens a terminal, plays the agent's `exec_opened`, and waits for `opened`. */
async function openedShell(s: ShellStage, auth: Auth, query = "") {
  const before = new Set(
    s.agent.received.filter(isExec("exec_open")).map((m) => (m as ExecOpen).session_id),
  );
  const term = await connect(s.workloadId, auth, query);
  const open = await s.agent.waitFor(
    (m): m is ExecOpen => m.type === "exec_open" && !before.has(m.session_id),
  );
  s.agent.send({ type: "exec_opened", session_id: open.session_id, user: "app" });
  await term.waitFor((m) => m.type === "opened");
  return { term, open, sessionId: open.session_id };
}

async function createToken(owner: Client, workspaceId: string, scopes: string[]) {
  const res = await owner.json<{ token: { id: string }; secret: string }>(
    `/v1/workspaces/${workspaceId}/tokens`,
    { method: "POST", json: { name: "cli", scopes, expires_in_days: 30 } },
  );
  if (res.status !== 201) throw new Error(`token: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.token.id, bearer: res.body.secret };
}

async function setProtected(owner: Client, envId: string, value: boolean) {
  const res = await owner.request(`/v1/environments/${envId}/protection`, {
    method: "PUT",
    json: { protected: value },
  });
  if (res.status !== 200) throw new Error(`protection: ${res.status} ${await res.text()}`);
}

async function sessionRow(id: string) {
  return env.DB.prepare("SELECT * FROM shell_sessions WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
}

async function auditOf(action: string) {
  const rows = await env.DB.prepare(
    "SELECT action, target_id, metadata FROM audit_logs WHERE action = ? ORDER BY seq",
  )
    .bind(action)
    .all<{ action: string; target_id: string; metadata: string | null }>();
  return rows.results;
}

function nodeStub(nodeId: string) {
  return env.NODE_CONNECTION.get(env.NODE_CONNECTION.idFromName(nodeId));
}

async function memberId(owner: Client, workspaceId: string, email: string) {
  const { body } = await owner.json<{ members: { id: string; user_id: string; email: string }[] }>(
    `/v1/workspaces/${workspaceId}/members`,
  );
  const m = body.members.find((x) => x.email === email);
  if (!m) throw new Error(`no member ${email}`);
  return m;
}

// -----------------------------------------------------------------------------
// Gate
// -----------------------------------------------------------------------------

describe("shell upgrade gate", () => {
  it("requires an upgrade, a credential, our Origin and a visible running workload", async () => {
    const s = await shellStage();
    const plain = await SELF.fetch(`${ORIGIN}/v1/workloads/${s.workloadId}/shell`, {
      headers: { cookie: s.owner.cookie, origin: ORIGIN },
    });
    expect(plain.status).toBe(426);
    expect((await upgrade(s.workloadId, s.owner, { origin: "https://evil.test" })).status).toBe(
      403,
    );
    expect(await closeCodeOf(await upgrade(s.workloadId, null))).toBe(
      SHELL_CLOSE_CODES.unauthorized,
    );
    expect(await closeCodeOf(await upgrade(s.workloadId, { bearer: "tok_nope" }))).toBe(
      SHELL_CLOSE_CODES.unauthorized,
    );
    expect(await closeCodeOf(await upgrade("wl_missing", s.owner))).toBe(
      SHELL_CLOSE_CODES.notFound,
    );
    expect(await closeCodeOf(await upgrade(s.workloadId, s.owner, {}, "?cmd=a%00b"))).toBe(
      SHELL_CLOSE_CODES.policy,
    );

    const other = await s.owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Other" },
    });
    const outsider = await addMember(s.owner, other.body.id, "o@example.com", "admin");
    expect(await closeCodeOf(await upgrade(s.workloadId, outsider))).toBe(
      SHELL_CLOSE_CODES.notFound,
    );

    await env.DB.prepare("UPDATE placements SET state = 'exited' WHERE workload_id = ?")
      .bind(s.workloadId)
      .run();
    expect(await closeCodeOf(await upgrade(s.workloadId, s.owner))).toBe(
      SHELL_CLOSE_CODES.notFound,
    );
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM shell_sessions").first("n")).toBe(0);
  });

  it("admits project admins only, with 2FA and a fresh session", async () => {
    const s = await shellStage();
    const member = await addMember(s.owner, s.workspaceId, "dev@example.com", "member");
    const viewer = await addMember(s.owner, s.workspaceId, "view@example.com", "viewer");
    expect(await closeCodeOf(await upgrade(s.workloadId, member))).toBe(
      SHELL_CLOSE_CODES.forbidden,
    );
    expect(await closeCodeOf(await upgrade(s.workloadId, viewer))).toBe(
      SHELL_CLOSE_CODES.forbidden,
    );
    const m = await memberId(s.owner, s.workspaceId, "dev@example.com");
    for (const role of ["developer", "deployer"]) {
      await s.owner.request(`/v1/projects/${s.projectId}/access`, {
        method: "PUT",
        json: { principal: { type: "user", id: m.user_id }, role },
      });
      expect(await closeCodeOf(await upgrade(s.workloadId, member)), role).toBe(
        SHELL_CLOSE_CODES.forbidden,
      );
    }

    const admin = await addMember(s.owner, s.workspaceId, "admin@example.com", "admin");
    const adminRow = await memberId(s.owner, s.workspaceId, "admin@example.com");
    await env.DB.prepare("UPDATE users SET two_factor_enabled = 0 WHERE id = ?")
      .bind(adminRow.user_id)
      .run();
    expect(await closeCodeOf(await upgrade(s.workloadId, admin))).toBe(
      SHELL_CLOSE_CODES.twoFactorRequired,
    );

    const stale = Date.now() - 11 * 60 * 1000;
    await env.DB.prepare(
      "UPDATE sessions SET created_at = ?, reauthenticated_at = NULL WHERE user_id = ?",
    )
      .bind(stale, s.installed.userId)
      .run();
    expect(await closeCodeOf(await upgrade(s.workloadId, s.owner))).toBe(
      SHELL_CLOSE_CODES.reauthRequired,
    );
    const reauth = await s.owner.request("/v1/auth/reauth", {
      method: "POST",
      json: { password: OWNER_PASSWORD, code: await nextTotpCode(OWNER_EMAIL) },
    });
    expect(reauth.status).toBe(200);
    const { term } = await openedShell(s, s.owner);
    term.ws.close();
  });

  it("lets API tokens with the scope in, outside protected environments only", async () => {
    const s = await shellStage();
    const narrow = await createToken(s.owner, s.workspaceId, ["projects:read"]);
    const scoped = await createToken(s.owner, s.workspaceId, ["shell:open"]);
    // Production starts protected.
    expect(await closeCodeOf(await upgrade(s.workloadId, scoped))).toBe(
      SHELL_CLOSE_CODES.protectedEnvironment,
    );
    await setProtected(s.owner, s.envId, false);
    expect(await closeCodeOf(await upgrade(s.workloadId, narrow))).toBe(
      SHELL_CLOSE_CODES.forbidden,
    );
    const { term } = await openedShell(s, scoped);
    term.ws.close();

    await env.DB.prepare("UPDATE users SET two_factor_enabled = 0 WHERE id = ?")
      .bind(s.installed.userId)
      .run();
    expect(await closeCodeOf(await upgrade(s.workloadId, scoped))).toBe(
      SHELL_CLOSE_CODES.twoFactorRequired,
    );
  });

  it("refuses OAuth (MCP) tokens", async () => {
    const s = await shellStage();
    expect(await closeCodeOf(await upgrade(s.workloadId, { bearer: "rho_at_notatoken" }))).toBe(
      SHELL_CLOSE_CODES.unauthorized,
    );
  });
});

// -----------------------------------------------------------------------------
// Relay
// -----------------------------------------------------------------------------

describe("shell relay", () => {
  it("relays a session end to end and records it without terminal data", async () => {
    const s = await shellStage();
    const term = await connect(
      s.workloadId,
      s.owner,
      "?cols=120&rows=40&cmd=/bin/sh&cmd=-c&cmd=echo%20argument-secret&term=xterm",
    );
    const open = await s.agent.waitFor(isExec("exec_open"));
    expect(open).toMatchObject({
      workload_id: s.workloadId,
      command: ["/bin/sh", "-c", "echo argument-secret"],
      tty: true,
      cols: 120,
      rows: 40,
      env: { TERM: "xterm" },
      idle_timeout_s: 900,
      max_duration_s: 28_800,
    });
    expect(open.exp - open.iat).toBeLessThanOrEqual(CREDENTIAL_FRAME_TTL_MS);
    expect(s.agent.rejected).toEqual([]);
    const sessionId = open.session_id;
    expect(sessionId).toMatch(/^shl_/);
    const row = await sessionRow(sessionId);
    expect(row).toMatchObject({
      command: "/bin/sh",
      workload_id: s.workloadId,
      replica: 0,
      node_id: s.nodeId,
      user_id: s.installed.userId,
      ended_at: null,
    });

    s.agent.send({ type: "exec_opened", session_id: sessionId, user: "app" });
    const opened = await term.waitFor((m) => m.type === "opened");
    expect(opened).toEqual({
      type: "opened",
      session_id: sessionId,
      node_id: s.nodeId,
      node_name: "hel-1",
      user: "app",
      replica: 0,
      idle_timeout_s: 900,
      max_duration_s: 28_800,
    });

    const keystrokes = ["typed-secret-1", "typed-secret-2", "typed-secret-3"];
    for (const k of keystrokes) {
      term.ws.send(new TextEncoder().encode(k));
      await new Promise((r) => setTimeout(r, 40));
    }
    const inputs = await eventually(async () => {
      const got = s.agent.received.filter(isExec("exec_input", sessionId)) as ExecInput[];
      return got.length >= keystrokes.length ? got : undefined;
    });
    let typed = "";
    expect(inputs.map((m) => m.seq)).toEqual(inputs.map((_, i) => i));
    for (const m of inputs) {
      expect(m.exp - m.iat).toBeLessThanOrEqual(CREDENTIAL_FRAME_TTL_MS);
      const pt = await openBox(
        NODE_ENCRYPTION_PRIVATE_KEY,
        m.data_sealed,
        "exec-input",
        execInputAad(s.nodeId, sessionId, m.seq),
      );
      const { data } = SealedExecInputSchema.parse(JSON.parse(new TextDecoder().decode(pt)));
      typed += atob(data);
      // Bound to its seq: the same box doesn't open as another one.
      await expect(
        openBox(
          NODE_ENCRYPTION_PRIVATE_KEY,
          m.data_sealed,
          "exec-input",
          execInputAad(s.nodeId, sessionId, m.seq + 1),
        ),
      ).rejects.toThrow();
    }
    expect(typed).toBe(keystrokes.join(""));
    expect(JSON.stringify(inputs)).not.toContain("typed-secret");

    term.ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    expect(await s.agent.waitFor(isExec("exec_resize", sessionId))).toMatchObject({
      cols: 100,
      rows: 30,
    });

    s.agent.send({
      type: "exec_output",
      session_id: sessionId,
      seq: 0,
      data: btoa("printed-output-secret"),
    });
    await eventually(async () => (term.output.length ? true : undefined));
    expect(new TextDecoder().decode(term.output[0])).toBe("printed-output-secret");

    s.agent.send({ type: "exec_exit", session_id: sessionId, exit_code: 3, reason: "exited" });
    expect(await term.waitFor((m) => m.type === "exit")).toEqual({
      type: "exit",
      code: 3,
      reason: "exited",
    });
    expect((await term.closed).code).toBe(SHELL_CLOSE_CODES.normal);
    const ended = await eventually(async () => {
      const r = await sessionRow(sessionId);
      return r?.ended_at ? r : undefined;
    });
    expect(ended).toMatchObject({
      end_reason: "exited",
      exit_code: 3,
      container_user: "app",
      bytes_in: keystrokes.join("").length,
      bytes_out: "printed-output-secret".length,
    });
    expect(ended.opened_at).not.toBeNull();

    const closedAudit = await auditOf("shell.closed");
    expect(closedAudit).toHaveLength(1);
    const meta = JSON.parse(closedAudit[0]!.metadata!);
    expect(meta).toMatchObject({
      workload_id: s.workloadId,
      replica: 0,
      node_id: s.nodeId,
      end_reason: "exited",
      exit_code: 3,
      container_user: "app",
    });
    expect(meta.duration_ms).toBeGreaterThanOrEqual(0);
    const everything = JSON.stringify(
      (await env.DB.prepare("SELECT * FROM audit_logs").all()).results,
    );
    for (const secret of ["typed-secret", "printed-output-secret", "argument-secret"]) {
      expect(everything).not.toContain(secret);
    }
    expect(await auditOf("shell.opened")).toHaveLength(1);
    expect(await nodeStub(s.nodeId).shellCount()).toBe(0);
  });

  it("sends exec_close when the terminal disconnects or asks to close", async () => {
    const s = await shellStage();
    const first = await openedShell(s, s.owner);
    first.term.ws.close(1000, "bye");
    expect(await s.agent.waitFor(isExec("exec_close", first.sessionId))).toMatchObject({
      reason: "user",
    });
    await eventually(async () =>
      (await sessionRow(first.sessionId))?.end_reason === "closed" ? true : undefined,
    );

    const second = await openedShell(s, s.owner);
    second.term.ws.send(JSON.stringify({ type: "close" }));
    expect(await s.agent.waitFor(isExec("exec_close", second.sessionId))).toMatchObject({
      reason: "user",
    });
    expect((await second.term.closed).code).toBe(SHELL_CLOSE_CODES.normal);

    const third = await openedShell(s, s.owner);
    third.term.ws.send(JSON.stringify({ type: "resize", cols: 0, rows: 0 }));
    expect((await third.term.closed).code).toBe(SHELL_CLOSE_CODES.policy);
  });

  it("ends shells when the agent disconnects", async () => {
    const s = await shellStage();
    const { term, sessionId } = await openedShell(s, s.owner);
    s.agent.ws.close(1000, "restart");
    expect(await term.waitFor((m) => m.type === "exit")).toMatchObject({
      reason: "node_disconnected",
    });
    expect((await term.closed).code).toBe(SHELL_CLOSE_CODES.nodeUnavailable);
    await eventually(async () =>
      (await sessionRow(sessionId))?.end_reason === "node_disconnected" ? true : undefined,
    );
    // No agent now: refused at once.
    expect(await closeCodeOf(await upgrade(s.workloadId, s.owner))).toBe(
      SHELL_CLOSE_CODES.nodeUnavailable,
    );
  });

  it("refuses agents below the exec protocol", async () => {
    const old = await shellStage({});
    expect(await closeCodeOf(await upgrade(old.workloadId, old.owner))).toBe(
      SHELL_CLOSE_CODES.agentOutdated,
    );
    expect(old.agent.received.some((m) => m.type.startsWith("exec_"))).toBe(false);
  });

  it("refuses a node's fifth session", async () => {
    const s = await shellStage();
    const terms = [];
    for (let i = 0; i < MAX_EXEC_SESSIONS_PER_NODE; i++) terms.push(await openedShell(s, s.owner));
    expect(await nodeStub(s.nodeId).shellCount()).toBe(MAX_EXEC_SESSIONS_PER_NODE);
    expect(await closeCodeOf(await upgrade(s.workloadId, s.owner))).toBe(SHELL_CLOSE_CODES.busy);
    for (const t of terms) t.term.ws.close();
  });

  it("ignores frames for unknown sessions and uses the default command", async () => {
    const s = await shellStage();
    const { term, open } = await openedShell(s, s.owner);
    expect(open.command).toEqual([...DEFAULT_EXEC_COMMAND]);
    s.agent.send({ type: "exec_output", session_id: "shl_unknown", seq: 0, data: btoa("x") });
    s.agent.send({ type: "exec_exit", session_id: "shl_unknown", exit_code: 0, reason: "exited" });
    s.agent.send({ type: "exec_output", session_id: open.session_id, seq: 0, data: btoa("ok") });
    await eventually(async () => (term.output.length ? true : undefined));
    expect(new TextDecoder().decode(term.output[0])).toBe("ok");
    term.ws.close();
  });
});

// -----------------------------------------------------------------------------
// Revocation
// -----------------------------------------------------------------------------

async function expectRevoked(s: ShellStage, term: Terminal, sessionId: string) {
  expect(await s.agent.waitFor(isExec("exec_close", sessionId))).toMatchObject({
    reason: "revoked",
  });
  expect(await term.waitFor((m) => m.type === "exit")).toMatchObject({ reason: "revoked" });
  expect((await term.closed).code).toBe(SHELL_CLOSE_CODES.forbidden);
  const row = await eventually(async () => {
    const r = await sessionRow(sessionId);
    return r?.ended_at ? r : undefined;
  });
  expect(row.end_reason).toBe("revoked");
}

describe("shell revocation", () => {
  it("closes a removed member's and a demoted admin's shells at once", async () => {
    const s = await shellStage();
    const admin = await addMember(s.owner, s.workspaceId, "a1@example.com", "admin");
    const a1 = await memberId(s.owner, s.workspaceId, "a1@example.com");
    const first = await openedShell(s, admin);
    const res = await s.owner.request(`/v1/workspaces/${s.workspaceId}/members/${a1.id}`, {
      method: "PATCH",
      json: { role: "member" },
    });
    expect(res.status).toBe(200);
    await expectRevoked(s, first.term, first.sessionId);

    const admin2 = await addMember(s.owner, s.workspaceId, "a2@example.com", "admin");
    const a2 = await memberId(s.owner, s.workspaceId, "a2@example.com");
    const second = await openedShell(s, admin2);
    const owners = await openedShell(s, s.owner);
    await s.owner.request(`/v1/workspaces/${s.workspaceId}/members/${a2.id}`, {
      method: "DELETE",
    });
    await expectRevoked(s, second.term, second.sessionId);
    // Someone else's shell stays open.
    expect(owners.term.texts.some((m) => m.type === "exit")).toBe(false);
    expect(await nodeStub(s.nodeId).shellCount()).toBe(1);
    owners.term.ws.close();
  });

  it("closes a revoked token's shell and a token's shell once its environment is protected", async () => {
    const s = await shellStage();
    await setProtected(s.owner, s.envId, false);
    const token = await createToken(s.owner, s.workspaceId, ["shell:open"]);
    const first = await openedShell(s, token);
    const revoke = await s.owner.request(`/v1/workspaces/${s.workspaceId}/tokens/${token.id}`, {
      method: "DELETE",
    });
    expect(revoke.status).toBeLessThan(300);
    await expectRevoked(s, first.term, first.sessionId);

    const token2 = await createToken(s.owner, s.workspaceId, ["shell:open"]);
    const second = await openedShell(s, token2);
    const browser = await openedShell(s, s.owner);
    await setProtected(s.owner, s.envId, true);
    await expectRevoked(s, second.term, second.sessionId);
    // A browser session may keep a shell in a protected environment.
    expect(browser.term.texts.some((m) => m.type === "exit")).toBe(false);
    browser.term.ws.close();
  });

  it("closes a shell when its browser session is revoked", async () => {
    const s = await shellStage();
    const other = await signInAs(OWNER_EMAIL, OWNER_PASSWORD);
    const { term, sessionId } = await openedShell(s, other);
    const list = await s.owner.json<{ sessions: { id: string; current: boolean }[] }>(
      "/v1/auth/sessions",
    );
    const target = list.body.sessions.find((x) => !x.current)!;
    const res = await s.owner.request(`/v1/auth/sessions/${target.id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    await expectRevoked(s, term, sessionId);
  });

  it("closes a shell when its browser signs out", async () => {
    const s = await shellStage();
    const other = await signInAs(OWNER_EMAIL, OWNER_PASSWORD);
    const { term, sessionId } = await openedShell(s, other);
    const res = await other.request("/api/auth/sign-out", { method: "POST", json: {} });
    expect(res.status).toBe(200);
    await expectRevoked(s, term, sessionId);
  });
});

// -----------------------------------------------------------------------------
// Deadlines
// -----------------------------------------------------------------------------

/** Moves an open session's deadlines into the past, as if time had passed. */
async function age(s: ShellStage, sessionId: string, fields: Record<string, number>) {
  await runInDurableObject(nodeStub(s.nodeId), async (_instance, state) => {
    for (const ws of state.getWebSockets(`shell:${sessionId}`)) {
      ws.serializeAttachment({ ...(ws.deserializeAttachment() as object), ...fields });
    }
  });
  await runDurableObjectAlarm(nodeStub(s.nodeId));
}

describe("shell deadlines", () => {
  it("re-checks access on the alarm and ends idle and unanswered sessions", async () => {
    const s = await shellStage();
    const revoked = await openedShell(s, s.owner);
    // Changed behind the API's back, so only the periodic re-check sees it.
    await env.DB.prepare("UPDATE users SET two_factor_enabled = 0 WHERE id = ?")
      .bind(s.installed.userId)
      .run();
    await age(s, revoked.sessionId, { nextRecheckAt: 0 });
    await expectRevoked(s, revoked.term, revoked.sessionId);
    await env.DB.prepare("UPDATE users SET two_factor_enabled = 1 WHERE id = ?")
      .bind(s.installed.userId)
      .run();

    const idle = await openedShell(s, s.owner);
    await age(s, idle.sessionId, { lastInputAt: 0 });
    expect(await s.agent.waitFor(isExec("exec_close", idle.sessionId))).toMatchObject({
      reason: "idle",
    });
    expect(await idle.term.waitFor((m) => m.type === "exit")).toMatchObject({
      reason: "idle_timeout",
    });
    expect((await idle.term.closed).code).toBe(SHELL_CLOSE_CODES.normal);

    const silent = await connect(s.workloadId, s.owner);
    const open = await s.agent.waitFor(
      (m): m is ExecOpen =>
        m.type === "exec_open" &&
        m.session_id !== revoked.sessionId &&
        m.session_id !== idle.sessionId,
    );
    await age(s, open.session_id, { openBy: 0 });
    expect(await silent.waitFor((m) => m.type === "exit")).toMatchObject({ reason: "timeout" });
    expect((await silent.closed).code).toBe(SHELL_CLOSE_CODES.nodeUnavailable);
    await eventually(async () =>
      (await sessionRow(open.session_id))?.end_reason === "timeout" ? true : undefined,
    );
  });
});

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

describe("shell routes", () => {
  it("lists targets with a gate preview", async () => {
    const s = await shellStage();
    const path = `/v1/services/${s.serviceId}/shell-targets?environment_id=${s.envId}`;
    const res = await s.owner.json<Record<string, unknown>>(path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      targets: [
        {
          workload_id: s.workloadId,
          deployment_id: s.deploymentId,
          replica: 0,
          node_id: s.nodeId,
          node_name: "hel-1",
          state: "healthy",
          shell_supported: true,
        },
      ],
      gate: { allowed: true, reason: null },
    });
    const viewer = await addMember(s.owner, s.workspaceId, "v@example.com", "viewer");
    expect((await viewer.json<{ gate: unknown }>(path)).body.gate).toEqual({
      allowed: false,
      reason: "forbidden",
    });
    const token = await createToken(s.owner, s.workspaceId, ["services:read", "shell:open"]);
    const viaToken = await SELF.fetch(`${ORIGIN}${path}`, {
      headers: { authorization: `Bearer ${token.bearer}` },
    });
    expect(((await viaToken.json()) as { gate: unknown }).gate).toEqual({
      allowed: false,
      reason: "protected_environment",
    });
  });

  it("lists sessions for audit readers and terminates by RBAC", async () => {
    const s = await shellStage();
    const admin = await addMember(s.owner, s.workspaceId, "a@example.com", "admin");
    const mine = await openedShell(s, s.owner);
    const theirs = await openedShell(s, admin);
    const list = await s.owner.json<{
      sessions: { id: string; command: string; ended_at: number | null }[];
      next_cursor: string | null;
    }>(`/v1/workspaces/${s.workspaceId}/shell-sessions?project_id=${s.projectId}&limit=1`);
    expect(list.status).toBe(200);
    expect(list.body.sessions.map((x) => x.id)).toEqual([theirs.sessionId]);
    expect(list.body.next_cursor).toBe(theirs.sessionId);
    const page2 = await s.owner.json<{ sessions: { id: string }[] }>(
      `/v1/workspaces/${s.workspaceId}/shell-sessions?cursor=${list.body.next_cursor}`,
    );
    expect(page2.body.sessions.map((x) => x.id)).toEqual([mine.sessionId]);
    const member = await addMember(s.owner, s.workspaceId, "m@example.com", "member");
    expect((await member.request(`/v1/workspaces/${s.workspaceId}/shell-sessions`)).status).toBe(
      403,
    );

    // A project admin who isn't a workspace admin can't end someone else's.
    const m = await memberId(s.owner, s.workspaceId, "m@example.com");
    await env.DB.prepare("UPDATE users SET two_factor_enabled = 1 WHERE id = ?")
      .bind(m.user_id)
      .run();
    await s.owner.request(`/v1/projects/${s.projectId}/access`, {
      method: "PUT",
      json: { principal: { type: "user", id: m.user_id }, role: "project_admin" },
    });
    expect(
      (await member.request(`/v1/shell-sessions/${theirs.sessionId}/terminate`, { method: "POST" }))
        .status,
    ).toBe(403);
    expect(
      (await member.request("/v1/shell-sessions/shl_missing/terminate", { method: "POST" })).status,
    ).toBe(404);

    const own = await admin.json<{ ended_at: number | null; end_reason: string }>(
      `/v1/shell-sessions/${theirs.sessionId}/terminate`,
      { method: "POST" },
    );
    expect(own.status).toBe(200);
    expect(own.body.end_reason).toBe("terminated");
    expect(own.body.ended_at).not.toBeNull();
    expect(await theirs.term.waitFor((x) => x.type === "exit")).toMatchObject({
      reason: "revoked",
    });
    expect(await s.agent.waitFor(isExec("exec_close", theirs.sessionId))).toMatchObject({
      reason: "revoked",
    });

    const byOwner = await s.owner.request(`/v1/shell-sessions/${mine.sessionId}/terminate`, {
      method: "POST",
    });
    expect(byOwner.status).toBe(200);
    expect(
      (await s.owner.request(`/v1/shell-sessions/${mine.sessionId}/terminate`, { method: "POST" }))
        .status,
    ).toBe(409);
    expect(await auditOf("shell.terminated")).toHaveLength(2);
  });

  it("is in the OpenAPI document", async () => {
    const res = await SELF.fetch(`${ORIGIN}/v1/openapi.json`);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    for (const p of [
      "/v1/workloads/{workloadId}/shell",
      "/v1/services/{serviceId}/shell-targets",
      "/v1/workspaces/{workspaceId}/shell-sessions",
      "/v1/shell-sessions/{sessionId}/terminate",
    ]) {
      expect(doc.paths[p], p).toBeDefined();
    }
  });

  it("never offers a shell over MCP", () => {
    expect(
      MCP_TOOLS.filter(
        (t) => /shell|exec|terminal/i.test(t.name) || (t.scopes as string[]).includes("shell:open"),
      ),
    ).toEqual([]);
  });
});
