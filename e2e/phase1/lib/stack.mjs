/**
 * The real stack the Phase 1 suite runs against, and its teardown:
 *
 * - the control plane under `wrangler dev`, with fresh local state;
 * - Caddy, run by itself on the engine's host network as on a real node;
 * - an HTTPS git server and an HTTP prober (both `roundhouse-e2e-tools`);
 * - the node: the agent binary cross-compiled for Linux in a container on
 *   the host network with the engine's socket, joined as a builder.
 *
 * On Docker Desktop "host network" is the Docker VM's, so Caddy, the
 * registry and container IPs are reached from containers on that network
 * (the prober), never from the Windows/macOS host. On Linux the same
 * commands use the real host network.
 *
 * Everything is named `roundhouse-e2e-*` (plus what the agent itself creates:
 * `sys_registry`, the `sys_buildkitd-<project>` daemons and their volumes,
 * `roundhouse-build` and
 * the environment networks), so a teardown can find it after a crash.
 *
 * @module
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACTS, isWindows, log, ROOT, run, runInherit, waitFor } from "./util.mjs";

const PHASE1 = join(ROOT, "e2e", "phase1");
const API_DIR = join(ROOT, "apps", "api");

/** Container, volume and image names. */
export const NAMES = {
  agent: "roundhouse-e2e-agent",
  caddy: "roundhouse-e2e-caddy",
  git: "roundhouse-e2e-git",
  probe: "roundhouse-e2e-probe",
  nodeImage: "roundhouse-e2e-node:local",
  toolsImage: "roundhouse-e2e-tools:local",
  certs: "roundhouse-e2e-certs",
  caddyData: "roundhouse-e2e-caddy-data",
};

/** Agent data directory, on the engine host: the registry bind-mounts paths under it. */
export const DATA_DIR = "/var/lib/roundhouse-e2e";

/** Pinned images the suite uses. */
export const IMAGES = {
  caddy:
    "caddy:2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f",
  whoami:
    "traefik/whoami:v1.11.0@sha256:200689790a0a0ea48ca45992e0450bc26ccab5307375b41c84dfc4f2475937ab",
};

/** Port of the test git server on the engine host's loopback. */
export const GIT_PORT = Number(process.env.PHASE1_GIT_PORT ?? 18443);

/** Rollout timeout the control plane runs with; long enough for a cold start, short for a failing probe. */
export const ROLLOUT_TIMEOUT_S = Number(process.env.PHASE1_ROLLOUT_TIMEOUT_S ?? 60);

const DOCKER_SOCKET = "/var/run/docker.sock";

/**
 * Runs `docker` with the given arguments.
 *
 * @param {string[]} args - Arguments.
 * @param {Parameters<typeof run>[2]} [opts]
 * @returns {ReturnType<typeof run>}
 */
export function docker(args, opts) {
  return run("docker", args, opts);
}

/**
 * Runs the prober in the engine's host network and parses its JSON output.
 *
 * @param {string[]} args - `probe.mjs` arguments.
 * @returns {Promise<any>}
 */
export async function probe(args) {
  const { stdout } = await docker(["exec", NAMES.probe, "node", "/opt/e2e/probe.mjs", ...args], {
    timeoutMs: 60_000,
  });
  return JSON.parse(stdout.trim().split("\n").pop());
}

/**
 * Starts a request loop against a hostname through Caddy. Stop it with the
 * returned function, which resolves to the loop's summary.
 *
 * @param {string} host - Hostname to request.
 * @param {{ path?: string, https?: boolean }} [opts]
 * @returns {Promise<() => Promise<{ total: number, failed: number, statuses: Record<string, number>,
 *   bodies: Record<string, number>, failures: object[], max_ms: number }>>}
 */
