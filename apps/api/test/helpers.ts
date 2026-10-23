import { env, SELF } from "cloudflare:test";
import type { JoinResponse } from "@roundhouse/protocol";

/** Base URL for requests through the Worker under test. */
export const ORIGIN = "https://cp.test";

/** A signed-in browser: carries its session cookie across requests. */
export interface Client {
  cookie: string;
  request(path: string, init?: RequestInit & { json?: unknown }): Promise<Response>;
  json<T = unknown>(
    path: string,
    init?: RequestInit & { json?: unknown },
  ): Promise<{ status: number; body: T }>;
}

function cookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

/**
 * Sends a request through the Worker.
 *
 * @param path - Path relative to {@link ORIGIN}.
 * @param init - Fetch options; objects in `body` are JSON-encoded.
 * @param cookie - Session cookie to attach.
 */
export function call(path: string, init: RequestInit & { json?: unknown } = {}, cookie = "") {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (!headers.has("origin")) headers.set("origin", ORIGIN);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  return SELF.fetch(`${ORIGIN}${path}`, { ...init, headers, body });
}

/**
 * Wraps a session cookie in a convenience client.
 *
 * @param cookie - Session cookie.
 */
export function client(cookie: string): Client {
  return {
    cookie,
    request: (path, init) => call(path, init, cookie),
    async json<T>(path: string, init?: RequestInit & { json?: unknown }) {
      const res = await call(path, init, cookie);
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
    },
  };
}

/** Result of running first-time setup. */
export interface Installed {
  owner: Client;
  userId: string;
  workspaceId: string;
}

/**
 * Runs the setup wizard. Storage is isolated per test, so every test that
 * needs an installed control plane calls this.
 */
export async function install(
  overrides: Partial<{ email: string; password: string }> = {},
): Promise<Installed> {
  const res = await call("/v1/setup", {
    method: "POST",
    json: {
      name: "Mara Okafor",
      email: overrides.email ?? "mara@example.com",
      password: overrides.password ?? "correct horse battery",
      master_key: env.MASTER_KEY,
      workspace_name: "Nightjar Labs",
    },
  });
  if (res.status !== 201) throw new Error(`setup failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { user_id: string; workspace_id: string };
  return { owner: client(cookieFrom(res)), userId: body.user_id, workspaceId: body.workspace_id };
}

/**
 * Invites `email` with `role` and accepts as a brand-new user.
 *
 * @returns A client signed in as the new member.
 */
export async function addMember(
  owner: Client,
  workspaceId: string,
  email: string,
  role: "admin" | "member" | "viewer",
): Promise<Client> {
  const { body } = await owner.json<{ url: string }>(`/v1/workspaces/${workspaceId}/invites`, {
    method: "POST",
    json: { email, role },
  });
  const token = body.url.split("/invite/")[1]!;
  const res = await call(`/v1/invites/${token}/accept`, {
    method: "POST",
    json: { name: email.split("@")[0], password: "a perfectly fine password" },
  });
  if (res.status !== 200) throw new Error(`accept failed: ${res.status} ${await res.text()}`);
  return client(cookieFrom(res));
}

/** A join request body with sensible defaults. */
export function joinBody(token: string, overrides: Record<string, unknown> = {}) {
  return {
    token,
    name: "hel-1",
    hostname: "hel-1",
    agent_version: "0.1.0",
    os: "ubuntu 24.04",
    arch: "amd64",
    public_key: "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=",
    public_ip: "203.0.113.10",
    hardware: { cpu_cores: 8, mem_bytes: 16 * 2 ** 30, disk_bytes: 160 * 2 ** 30 },
    capabilities: { docker: true, gvisor: false, builder: true },
    ...overrides,
  };
}

/**
 * Creates a join token and joins a node with it.
 *
 * @returns The join response (node ID, credential, control key).
 */
export async function joinNode(
  owner: Client,
  workspaceId: string,
  overrides: Record<string, unknown> = {},
): Promise<JoinResponse> {
  const { body } = await owner.json<{ token: string }>(
    `/v1/workspaces/${workspaceId}/nodes/join-tokens`,
    { method: "POST" },
  );
  const res = await call("/v1/nodes/join", {
    method: "POST",
    json: joinBody(body.token, overrides),
  });
  if (res.status !== 201) throw new Error(`join failed: ${res.status} ${await res.text()}`);
  return res.json();
}

/** A connected fake agent. */
export interface FakeAgent {
  ws: WebSocket;
  /** Resolves with the next frame the control plane sends. */
  next(): Promise<string>;
  closed: Promise<{ code: number; reason: string }>;
  send(frame: unknown): void;
}

/**
 * Opens an agent WebSocket the way the Go agent does.
 *
 * @param joined - Join response for the node.
 * @param credential - Override the bearer credential (for negative tests).
 */
export async function connectAgent(
  joined: JoinResponse,
  credential = joined.credential,
): Promise<FakeAgent> {
  const res = await SELF.fetch(`${ORIGIN}/v1/nodes/${joined.node_id}/connect`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${credential}` },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error(`connect failed: ${res.status} ${await res.text()}`);
  ws.accept();

  const queue: string[] = [];
  const waiters: ((v: string) => void)[] = [];
  ws.addEventListener("message", (e) => {
    const data = e.data as string;
    const waiter = waiters.shift();
    if (waiter) waiter(data);
    else queue.push(data);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason }));
  });
  return {
    ws,
    closed,
    next: () => {
      const queued = queue.shift();
      return queued !== undefined
        ? Promise.resolve(queued)
        : new Promise<string>((resolve) => waiters.push(resolve));
    },
    send: (frame) => ws.send(typeof frame === "string" ? frame : JSON.stringify(frame)),
  };
}

