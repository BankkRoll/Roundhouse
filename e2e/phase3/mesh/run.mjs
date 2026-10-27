#!/usr/bin/env node
/**
 * Runs the mesh end-to-end suite against a real two-node stack and always
 * tears it down afterwards (also after a failure or Ctrl-C):
 *
 * 1. clears leftovers of an earlier run;
 * 2. builds the agent (linux, the engine's arch) and the node image;
 * 3. starts `wrangler dev` with fresh state and two Docker-in-Docker nodes;
 * 4. runs `mesh.test.mjs` (node:test), which joins both nodes itself;
 * 5. on failure, saves each node's agent, Caddy, engine and nft state to
 *    `e2e/phase3/.artifacts`.
 *
 * Env: PHASE3_PORT (default 8798), PHASE3_KEEP=1 leaves the stack running.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isWindows, log, ROOT, runInherit } from "../../phase1/lib/util.mjs";
import {
  ARTIFACTS,
  buildImages,
  dumpDiagnostics,
  startControlPlane,
  startNodes,
  teardown,
  writeArtifact,
} from "./lib/stack.mjs";

const port = Number(process.env.PHASE3_PORT ?? 8798);
const keep = process.env.PHASE3_KEEP === "1";
const started = Date.now();
/** @type {Awaited<ReturnType<typeof startControlPlane>> | undefined} */
let controlPlane;

async function cleanup() {
  if (keep) return log("run", "PHASE3_KEEP=1: leaving the stack running");
  await teardown();
  controlPlane?.stop();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await cleanup();
    process.exit(130);
  });
}

let failed = false;
try {
  await teardown();
  rmSync(ARTIFACTS, { recursive: true, force: true });
  // wrangler refuses to start without the dashboard's assets directory.
  if (!existsSync(join(ROOT, "apps", "web", "dist", "index.html"))) {
    await runInherit("pnpm", ["--filter", "@roundhouse/web", "build"], {
      cwd: ROOT,
      shell: isWindows,
    });
  }
  await buildImages();
  controlPlane = await startControlPlane({ port });
  const ips = await startNodes();
  const stackFile = writeArtifact("stack.json", {
    base: controlPlane.base,
    nodeUrl: controlPlane.nodeUrl,
    masterKey: controlPlane.masterKey,
    state: controlPlane.state,
    ips,
  });
  await runInherit(
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=spec",
      join(import.meta.dirname, "mesh.test.mjs"),
    ],
    { cwd: ROOT, env: { ...process.env, PHASE3_STACK: stackFile } },
  );
  log("run", `PASS in ${((Date.now() - started) / 1000).toFixed(0)}s`);
} catch (err) {
  failed = true;
  console.error(`\n[phase3] FAIL: ${err.message}`);
  await dumpDiagnostics().catch((e) => console.error(`diagnostics failed: ${e.message}`));
} finally {
  await cleanup();
  process.exit(failed ? 1 : 0);
}