export async function startLoop(host, opts = {}) {
  const args = ["exec", "-i", NAMES.probe, "node", "/opt/e2e/probe.mjs", "loop", host];
  args.push(opts.path ?? "/");
  if (opts.https) args.push("--https");
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  let out = "";
  const lines = [];
  child.stdout.on("data", (d) => {
    out += d;
    let i = out.indexOf("\n");
    while (i !== -1) {
      lines.push(out.slice(0, i));
      out = out.slice(i + 1);
      i = out.indexOf("\n");
    }
  });
  const exited = new Promise((r) => child.on("exit", r));
  await waitFor("request loop to start", () => lines.includes("ready"), { timeoutMs: 30_000 });
  return async () => {
    child.stdin.end("stop\n");
    await exited;
    return JSON.parse(lines[lines.length - 1]);
  };
}

/**
 * Engine architecture (`amd64` / `arm64`), for cross-compiling the agent.
 *
 * @returns {Promise<string>}
 */
async function engineArch() {
  const { stdout } = await docker(["version", "--format", "{{.Server.Arch}}"]);
  return stdout.trim();
}

/**
 * Builds the agent for the engine's Linux architecture and both images.
 *
 * @returns {Promise<void>}
 */
export async function buildImages() {
  const arch = await engineArch();
  const ctx = mkdtempSync(join(tmpdir(), "roundhouse-e2e-node-"));
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
    cpSync(join(PHASE1, "fixtures", "node"), ctx, { recursive: true });
    log("stack", `building ${NAMES.nodeImage}`);
    await docker(["build", "-q", "-t", NAMES.nodeImage, ctx]);
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
  log("stack", `building ${NAMES.toolsImage}`);
  const fixtures = join(PHASE1, "fixtures");
  await docker([
    "build",
    "-q",
    "-t",
    NAMES.toolsImage,
    "-f",
    join(fixtures, "tools", "Dockerfile"),
    fixtures,
  ]);
  for (const image of Object.values(IMAGES)) {
    const present = await docker(["image", "inspect", image], { allowFail: true });
    if (present.code !== 0) {
      log("stack", `pulling ${image}`);
      await docker(["pull", "-q", image]);
    }
  }
}

/**
 * The control plane under `wrangler dev`.
 *
 * @typedef {object} ControlPlane
 * @property {string} base - URL the harness and browser use.
 * @property {string} nodeUrl - URL the node container uses.
 * @property {boolean} insecure - Whether the node must pass `--insecure`.
 * @property {string} masterKey - The install's MASTER_KEY.
 * @property {string} logFile - Where wrangler's output goes.
 * @property {ControlPlaneHandle} handle - What {@link stopControlPlane} needs.
 * @property {() => void} stop - Kills wrangler and removes its state.
 */

/**
 * Identifies a running `wrangler dev`, so a later process can stop it.
 *
 * @typedef {object} ControlPlaneHandle
 * @property {number} pid - The spawned process (a shell on Windows).
 * @property {string} state - Its `--persist-to` directory.
 * @property {string} varsFile - Its `--env-file`.
 */

/**
 * Kills a `wrangler dev` process tree and removes its state.
 *
 * @param {ControlPlaneHandle} handle - From {@link startControlPlane}.
 */
