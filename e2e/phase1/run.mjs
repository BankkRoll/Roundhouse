#!/usr/bin/env node
/**
 * Runs the Phase 1 end-to-end suite against the real stack and always tears
 * it down afterwards (also after a failure or Ctrl-C):
 *
 * 1. clears leftovers of an earlier run;
 * 2. builds the agent (linux, the engine's arch) and the test images;
 * 3. starts `wrangler dev` with fresh state, Caddy, the git server and the prober;
 * 4. runs `api.test.mjs` (node:test), which drives every API-level step and
 *    joins the node itself;
 * 5. runs the dashboard spec (`ui.spec.ts`, Playwright) on the same stack,
 *    unless `PHASE1_UI=0`;
 * 6. on failure, dumps agent/Caddy/git/wrangler logs and Caddy's config to
 *    `e2e/phase1/.artifacts`.
 *
 * Env: see README.md (PHASE1_PORT, PHASE1_UI, PHASE1_SKIP_WEB_BUILD,
 * PHASE1_KEEP, PHASE1_KEEP_BUILD_CACHE, PHASE1_GIT_PORT, PHASE1_ROLLOUT_TIMEOUT_S).
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  buildImages,
  dumpDiagnostics,
  repoCommits,
  runInherit,
  startControlPlane,
  startInfra,
  teardown,
} from "./lib/stack.mjs";
import { ARTIFACTS, isWindows, log, ROOT, writeArtifact } from "./lib/util.mjs";

const apiTest = join(import.meta.dirname, "api.test.mjs");
const port = Number(process.env.PHASE1_PORT ?? 8797);
const withUi = process.env.PHASE1_UI !== "0";
const keep = process.env.PHASE1_KEEP === "1";
const started = Date.now();

/** @type {Awaited<ReturnType<typeof startControlPlane>> | undefined} */
let controlPlane;
let cleaning = false;

async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  if (keep) {
    if (controlPlane) writeArtifact("keep.json", controlPlane.handle);
    log(
      "run",
      "PHASE1_KEEP=1: leaving the stack running; run `node e2e/phase1/teardown.mjs` later",
    );
    return;
  }
  await teardown();
  controlPlane?.stop();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    log("run", `${signal}: tearing down`);
    await cleanup();
    process.exit(130);
  });
}

let failed = false;
try {
  await teardown();
  rmSync(ARTIFACTS, { recursive: true, force: true });

  // NOTE: the dashboard is built even with PHASE1_UI=0 when it is missing,
  // because wrangler refuses to start without assets.directory (apps/web/dist).
  const haveWeb = existsSync(join(ROOT, "apps", "web", "dist", "index.html"));
  const skipWeb = haveWeb && (process.env.PHASE1_SKIP_WEB_BUILD === "1" || !withUi);
  if (!skipWeb) {
    log("run", "building the dashboard");
    await runInherit("pnpm", ["--filter", "@roundhouse/web", "build"], {
      cwd: ROOT,
      shell: isWindows,
    });
  }
  await buildImages();
  controlPlane = await startControlPlane({ port });
  await startInfra();
  const stackFile = writeArtifact("stack.json", {
    base: controlPlane.base,
    nodeUrl: controlPlane.nodeUrl,
    insecure: controlPlane.insecure,
    masterKey: controlPlane.masterKey,
    commits: await repoCommits(),
  });
  const env = { ...process.env, PHASE1_STACK: stackFile };

  log("run", "running the API suite (node --test)");
  await runInherit(
    process.execPath,
    ["--test", "--test-concurrency=1", "--test-reporter=spec", apiTest],
    { cwd: ROOT, env },
  );

  if (withUi) {
    log("run", "running the dashboard spec (Playwright)");
    await runInherit("npx", ["playwright", "test", "-c", "phase1/playwright.config.ts"], {
      cwd: join(ROOT, "e2e"),
      shell: isWindows,
      env,
    });
  }
  log("run", `PASS in ${((Date.now() - started) / 1000).toFixed(0)}s`);
} catch (err) {
  failed = true;
  console.error(`\n[phase1] FAIL: ${err.message}`);
  await dumpDiagnostics({ wranglerLog: controlPlane?.logFile }).catch((e) =>
    console.error(`diagnostics failed: ${e.message}`),
  );
} finally {
  await cleanup();
  log("run", `finished in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  process.exit(failed ? 1 : 0);
}
