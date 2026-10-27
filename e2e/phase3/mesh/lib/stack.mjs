/**
 * The multi-node real stack for the mesh suite: `wrangler dev` with fresh
 * state and two Roundhouse nodes, each a Docker-in-Docker container with its
 * own engine, Caddy and agent on one user-defined network, so WireGuard,
 * nftables and Docker's own rules behave as on two hosts.
 *
 * Names, the port and the env file differ from the Phase 1 suite's, so both
 * can run on one machine.
 *
 * @module
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isWindows, log, ROOT, run, waitFor } from "../../../phase1/lib/util.mjs";

const PHASE3 = join(ROOT, "e2e", "phase3", "mesh");
const API_DIR = join(ROOT, "apps", "api");

/** Where this suite writes logs and evidence. */
export const ARTIFACTS = resolve(PHASE3, ".artifacts");

/** Container, network and image names. */
export const NAMES = {
  network: "roundhouse-e2e3-net",
  nodeImage: "roundhouse-e2e3-node:local",
  nodes: ["roundhouse-e2e3-n1", "roundhouse-e2e3-n2"],
};

/** Image every test service runs, preloaded into both nodes' engines. */
export const BUSYBOX =
  "busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e";

/** The agent's config and data inside a node. */
export const NODE_CONFIG = "/etc/roundhouse/agent.yaml";
export const NODE_DATA = "/var/lib/roundhouse";

/**
 * Runs `docker`.
 *
 * @param {string[]} args - Arguments.
 * @param {Parameters<typeof run>[2]} [opts]
 */
export function docker(args, opts) {
  return run("docker", args, opts);
}

/**
 * Runs a shell command inside a node container.
 *
 * @param {string} node - Node container name.
 * @param {string} script - `sh -c` script.
 * @param {{ allowFail?: boolean, timeoutMs?: number }} [opts]
 */
export function inNode(node, script, opts = {}) {
  return docker(["exec", node, "sh", "-c", script], { timeoutMs: 120_000, ...opts });
}

/**
 * Writes a file under {@link ARTIFACTS}.
 *
 * @param {string} name - File name.
 * @param {string | object} content - Text, or a value written as JSON.
 * @returns {string} Its path.
 */
export function writeArtifact(name, content) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const path = join(ARTIFACTS, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return path;
}