export function stopControlPlane({ pid, state, varsFile }) {
  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  rmSync(varsFile, { force: true });
  try {
    // NOTE: workerd can hold its files briefly after being killed on Windows.
    rmSync(state, { recursive: true, force: true, maxRetries: 60, retryDelay: 500 });
  } catch (err) {
    log("teardown", `could not remove ${state}: ${err.message}`);
  }
}

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
  if (taken) {
    throw new Error(`port ${port} is already in use (a leftover wrangler?); set PHASE1_PORT`);
  }
  const state = mkdtempSync(join(tmpdir(), "roundhouse-e2e-state-"));
  const masterKey = randomBytes(32).toString("base64");
  const varsFile = join(API_DIR, ".dev.vars.phase1");
  writeFileSync(varsFile, `MASTER_KEY=${masterKey}\nROLLOUT_TIMEOUT_S=${ROLLOUT_TIMEOUT_S}\n`);
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
  log("stack", `starting wrangler dev on ${base} (rollout timeout ${ROLLOUT_TIMEOUT_S}s)`);
  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
      "--persist-to",
      state,
      "--env-file",
      ".dev.vars.phase1",
      "--show-interactive-dev-session=false",
    ],
    { cwd: API_DIR, shell: isWindows, detached: !isWindows, windowsHide: true },
  );
  child.stdout.pipe(out);
  child.stderr.pipe(out);

  const handle = { pid: child.pid, state, varsFile };
  const stop = () => stopControlPlane(handle);

  try {
    await waitFor(
      "the control plane to answer",
      async () => {
        if (child.exitCode !== null) throw new Error(`wrangler exited ${child.exitCode}`);
        const res = await fetch(`${base}/v1/setup`);
        return res.ok;
      },
      { timeoutMs: 120_000 },
    );
  } catch (err) {
    stop();
    throw err;
  }

  // On Linux the node shares the host's loopback; Docker Desktop's VM reaches
  // the host through host.docker.internal, which is not loopback.
  const linux = process.platform === "linux";
  return {
    base,
    nodeUrl: linux ? base : `http://host.docker.internal:${port}`,
    insecure: !linux,
    masterKey,
    logFile,
    handle,
    stop,
  };
}

/**
 * Starts Caddy, the git server and the prober, and waits until they serve.
 *
 * @returns {Promise<void>}
 */
export async function startInfra() {
  await docker(["volume", "create", NAMES.certs]);
  await docker(["volume", "create", NAMES.caddyData]);

  log("stack", "starting Caddy on the host network (admin API on localhost:2019)");
  await docker([
    "run",
    "-d",
    "--name",
    NAMES.caddy,
    "--network",
    "host",
    "-e",
    "CADDY_ADMIN=localhost:2019",
    "-v",
    `${NAMES.caddyData}:/data`,
    IMAGES.caddy,
    "caddy",
    "run",
    "--resume",
  ]);

  log("stack", `starting the git server on 127.0.0.1:${GIT_PORT}`);
  await docker([
    "run",
    "-d",
    "--name",
    NAMES.git,
    "--network",
    "host",
    "-e",
    `GIT_PORT=${GIT_PORT}`,
    "-v",
    `${NAMES.certs}:/certs`,
    NAMES.toolsImage,
    "/opt/e2e/init-repos.sh",
  ]);

  await docker([
    "run",
    "-d",
    "--name",
    NAMES.probe,
    "--network",
    "host",
    NAMES.toolsImage,
    "sleep",
    "infinity",
  ]);

  await waitFor(
    "the git server",
    async () =>
      (await docker(["logs", NAMES.git], { allowFail: true })).stdout.includes("listening"),
    { timeoutMs: 60_000 },
  );
  await waitFor(
    "Caddy's admin API",
    async () => (await probe(["admin", "/config/"])).status === 200,
    { timeoutMs: 60_000 },
  );
}

/**
 * Commit SHAs of the test repositories.
 *
 * @returns {Promise<{ appV1: string, appV2: string, broken: string, slow: string }>}
 */
export async function repoCommits() {
  const rev = async (repo, ref) =>
    (
      await docker(["exec", NAMES.git, "git", "-C", `/srv/git/${repo}.git`, "rev-parse", ref])
    ).stdout.trim();
  return {
    appV1: await rev("app", "main~1"),
    appV2: await rev("app", "main"),
    broken: await rev("broken", "main"),
    slow: await rev("slow", "main"),
  };
}

/** `docker run` arguments every agent container gets. */
function agentMounts() {
  return [
    "--network",
    "host",
    "-v",
    `${DOCKER_SOCKET}:${DOCKER_SOCKET}`,
    // Same path inside and out: the agent bind-mounts subdirectories of its
    // data dir into the registry container, and the engine resolves those
    // paths on its own host.
    "-v",
    `${DATA_DIR}:${DATA_DIR}`,
    "-v",
    `${NAMES.certs}:/e2e-certs:ro`,
  ];
}

/**
 * Joins the node with the real `/v1/nodes/join` flow, as a builder.
 *
 * @param {{ url: string, token: string, insecure: boolean }} opts
 * @returns {Promise<string>} The join command's output.
 */
