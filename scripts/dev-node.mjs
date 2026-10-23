#!/usr/bin/env node
/**
 * Runs a real node for local development inside Docker (works on Windows,
 * macOS, and Linux): the agent, git and Railpack in one container plus Caddy
 * beside it, both on the engine's host network, joined to the control plane
 * started by `pnpm dev`.
 *
 * Usage:
 *   pnpm dev:node <join-token>   build, join as a builder, start
 *   pnpm dev:node --down         stop and remove everything it created
 *
 * `install.sh` is for real Linux servers; this is the equivalent for a laptop.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const NODE_FIXTURE = join(ROOT, "e2e", "phase1", "fixtures", "node");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: dev-only script, never run through turbo.
const API_PORT = process.env.DEV_API_PORT ?? "8787";

const NAMES = {
  agent: "roundhouse-dev-agent",
  caddy: "roundhouse-dev-caddy",
  caddyData: "roundhouse-dev-caddy-data",
  image: "roundhouse-dev-node:local",
};
// Same path inside and outside the agent container: the agent bind-mounts
// directories under it into the registry, and the engine resolves them on its host.
const DATA_DIR = "/var/lib/roundhouse-dev";
const CADDY_IMAGE =
  "caddy:2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f";

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: opts.quiet ? "pipe" : "inherit", ...opts });
  if (res.status !== 0 && !opts.allowFail) {
    console.error(`\n${cmd} ${args.join(" ")} failed`);
    process.exit(res.status ?? 1);
  }
  return res;
}

const docker = (args, opts) => sh("docker", args, opts);

function down() {
  docker(["rm", "-f", NAMES.agent, NAMES.caddy], { allowFail: true, quiet: true });
  const managed = docker(["ps", "-aq", "--filter", "label=roundhouse.managed=true"], {
    quiet: true,
    allowFail: true,
  });
  const ids = String(managed.stdout ?? "")
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length) docker(["rm", "-f", ...ids], { allowFail: true, quiet: true });
  for (const name of ["sys_registry", "sys_buildkitd"]) {
    docker(["rm", "-f", name], { allowFail: true, quiet: true });
  }
  docker(["volume", "rm", NAMES.caddyData], { allowFail: true, quiet: true });
  // The data dir lives on the engine host (the Docker VM on Docker Desktop).
  docker(["run", "--rm", "-v", "/var/lib:/host", "alpine", "rm", "-rf", "/host/roundhouse-dev"], {
    allowFail: true,
    quiet: true,
  });
  console.log("Local node removed.");
}

const arg = process.argv[2];
if (!arg || arg === "--help") {
  console.log("Usage: pnpm dev:node <join-token> | pnpm dev:node --down");
  process.exit(arg ? 0 : 1);
}
if (arg === "--down") {
  down();
  process.exit(0);
}
const token = arg;

const info = docker(["info", "--format", "{{.OperatingSystem}}|{{.Architecture}}"], {
  quiet: true,
});
const [os, rawArch] = String(info.stdout).trim().split("|");
const arch = rawArch === "aarch64" || rawArch === "arm64" ? "arm64" : "amd64";
const dockerDesktop = /Docker Desktop/i.test(os ?? "");
// Docker Desktop's host network is the VM, so the host's loopback is reached
// through host.docker.internal; on Linux the host network is the real host.
const url = dockerDesktop
  ? `http://host.docker.internal:${API_PORT}`
  : `http://127.0.0.1:${API_PORT}`;

console.log(`Building the agent for linux/${arch}…`);
const ctx = mkdtempSync(join(tmpdir(), "roundhouse-dev-node-"));
try {
  sh("go", ["build", "-trimpath", "-o", join(ctx, "roundhouse-agent"), "./cmd/roundhouse-agent"], {
    cwd: join(ROOT, "agent"),
    env: { ...process.env, GOOS: "linux", GOARCH: arch, CGO_ENABLED: "0" },
  });
  cpSync(NODE_FIXTURE, ctx, { recursive: true });
  docker(["build", "-q", "-t", NAMES.image, ctx]);
} finally {
  rmSync(ctx, { recursive: true, force: true });
}

docker(["rm", "-f", NAMES.agent, NAMES.caddy], { allowFail: true, quiet: true });
console.log("Starting Caddy…");
docker(["volume", "create", NAMES.caddyData], { quiet: true });
docker(
  [
    "run",
    "-d",
    "--name",
    NAMES.caddy,
    "--restart",
    "unless-stopped",
    "--network",
    "host",
    "-e",
    "CADDY_ADMIN=localhost:2019",
    "-v",
    `${NAMES.caddyData}:/data`,
    CADDY_IMAGE,
    "caddy",
    "run",
    "--resume",
  ],
  { quiet: true },
);

const mounts = [
  "--network",
  "host",
  "-v",
  "/var/run/docker.sock:/var/run/docker.sock",
  "-v",
  `${DATA_DIR}:${DATA_DIR}`,
];

console.log(`Joining ${url} as a builder…`);
const join_ = docker(
  [
    "run",
    "--rm",
    ...mounts,
    "-e",
    "ROUNDHOUSE_JOIN_TOKEN",
    NAMES.image,
    "join",
    "--url",
    url,
    "--name",
    "local-dev",
    "--builder",
    "--force",
    "--config",
    `${DATA_DIR}/agent.yaml`,
    "--data-dir",
    DATA_DIR,
    // The dev control plane is plain HTTP on a non-loopback address from the container's view.
    ...(dockerDesktop ? ["--insecure"] : []),
  ],
  { env: { ...process.env, ROUNDHOUSE_JOIN_TOKEN: token } },
);
if (join_.status !== 0) process.exit(1);

docker(
  [
    "run",
    "-d",
    "--name",
    NAMES.agent,
    "--restart",
    "unless-stopped",
    ...mounts,
    NAMES.image,
    "run",
    "--config",
    `${DATA_DIR}/agent.yaml`,
  ],
  { quiet: true },
);

console.log(`
Node "local-dev" is running and should show as online in Servers.
  Logs:        docker logs -f ${NAMES.agent}
  Stop/remove: pnpm dev:node --down
For generated domains, set Platform → Apps domain to 127.0.0.1.nip.io and TLS to "off".${
  dockerDesktop
    ? `
To open deployed apps from this PC, turn on Docker Desktop → Settings → Resources →
Network → "Enable host networking" so Caddy's port 80 is reachable on localhost.`
    : ""
}`);