/** Builds the agent for the engine's Linux architecture and the node image. */
export async function buildImages() {
  const { stdout } = await docker(["version", "--format", "{{.Server.Arch}}"]);
  const arch = stdout.trim();
  const ctx = mkdtempSync(join(tmpdir(), "roundhouse-e2e3-node-"));
  try {
    log("stack", `building the agent for linux/${arch}`);
    await run(
      "go",
      [
        "build",
        "-trimpath",
        "-ldflags",
        "-X main.version=0.0.0-e2e",
        "-o",
        join(ctx, "roundhouse-agent"),
        "./cmd/roundhouse-agent",
      ],
      {
        cwd: join(ROOT, "agent"),
        env: { ...process.env, GOOS: "linux", GOARCH: arch, CGO_ENABLED: "0" },
      },
    );
    cpSync(join(PHASE3, "fixtures", "node"), ctx, { recursive: true });
    log("stack", `building ${NAMES.nodeImage}`);
    await docker(["build", "-q", "-t", NAMES.nodeImage, ctx], { timeoutMs: 600_000 });
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
  const present = await docker(["image", "inspect", BUSYBOX], { allowFail: true });
  if (present.code !== 0) await docker(["pull", "-q", BUSYBOX]);
}

/**
 * The control plane under `wrangler dev`.
 *
 * @typedef {object} ControlPlane
 * @property {string} base - URL the harness uses.
 * @property {string} nodeUrl - URL the node containers use.
 * @property {string} masterKey - The install's MASTER_KEY.
 * @property {string} state - The `--persist-to` directory, for `d1 execute`.
 * @property {string} logFile - Where wrangler's output goes.
 * @property {() => void} stop - Kills wrangler and removes its state.
 */

/**
 * Applies migrations to fresh local state and starts `wrangler dev`.
 *
 * @param {{ port: number }} opts
 * @returns {Promise<ControlPlane>}
 */
export async function startControlPlane({ port }) {
  const taken = await fetch(`http://127.0.0.1:${port}/`).then(
    () => true,
    () => false,
  );
  if (taken) throw new Error(`port ${port} is already in use; set PHASE3_PORT`);
  const state = mkdtempSync(join(tmpdir(), "roundhouse-e2e3-state-"));
  const masterKey = randomBytes(32).toString("base64");
  const varsName = ".dev.vars.phase3";
  const varsFile = join(API_DIR, varsName);
  writeFileSync(varsFile, `MASTER_KEY=${masterKey}\nROLLOUT_TIMEOUT_S=90\nROUNDHOUSE_DEV=1\n`);
  mkdirSync(ARTIFACTS, { recursive: true });
  const logFile = join(ARTIFACTS, "wrangler.log");
  const out = createWriteStream(logFile);
  log("stack", "applying D1 migrations to fresh local state");
  await run(
    "npx",
    ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", state],
    { cwd: API_DIR, shell: isWindows },
  );
  const base = `http://127.0.0.1:${port}`;
  log("stack", `starting wrangler dev on ${base}`);
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--port",
      String(port),
      // Nodes reach it from Docker's VM through the host gateway.
      "--ip",
      "0.0.0.0",
      "--persist-to",
      state,
      "--env-file",
      varsName,
      "--show-interactive-dev-session=false",
    ],
    { cwd: API_DIR, shell: isWindows, detached: !isWindows, windowsHide: true },
  );
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  const stop = () => {
    if (isWindows)
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    rmSync(varsFile, { force: true });
    try {
      rmSync(state, { recursive: true, force: true, maxRetries: 60, retryDelay: 500 });
    } catch (err) {
      log("teardown", `could not remove ${state}: ${err.message}`);
    }
  };
  try {
    await waitFor(
      "the control plane to answer",
      async () => {
        if (child.exitCode !== null) throw new Error(`wrangler exited ${child.exitCode}`);
        return (await fetch(`${base}/v1/setup`)).ok;
      },
      { timeoutMs: 120_000 },
    );
  } catch (err) {
    stop();
    throw err;
  }
  return {
    base,
    nodeUrl: `http://host.docker.internal:${port}`,
    masterKey,
    state,
    logFile,
    stop,
  };
}

/**
 * Runs SQL against the control plane's local D1, for test-only setup the
 * API has no route for (node labels).
 *
 * @param {string} state - `--persist-to` directory.
 * @param {string} sql - Statement.
 * @returns {Promise<any[]>} Result rows.
 */
export async function d1(state, sql) {
  // NOTE: npx needs a shell on Windows, which would split an inline
  // statement; a file keeps it whole.
  const file = join(state, `query-${randomBytes(4).toString("hex")}.sql`);
  writeFileSync(file, sql);
  const { stdout } = await run(
    "npx",
    ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", state, "--json", "--file", file],
    { cwd: API_DIR, shell: isWindows, timeoutMs: 120_000 },
  );
  rmSync(file, { force: true });
  const parsed = JSON.parse(stdout.slice(stdout.indexOf("[")));
  return parsed[0]?.results ?? [];
}

/**
 * Starts both node containers (engine and Caddy up, no agent yet) and
 * preloads the test image into their engines.
 *
 * @returns {Promise<Record<string, string>>} Each node's IP on the test network.
 */