export async function joinNode({ url, token, insecure }) {
  const args = [
    "run",
    "--rm",
    ...agentMounts(),
    "-e",
    "ROUNDHOUSE_JOIN_TOKEN",
    NAMES.nodeImage,
    "join",
    "--url",
    url,
    "--name",
    "e2e-builder",
    "--builder",
    "--config",
    `${DATA_DIR}/agent.yaml`,
    "--data-dir",
    DATA_DIR,
  ];
  if (insecure) args.push("--insecure");
  const res = await docker(args, { env: { ...process.env, ROUNDHOUSE_JOIN_TOKEN: token } });
  return res.stderr + res.stdout;
}

/**
 * Starts (or restarts) the agent container.
 *
 * @returns {Promise<void>}
 */
export async function startAgent() {
  await docker([
    "run",
    "-d",
    "--name",
    NAMES.agent,
    ...agentMounts(),
    // The control plane under `wrangler dev` is plain HTTP, so the agent
    // connects over ws://, where it applies workloads only in dev mode.
    "-e",
    "ROUNDHOUSE_DEV=1",
    NAMES.nodeImage,
    "run",
    "--config",
    `${DATA_DIR}/agent.yaml`,
  ]);
}

/**
 * Container IDs (full) matching a label filter, including stopped ones.
 *
 * @param {string} label - `key=value`.
 * @returns {Promise<string[]>}
 */
export async function containersWithLabel(label) {
  const { stdout } = await docker(["ps", "-aq", "--no-trunc", "--filter", `label=${label}`]);
  return stdout.split("\n").filter(Boolean);
}

/**
 * Names of the agent's BuildKit daemons (one per project), running or not.
 *
 * @returns {Promise<string[]>}
 */
async function buildkitDaemons() {
  const res = await docker(
    ["ps", "-a", "--filter", "label=roundhouse.system=buildkitd", "--format", "{{.Names}}"],
    { allowFail: true },
  );
  return res.stdout.split("\n").filter(Boolean);
}

/**
 * Collects what explains a failure: agent, Caddy and git server logs, the
 * live Caddy config, managed containers and the tail of wrangler's output.
 *
 * @param {{ wranglerLog?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function dumpDiagnostics(opts = {}) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const save = (name, text) => writeFileSync(join(ARTIFACTS, name), text ?? "");
  for (const [name, container] of [
    ["agent.log", NAMES.agent],
    ["caddy.log", NAMES.caddy],
    ["git-server.log", NAMES.git],
    ["sys_registry.log", "sys_registry"],
    // One BuildKit daemon per project.
    ...(await buildkitDaemons()).map((name) => [`${name}.log`, name]),
  ]) {
    const res = await docker(["logs", "--timestamps", container], { allowFail: true });
    save(name, res.stdout + res.stderr);
  }
  const caddy = await probe(["admin", "/config/"]).catch((err) => ({ error: err.message }));
  save("caddy-config.json", typeof caddy.body === "string" ? caddy.body : JSON.stringify(caddy));
  const ps = await docker(
    [
      "ps",
      "-a",
      "--filter",
      "label=roundhouse.managed=true",
      "--format",
      '{{.ID}} {{.Names}} {{.Image}} {{.Status}} {{.Label "roundhouse.deployment_id"}}',
    ],
    { allowFail: true },
  );
  save("containers.txt", ps.stdout);

  console.log("\n===== diagnostics (full files in e2e/phase1/.artifacts) =====");
  const agentLog = await docker(["logs", "--tail", "80", NAMES.agent], { allowFail: true });
  console.log(`--- agent (last 80 lines) ---\n${agentLog.stdout}${agentLog.stderr}`);
  console.log(`--- managed containers ---\n${ps.stdout}`);
  console.log(`--- caddy config ---\n${JSON.stringify(caddy).slice(0, 4000)}`);
  if (opts.wranglerLog) {
    const { readFileSync } = await import("node:fs");
    let text = "";
    try {
      text = readFileSync(opts.wranglerLog, "utf8");
    } catch {
      // Not started.
    }
    console.log(`--- wrangler dev (last 80 lines) ---\n${text.split("\n").slice(-80).join("\n")}`);
  }
}

/**
 * Whether a managed container or network belongs to a node rather than to
 * an agent integration test: tests label theirs `roundhouse.test` or give
 * them an `it…` namespace, nodes use their node ID (`node_…`), and Phase 1
 * agents none.
 *
 * @param {string} namespace - The `roundhouse.namespace` label.
 * @param {string} test - The `roundhouse.test` label.
 */
