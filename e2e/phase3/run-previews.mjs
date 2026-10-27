#!/usr/bin/env node
/**
 * Runs the pull request previews suite (ADR 0007) against the real stack:
 * the Phase 1 stack (`wrangler dev`, a real agent in a Linux container,
 * Docker, BuildKit, the local registry, Caddy, the HTTPS git server) plus a
 * fake GitHub the control plane reaches through `GITHUB_API_URL`. Always
 * tears the stack down afterwards.
 *
 * It shares the Phase 1 containers' names, so it never runs at the same time
 * as that suite (or another one built on its stack).
 *
 * Env: PREVIEWS_PORT (wrangler, default 8799), PREVIEWS_GITHUB_PORT (fake
 * GitHub, default 8899), PHASE1_SKIP_WEB_BUILD=1 to reuse apps/web/dist.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildImages,
  dumpDiagnostics,
  repoCommits,
  runInherit,
  startControlPlane,
  startInfra,
  teardown,
} from "../phase1/lib/stack.mjs";
import { isWindows, log, ROOT, writeArtifact } from "../phase1/lib/util.mjs";

const port = Number(process.env.PREVIEWS_PORT ?? 8799);
const githubPort = Number(process.env.PREVIEWS_GITHUB_PORT ?? 8899);
const started = Date.now();

/** @type {Awaited<ReturnType<typeof startControlPlane>> | undefined} */
let controlPlane;

let failed = false;
try {
  await teardown();
  if (!existsSync(join(ROOT, "apps", "web", "dist", "index.html"))) {
    log("previews", "building the dashboard (wrangler needs its assets)");
    await runInherit("pnpm", ["--filter", "@roundhouse/web", "build"], {
      cwd: ROOT,
      shell: isWindows,
    });
  }
  await buildImages();
  // The suite itself serves the fake GitHub on this port, so it can read and
  // steer it; the control plane only calls it once the suite runs.
  controlPlane = await startControlPlane({
    port,
    vars: { GITHUB_API_URL: `http://127.0.0.1:${githubPort}` },
    varsName: ".dev.vars.previews",
  });
  await startInfra();
  const stackFile = writeArtifact("previews-stack.json", {
    base: controlPlane.base,
    nodeUrl: controlPlane.nodeUrl,
    insecure: controlPlane.insecure,
    masterKey: controlPlane.masterKey,
    state: controlPlane.handle.state,
    commits: await repoCommits(),
    githubPort,
  });
  log("previews", "running the previews suite (node --test)");
  await runInherit(
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=spec",
      join(import.meta.dirname, "previews.test.mjs"),
    ],
    { cwd: ROOT, env: { ...process.env, PREVIEWS_STACK: stackFile } },
  );
  log("previews", `PASS in ${((Date.now() - started) / 1000).toFixed(0)}s`);
} catch (err) {
  failed = true;
  console.error(`\n[previews] FAIL: ${err.message}`);
  await dumpDiagnostics({ wranglerLog: controlPlane?.logFile }).catch((e) =>
    console.error(`diagnostics failed: ${e.message}`),
  );
} finally {
  await teardown();
  controlPlane?.stop();
  log("previews", `finished in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  process.exit(failed ? 1 : 0);
}