export async function startNodes() {
  await docker(["network", "create", NAMES.network]);
  const ips = {};
  for (const name of NAMES.nodes) {
    await docker([
      "run",
      "-d",
      "--name",
      name,
      "--hostname",
      name,
      "--privileged",
      "--network",
      NAMES.network,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-e",
      "DOCKER_TLS_CERTDIR=",
      NAMES.nodeImage,
      "idle",
    ]);
  }
  for (const name of NAMES.nodes) {
    await waitFor(
      `${name}'s engine`,
      async () => (await inNode(name, "docker info >/dev/null", { allowFail: true })).code === 0,
      { timeoutMs: 120_000 },
    );
    log("stack", `preloading ${BUSYBOX} into ${name}`);
    const save = spawn("docker", ["save", BUSYBOX], { stdio: ["ignore", "pipe", "inherit"] });
    const load = spawn("docker", ["exec", "-i", name, "docker", "load", "-q"], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    save.stdout.pipe(load.stdin);
    await new Promise((r, j) =>
      load.on("exit", (c) => (c === 0 ? r() : j(new Error("docker load failed")))),
    );
    const { stdout } = await docker([
      "inspect",
      "-f",
      `{{(index .NetworkSettings.Networks "${NAMES.network}").IPAddress}}`,
      name,
    ]);
    ips[name] = stdout.trim();
  }
  return ips;
}

/**
 * Joins a node with the real join flow and gives its agent the mesh
 * endpoint its peers reach it at (the nodes are not on public addresses).
 *
 * @param {{ node: string, url: string, token: string, ip: string, builder?: boolean }} opts
 */
export async function joinNode({ node, url, token, ip, builder = false }) {
  const res = await docker([
    "exec",
    "-e",
    `ROUNDHOUSE_JOIN_TOKEN=${token}`,
    node,
    "roundhouse-agent",
    "join",
    "--url",
    url,
    "--name",
    node.replace("roundhouse-e2e3-", ""),
    "--config",
    NODE_CONFIG,
    "--data-dir",
    NODE_DATA,
    "--insecure",
    ...(builder ? ["--builder"] : []),
  ]);
  await inNode(node, `printf 'mesh:\\n  endpoint: "${ip}:51820"\\n' >> ${NODE_CONFIG}`);
  return res.stderr + res.stdout;
}

/**
 * Starts the agent in a node, in the background, logging to a file.
 *
 * @param {string} node - Node container name.
 */
export async function startAgent(node) {
  await docker([
    "exec",
    "-d",
    "-e",
    "ROUNDHOUSE_DEV=1",
    node,
    "sh",
    "-c",
    `exec roundhouse-agent run --config ${NODE_CONFIG} >>/var/log/agent.log 2>&1`,
  ]);
}

/**
 * Container IDs inside a node's engine matching a label.
 *
 * @param {string} node - Node container name.
 * @param {string} label - `key=value`.
 * @returns {Promise<string[]>}
 */
export async function nodeContainers(node, label) {
  const { stdout } = await inNode(node, `docker ps -q --filter label=${label}`);
  return stdout.split("\n").filter(Boolean);
}

/** Saves every node's agent, Caddy and engine logs and its nft table. */
export async function dumpDiagnostics() {
  for (const node of NAMES.nodes) {
    for (const [file, cmd] of [
      [`${node}-agent.log`, "cat /var/log/agent.log"],
      [`${node}-caddy.log`, "tail -n 400 /var/log/caddy.log"],
      [`${node}-nft.txt`, "nft list ruleset"],
      [`${node}-wg.txt`, "ip -d link show wg0; ip addr; ip route"],
      [`${node}-ps.txt`, "docker ps -a"],
    ]) {
      const r = await inNode(node, cmd, { allowFail: true });
      writeArtifact(file, r.stdout + r.stderr);
    }
  }
}

/** Removes both nodes and the network; leaves nothing else touched. */
export async function teardown() {
  for (const node of NAMES.nodes) await docker(["rm", "-f", "-v", node], { allowFail: true });
  await docker(["network", "rm", NAMES.network], { allowFail: true });
}