function nodeOwned(namespace, test) {
  return !test && (!namespace || namespace.startsWith("node_"));
}

/**
 * Removes everything the suite and the agent it ran created: containers,
 * networks, volumes and the agent's data directory. Safe to run when
 * nothing exists, so it also runs before a suite to clear a crashed run.
 *
 * WARNING: this removes every node's `roundhouse.managed=true` containers on
 * the engine, not only the suite's node; don't point the suite at an engine
 * that runs a real node.
 *
 * @returns {Promise<void>}
 */
export async function teardown() {
  log("teardown", "removing containers, networks, volumes and the node's data dir");
  // Control-plane state an earlier run could not delete while workerd still
  // held it open (Windows); a live one is locked and survives this.
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith("roundhouse-e2e-state-")) continue;
    try {
      rmSync(join(tmpdir(), name), { recursive: true, force: true });
    } catch {
      // Still in use.
    }
  }
  // The agent goes first so it can't recreate what is removed after it.
  await docker(["rm", "-f", "-v", NAMES.agent], { allowFail: true });
  const managed = await docker(
    [
      "ps",
      "-aq",
      "--filter",
      "label=roundhouse.managed=true",
      "--format",
      '{{.ID}}|{{.Label "roundhouse.namespace"}}|{{.Label "roundhouse.test"}}',
    ],
    { allowFail: true },
  );
  const ids = managed.stdout
    .split("\n")
    .map((l) => l.trim().split("|"))
    .filter(([id, ns, test]) => id && nodeOwned(ns, test))
    .map(([id]) => id);
  const named = [NAMES.caddy, NAMES.git, NAMES.probe, "sys_registry", "sys_buildkitd"];
  await docker(["rm", "-f", "-v", ...named, ...(await buildkitDaemons()), ...ids], {
    allowFail: true,
  });

  const nets = await docker(
    [
      "network",
      "ls",
      "--filter",
      "label=roundhouse.managed=true",
      "--format",
      '{{.Name}}|{{.Label "roundhouse.namespace"}}|{{.Label "roundhouse.test"}}',
    ],
    { allowFail: true },
  );
  const netNames = nets.stdout
    .split("\n")
    .map((l) => l.trim().split("|"))
    .filter(([name, ns, test]) => name && nodeOwned(ns, test))
    .map(([name]) => name);
  for (const net of [...new Set([...netNames, "roundhouse-build"])]) {
    await docker(["network", "rm", net], { allowFail: true });
  }
  if (process.env.PHASE1_KEEP_BUILD_CACHE !== "1") {
    const caches = await docker(
      ["volume", "ls", "-q", "--filter", "label=roundhouse.system=buildkitd"],
      { allowFail: true },
    );
    const volumes = caches.stdout.split("\n").filter(Boolean);
    await docker(["volume", "rm", "-f", "roundhouse-buildkit", ...volumes], { allowFail: true });
  }
  await docker(["volume", "rm", "-f", NAMES.certs, NAMES.caddyData], { allowFail: true });
  const tools = await docker(["image", "inspect", NAMES.toolsImage], { allowFail: true });
  if (tools.code === 0) {
    await docker(
      [
        "run",
        "--rm",
        "-v",
        "/var/lib:/host",
        NAMES.toolsImage,
        "rm",
        "-rf",
        `/host${DATA_DIR.slice("/var/lib".length)}`,
      ],
      { allowFail: true },
    );
  }
}

export { runInherit };
