#!/usr/bin/env node
/**
 * End-to-end smoke test: real control plane (`wrangler dev`) + real Go agent.
 *
 * 1. Applies D1 migrations locally and starts `wrangler dev` with a throwaway MASTER_KEY.
 * 2. Runs first-time setup and creates a join token through the public API.
 * 3. Builds the agent, joins it, and runs it.
 * 4. Asserts the node reports online with live usage, then kills the agent and
 *    asserts the control plane marks it offline within the target window.
 *
 * Usage: `node e2e/agent-smoke.mjs` from the repo root (needs pnpm deps + Go).
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const API_DIR = join(ROOT, "apps", "api");
const PORT = Number(process.env.SMOKE_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const OFFLINE_BUDGET_MS = 45_000;
const isWindows = process.platform === "win32";

const work = mkdtempSync(join(tmpdir(), "roundhouse-smoke-"));
const children = [];
let failed = false;

function log(msg) {
  console.log(`[smoke] ${msg}`);
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: isWindows, ...opts });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}`);
}

function start(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { shell: isWindows, ...opts });
  children.push(child);
  return child;
}

async function waitFor(what, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // Not ready yet.
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

let cookie = "";
async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      origin: BASE,
      ...(cookie ? { cookie } : {}),
      ...init.headers,
    },
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

function killAll() {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (isWindows) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    else child.kill("SIGTERM");
  }
}

try {
  const persist = join(work, "state");
  const masterKey = randomBytes(32).toString("base64");
  writeFileSync(join(API_DIR, ".dev.vars.smoke"), `MASTER_KEY=${masterKey}\n`);

  log("applying migrations");
  run("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", persist], {
    cwd: API_DIR,
  });

  log(`starting wrangler dev on ${BASE}`);
  const wrangler = start(
    "npx",
    [
      "wrangler",
      "dev",
      "--port",
      String(PORT),
      "--ip",
      "127.0.0.1",
      "--persist-to",
      persist,
      "--env-file",
      ".dev.vars.smoke",
    ],
    { cwd: API_DIR },
  );
  wrangler.stderr.on("data", (d) => process.stderr.write(d));
  await waitFor("control plane", () => api("/v1/setup"), 90_000);

  log("running setup");
  const setup = await api("/v1/setup", {
    method: "POST",
    body: JSON.stringify({
      master_key: masterKey,
      name: "Smoke Test",
      email: "smoke@example.com",
      password: "smoke test password",
      workspace_name: "Smoke",
    }),
  });
  const ws = setup.workspace_id;
  const { token } = await api(`/v1/workspaces/${ws}/nodes/join-tokens`, { method: "POST" });

  log("building agent");
  const agentBin = join(work, isWindows ? "roundhouse-agent.exe" : "roundhouse-agent");
  run("go", ["build", "-o", agentBin, "./agent/cmd/roundhouse-agent"], { cwd: ROOT });

  const config = join(work, "agent", "agent.yaml");
  log("joining");
  run(agentBin, [
    "join",
    "--url",
    BASE,
    "--token",
    token,
    "--name",
    "smoke-node",
    "--config",
    config,
  ]);

  log("running agent");
  const agent = start(agentBin, ["run", "--config", config]);
  agent.stderr.on("data", (d) => process.stderr.write(d));

  const online = await waitFor(
    "node online with usage",
    async () => {
      const { nodes } = await api(`/v1/workspaces/${ws}/nodes`);
      const n = nodes[0];
      return n?.status === "online" && n.cpu_percent !== null && n.mem_used > 0 ? n : null;
    },
    30_000,
  );
  log(`node ${online.id} online: cpu=${online.cpu_percent.toFixed(1)}% mem=${online.mem_used}`);

  log("stopping agent; waiting for offline detection");
  const stoppedAt = Date.now();
  if (isWindows) spawnSync("taskkill", ["/pid", String(agent.pid), "/T", "/F"]);
  else agent.kill("SIGKILL");
  await waitFor(
    "node offline",
    async () => (await api(`/v1/workspaces/${ws}/nodes`)).nodes[0]?.status === "offline",
    OFFLINE_BUDGET_MS,
  );
  log(`offline detected after ${((Date.now() - stoppedAt) / 1000).toFixed(1)}s`);
  log("PASS");
} catch (err) {
  failed = true;
  console.error(`[smoke] FAIL: ${err.message}`);
} finally {
  killAll();
  rmSync(join(API_DIR, ".dev.vars.smoke"), { force: true });
  // NOTE: workerd can hold the SQLite file briefly after being killed on Windows.
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  process.exit(failed ? 1 : 0);
}