/** A valid `hello` frame for `nodeId`. */
export function hello(nodeId: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "hello",
    protocol_version: 1,
    node_id: nodeId,
    agent_version: "0.1.0",
    os: "ubuntu 24.04",
    arch: "amd64",
    kernel: "6.8.0",
    docker_version: "27.3.1",
    hardware: { cpu_cores: 8, mem_bytes: 16 * 2 ** 30, disk_bytes: 160 * 2 ** 30 },
    capabilities: { docker: true, gvisor: false, builder: true },
    observed_generation: 0,
    ...overrides,
  };
}

/** A valid `heartbeat` frame. */
export function heartbeat(seq = 1, cpu = 38) {
  return {
    type: "heartbeat",
    seq,
    ts: Date.now(),
    observed_generation: 0,
    usage: {
      cpu_percent: cpu,
      mem_used_bytes: 11 * 2 ** 30,
      mem_total_bytes: 16 * 2 ** 30,
      disk_used_bytes: 70 * 2 ** 30,
      disk_total_bytes: 160 * 2 ** 30,
      load1: 1.5,
    },
  };
}

/**
 * Polls until `check` passes or the deadline expires. Needed because the DO
 * processes frames asynchronously relative to the test.
 */
export async function eventually<T>(
  check: () => Promise<T | undefined>,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Wraps the Worker's D1 binding so `hook` runs just before the first statement
 * whose SQL matches `pattern` executes, alone or inside a batch. Lets a test
 * play a concurrent writer at an exact point in a handler, or make a write
 * fail by throwing from `hook`.
 *
 * NOTE: Durable Objects get their own `env`, so this only reaches Worker
 * handlers; use {@link interceptD1} to wrap a Durable Object's client.
 *
 * @param pattern - Matched against the SQL Drizzle generates, e.g. `/^insert into "audit_logs"/`.
 * @param hook - Runs once, receiving the real (unwrapped) binding.
 * @returns Restores the real binding; call it in `finally`.
 */
export function beforeStatement(
  pattern: RegExp,
  hook: (db: D1Database) => Promise<unknown> | unknown,
): () => void {
  const real = env.DB;
  (env as { DB: D1Database }).DB = interceptD1(real, pattern, hook);
  return () => {
    (env as { DB: D1Database }).DB = real;
  };
}

/**
 * Returns a D1 binding that behaves like `real` but runs `hook` once, just
 * before the first statement matching `pattern` executes.
 *
 * @param real - Binding to wrap.
 * @param pattern - Matched against the SQL Drizzle generates.
 * @param hook - Runs once, receiving `real`.
 * @returns The wrapped binding.
 */
export function interceptD1(
  real: D1Database,
  pattern: RegExp,
  hook: (db: D1Database) => Promise<unknown> | unknown,
): D1Database {
  const unwrap = new WeakMap<object, D1PreparedStatement>();
  let fired = false;
  const fire = async () => {
    if (fired) return;
    fired = true;
    await hook(real);
  };
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        if (prop === "bind") return (...args: unknown[]) => wrap(value.apply(target, args));
        if (prop === "all" || prop === "raw" || prop === "run" || prop === "first") {
          return async (...args: unknown[]) => {
            await fire();
            return value.apply(target, args);
          };
        }
        return value.bind(target);
      },
    });
    unwrap.set(proxy, stmt);
    return proxy;
  };
  return new Proxy(real, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (prop === "prepare") {
        return (query: string) => {
          const stmt = value.call(target, query) as D1PreparedStatement;
          return pattern.test(query) ? wrap(stmt) : stmt;
        };
      }
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          const raw = stmts.map((s) => unwrap.get(s) ?? s);
          if (raw.some((s, i) => s !== stmts[i])) await fire();
          return value.call(target, raw);
        };
      }
      return value.bind(target);
    },
  });
}

/**
 * Makes the first statement matching `pattern` fail, as if D1 had errored.
 *
 * @param pattern - Matched against the SQL Drizzle generates.
 * @returns Restores the real binding; call it in `finally`.
 */
export function failStatement(pattern: RegExp): () => void {
  return beforeStatement(pattern, () => {
    throw new Error("injected D1 failure");
  });
}
