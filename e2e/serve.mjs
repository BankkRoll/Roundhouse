#!/usr/bin/env node
/**
 * Starts a throwaway control plane for browser tests: fresh local D1 state,
 * migrations applied, the built dashboard served as static assets, and a
 * fixed test MASTER_KEY (exported for the tests via `E2E_MASTER_KEY`).
 *
 * Playwright's `webServer` runs this and waits for the port.
 */
import { spawn, spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { E2E_MASTER_KEY } from "./constants.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const API_DIR = join(ROOT, "apps", "api");
const STATE = join(import.meta.dirname, ".state");
const PORT = process.env.E2E_PORT ?? "8798";
const isWindows = process.platform === "win32";

rmSync(STATE, { recursive: true, force: true });
writeFileSync(join(API_DIR, ".dev.vars.e2e"), `MASTER_KEY=${E2E_MASTER_KEY}\n`);

const opts = { cwd: API_DIR, stdio: "inherit", shell: isWindows };
const migrate = spawnSync(
  "npx",
  ["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", STATE],
  opts,
);
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const server = spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "--port",
    PORT,
    "--ip",
    "127.0.0.1",
    "--persist-to",
    STATE,
    "--env-file",
    ".dev.vars.e2e",
  ],
  opts,
);
const stop = () => {
  rmSync(join(API_DIR, ".dev.vars.e2e"), { force: true });
  if (isWindows) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"]);
  else server.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("exit", (code) => process.exit(code ?? 0));
