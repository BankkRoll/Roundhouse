/**
 * The web shell test harness shared by `shell.test.ts` and
 * `shell-recording.test.ts`: an install with a protocol 7 fake agent and one
 * running replica, terminal sockets through the Worker, and lookups of the
 * rows, audit entries and node Durable Object a test asserts on.
 */
import { env, SELF } from "cloudflare:test";
import { type ControlMessage, EXEC_PROTOCOL_VERSION, type ExecOpen } from "@roundhouse/protocol";
import { newId } from "@roundhouse/shared";
import { afterEach } from "vitest";
import { type Client, type Installed, install, joinNode, ORIGIN } from "./helpers";
import {
  connectWorkloadAgent,
  createProject,
  createService,
  type FakeWorkloadAgent,
} from "./pipeline-helpers";

/** Sockets and agents a test opened, closed after it. */
export const cleanups: (() => void)[] = [];
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

export interface ShellStage {
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
export async function shellStage(
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

export type Auth = Client | { bearer: string };

export function upgrade(
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
export async function closeCodeOf(res: Response): Promise<number> {
  const ws = res.webSocket;
  if (res.status !== 101 || !ws) throw new Error(`expected an upgrade, got ${res.status}`);
  const closed = new Promise<number>((resolve) => {
    ws.addEventListener("close", (e) => resolve(e.code));
  });
  ws.accept();
  return closed;
}

export interface Terminal {
  ws: WebSocket;
  texts: Record<string, unknown>[];
  output: Uint8Array[];
  closed: Promise<{ code: number; reason: string }>;
  waitFor(predicate: (m: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
}

export async function connect(workloadId: string, auth: Auth, query = ""): Promise<Terminal> {
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

export const isExec =
  <T extends ControlMessage["type"]>(type: T, sessionId?: string) =>
  (m: ControlMessage): m is Extract<ControlMessage, { type: T }> =>
    m.type === type &&
    (sessionId === undefined || (m as { session_id?: string }).session_id === sessionId);

/** Opens a terminal, plays the agent's `exec_opened`, and waits for `opened`. */
export async function openedShell(s: ShellStage, auth: Auth, query = "") {
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

export async function createToken(owner: Client, workspaceId: string, scopes: string[]) {
  const res = await owner.json<{ token: { id: string }; secret: string }>(
    `/v1/workspaces/${workspaceId}/tokens`,
    { method: "POST", json: { name: "cli", scopes, expires_in_days: 30 } },
  );
  if (res.status !== 201) throw new Error(`token: ${res.status} ${JSON.stringify(res.body)}`);
  return { id: res.body.token.id, bearer: res.body.secret };
}

export async function setProtected(owner: Client, envId: string, value: boolean) {
  const res = await owner.request(`/v1/environments/${envId}/protection`, {
    method: "PUT",
    json: { protected: value },
  });
  if (res.status !== 200) throw new Error(`protection: ${res.status} ${await res.text()}`);
}

export async function sessionRow(id: string) {
  return env.DB.prepare("SELECT * FROM shell_sessions WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
}

export async function auditOf(action: string) {
  const rows = await env.DB.prepare(
    "SELECT action, target_id, metadata FROM audit_logs WHERE action = ? ORDER BY seq",
  )
    .bind(action)
    .all<{ action: string; target_id: string; metadata: string | null }>();
  return rows.results;
}

export function nodeStub(nodeId: string) {
  return env.NODE_CONNECTION.get(env.NODE_CONNECTION.idFromName(nodeId));
}

export async function memberId(owner: Client, workspaceId: string, email: string) {
  const { body } = await owner.json<{ members: { id: string; user_id: string; email: string }[] }>(
    `/v1/workspaces/${workspaceId}/members`,
  );
  const m = body.members.find((x) => x.email === email);
  if (!m) throw new Error(`no member ${email}`);
  return m;
}
