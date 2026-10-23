/**
 * Phase 1 end to end, at the API level, against the real stack `run.mjs`
 * starts: `wrangler dev`, a real Go agent in a Linux container joined as a
 * builder, Docker, BuildKit, the local registry and Caddy.
 *
 * Steps run in order and share state; once one fails the rest are skipped,
 * since each builds on the previous ones. Evidence (timings, digests, the
 * failure count during the swap) is written to `.artifacts/evidence.json`.
 *
 * Run it through `run.mjs` (it needs `PHASE1_STACK`).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { Api } from "./lib/api.mjs";
import {
  containersWithLabel,
  DATA_DIR,
  docker,
  GIT_PORT,
  IMAGES,
  joinNode,
  NAMES,
  probe,
  ROLLOUT_TIMEOUT_S,
  startAgent,
  startLoop,
} from "./lib/stack.mjs";
import { log, randomId, waitFor, writeArtifact } from "./lib/util.mjs";

const stack = JSON.parse(readFileSync(process.env.PHASE1_STACK ?? "", "utf8"));
const api = new Api(stack.base);

const OWNER = {
  name: "Phase One",
  email: "phase1@example.com",
  password: "phase one e2e password",
};
const APPS_DOMAIN = "127.0.0.1.nip.io";
const SECRET = `s3cret-${randomId(16)}`;
const repoUrl = (name) => `https://127.0.0.1:${GIT_PORT}/${name}.git`;

/** Redeploys step 5 swaps through under one request loop. */
const SWAPS = 5;

/** Shared across steps. */
const S = {
  /** @type {string} */ workspaceId: "",
  /** @type {string} */ projectId: "",
  /** @type {string} */ envId: "",
  /** @type {string} */ stagingId: "",
  /** @type {string} */ nodeId: "",
  whoami: { id: "", host: "", deploymentId: "" },
  /** `active` is the app deployment currently serving. */
  app: { id: "", host: "", v1: "", v2: "", rollback: "", active: "", cancelledBuild: "" },
  /** Every deployment created, for diagnostics. */
  deployments: new Set(),
};

/** Evidence for the report. */
const E = {};
let broken = false;

/**
 * Registers a step that is skipped once an earlier one failed.
 *
 * @param {string} name - Step title.
 * @param {(t: import("node:test").TestContext) => Promise<void>} fn - The step.
 */
function step(name, fn) {
  it(name, async (t) => {
    if (broken) {
      t.skip("an earlier step failed");
      return;
    }
    const started = Date.now();
    try {
      await fn(t);
      E[name] = { ...(E[name] ?? {}), seconds: Math.round((Date.now() - started) / 1000) };
    } catch (err) {
      broken = true;
      E[name] = { ...(E[name] ?? {}), failed: err.message };
      await dumpDeployments();
      throw err;
    } finally {
      writeArtifact("evidence.json", E);
    }
  });
}

/** Records a piece of evidence for a step. */
function evidence(stepName, data) {
  E[stepName] = { ...(E[stepName] ?? {}), ...data };
}

async function dumpDeployments() {
  const out = {};
  for (const id of S.deployments) {
    out[id] = await api.get(`/v1/deployments/${id}`).catch((err) => ({ error: err.message }));
  }
  writeArtifact("deployments.json", out);
  for (const [id, d] of Object.entries(out)) {
    console.log(`--- deployment ${id}: ${d.status ?? d.error} ${d.failure_reason ?? ""}`);
    for (const e of (d.events ?? []).slice(-12)) console.log(`    ${e.type}: ${e.message}`);
  }
}

const TERMINAL = ["active", "failed", "cancelled", "removed", "rolled_back", "crashed"];

/**
 * Waits until a deployment reaches one of `statuses`, failing at once when
 * it settles in another terminal status.
 */
async function settle(id, statuses, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await api.get(`/v1/deployments/${id}`);
    if (statuses.includes(d.status)) return d;
    if (TERMINAL.includes(d.status)) {
      assert.fail(
        `deployment ${id} is ${d.status} (wanted ${statuses.join("/")}): ${d.failure_reason ?? ""}\n` +
          d.events.map((e) => `  ${e.type}: ${e.message}`).join("\n"),
      );
    }
    if (Date.now() > deadline) {
      assert.fail(
        `deployment ${id} still ${d.status} after ${timeoutMs / 1000}s; last event: ${d.events.at(-1)?.message}`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function deploy(serviceId, body = {}) {
  const d = await api.post(`/v1/services/${serviceId}/deployments?environment_id=${S.envId}`, body);
  S.deployments.add(d.id);
  return d;
}

async function setVariables(serviceId, set) {
  return api.put(`/v1/services/${serviceId}/variables?environment_id=${S.envId}`, { set });
}

async function patchService(serviceId, patch) {
  return api.patch(`/v1/services/${serviceId}`, { environment_id: S.envId, ...patch });
}

async function domainOf(serviceId) {
  const { domains } = await api.get(`/v1/services/${serviceId}/domains?environment_id=${S.envId}`);
  assert.equal(domains.length, 1, `service ${serviceId} has one generated domain`);
  return domains[0];
}

/** GET through Caddy; JSON-decodes the body when possible. */
async function viaCaddy(host, path = "/", opts = {}) {
  const r = await probe(["get", host, path, ...(opts.https ? ["--https"] : [])]);
  try {
    r.json = JSON.parse(r.body);
  } catch {
    r.json = null;
  }
  return r;
}

async function running(...labels) {
  const filters = labels.flatMap((l) => ["--filter", `label=${l}`]);
  const { stdout } = await docker(["ps", "-q", "--no-trunc", ...filters]);
  return stdout.split("\n").filter(Boolean);
}

/**
 * Requests each URL from inside a container with Node's fetch and returns,
 * per URL, `ok <status>` or `fail <error code>`.
 *
 * @param {string} container - Container ID; its image must have node.
 * @param {Record<string, string>} urls - Label to URL.
 * @returns {Promise<Record<string, string>>}
 */
async function fetchFrom(container, urls) {
  const script = `
const urls = ${JSON.stringify(urls)};
const out = {};
for (const [k, u] of Object.entries(urls)) {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(4000) });
    out[k] = "ok " + r.status;
  } catch (e) {
    out[k] = "fail " + (e.cause?.code ?? e.name);
  }
}
console.log(JSON.stringify(out));`;
  const { stdout } = await docker(
    ["exec", container, "node", "--input-type=module", "-e", script],
    {
      timeoutMs: 60_000,
    },
  );
  return JSON.parse(stdout.trim().split("\n").pop());
}

/** Command lines of every process in BuildKit's container, build steps included. */
async function buildkitProcesses() {
  const { stdout } = await docker(["exec", "sys_buildkitd", "ps", "-o", "args"], {
    allowFail: true,
  });
  return stdout;
}

after(() => writeArtifact("evidence.json", E));

describe("Phase 1 on the real stack", () => {
  step("1. control plane: setup, login, ingress settings", async () => {
    const status = await api.get("/v1/setup");
    assert.equal(status.needs_setup, true, "fresh state");
    assert.equal(status.master_key_configured, true);

    log("step 1", "running first-time setup");
    const setup = await api.post("/v1/setup", {
      master_key: stack.masterKey,
      name: OWNER.name,
      email: OWNER.email,
      password: OWNER.password,
      workspace_name: "Phase One",
    });
    S.workspaceId = setup.workspace_id;

    log("step 1", "signing out and back in through the auth API");
    await api.post("/api/auth/sign-out", {});
    api.cookies.clear();
    const anon = await api.request("GET", "/v1/me");
    assert.equal(anon.status, 401);
    await api.post("/api/auth/sign-in/email", { email: OWNER.email, password: OWNER.password });
    const me = await api.get("/v1/me");
    assert.equal(me.user.email, OWNER.email);

    log("step 1", `apps_domain=${APPS_DOMAIN}, tls_mode=off`);
    const settings = await api.patch("/v1/instance/settings", {
      apps_domain: APPS_DOMAIN,
      tls_mode: "off",
    });
    assert.equal(settings.apps_domain, APPS_DOMAIN);
    assert.equal(settings.tls_mode, "off");
    writeArtifact("session.json", { ...OWNER, workspaceId: S.workspaceId });
  });

  step("2. node: join as a builder and come online", async () => {
    const { token } = await api.post(`/v1/workspaces/${S.workspaceId}/nodes/join-tokens`);
    log("step 2", `joining via ${stack.nodeUrl}${stack.insecure ? " (--insecure)" : ""}`);
    const out = await joinNode({ url: stack.nodeUrl, token, insecure: stack.insecure });
    assert.match(out, /joined control plane/);
    await startAgent();

    const node = await waitFor(
      "the node to be online with builder capability",
      async () => {
        const { nodes } = await api.get(`/v1/workspaces/${S.workspaceId}/nodes`);
        const n = nodes[0];
        return n?.status === "online" && n.capabilities?.builder && n.capabilities?.docker
          ? n
          : null;
      },
      { timeoutMs: 60_000 },
    );
    S.nodeId = node.id;
    log("step 2", `node ${node.id} online; waiting for sys_registry and sys_buildkitd`);
    await waitFor(
      "the registry system workload",
      async () => (await running("roundhouse.workload_id=sys_registry")).length === 1,
      { timeoutMs: 180_000 },
    );
    evidence("2. node: join as a builder and come online", { node_id: node.id });
  });

  step("3. image source: deploy traefik/whoami and reach it through Caddy", async () => {
    const project = await api.post(`/v1/workspaces/${S.workspaceId}/projects`, {
      name: "Phase One",
    });
    S.projectId = project.id;
    S.envId = project.environments.find((e) => e.slug === "production").id;

    const created = await api.post(`/v1/projects/${S.projectId}/services`, {
      name: "whoami",
      source: { type: "image", image: IMAGES.whoami },
      config: {
        networking: { port: 80, generated_domain: true },
        deploy: { drain_s: 2 },
        healthcheck: {
          type: "http",
          path: "/health",
          interval_s: 1,
          timeout_s: 2,
          retries: 3,
          start_period_s: 0,
        },
      },
    });
    S.whoami.id = created.service.id;
    await setVariables(S.whoami.id, [
      { key: "GREETING_SOURCE", value: "hello-from-whoami" },
      { key: "WHOAMI_MARK", value: `mark-${randomId(6)}` },
    ]);

    const started = Date.now();
    const d = await deploy(S.whoami.id);
    log("step 3", `deployment ${d.id} created; waiting for active`);
    const active = await settle(d.id, ["active"], 180_000);
    S.whoami.deploymentId = d.id;
    assert.equal(active.image, IMAGES.whoami);
    assert.equal(active.placements[0].state, "healthy");

    S.whoami.host = (await domainOf(S.whoami.id)).hostname;
    assert.ok(S.whoami.host.endsWith(`.${APPS_DOMAIN}`), S.whoami.host);
    const res = await waitFor(
      `whoami at ${S.whoami.host} through Caddy`,
      async () => {
        const r = await viaCaddy(S.whoami.host);
        return r.status === 200 ? r : null;
      },
      { timeoutMs: 30_000 },
    );
    assert.match(res.body, /Hostname: /);
    assert.match(res.body, new RegExp(`Host: ${S.whoami.host.replace(/\./g, "\\.")}`));

    const vars = await api.get(`/v1/services/${S.whoami.id}/variables?environment_id=${S.envId}`);
    const mark = vars.variables.find((v) => v.key === "WHOAMI_MARK").value;
    const env = await viaCaddy(S.whoami.host, "/?env=true");
    assert.match(env.body, new RegExp(`WHOAMI_MARK=${mark}`), "variable reached the container");
    assert.match(env.body, new RegExp(`ROUNDHOUSE_DEPLOYMENT_ID=${d.id}`), "built-ins reached it");
    evidence("3. image source: deploy traefik/whoami and reach it through Caddy", {
      deployment: d.id,
      host: S.whoami.host,
      image: active.image,
      seconds_to_active: Math.round((Date.now() - started) / 1000),
    });
  });

  step("4. git source: Railpack build, registry, Caddy, resolved references", async () => {
    const created = await api.post(`/v1/projects/${S.projectId}/services`, {
      name: "app",
      source: { type: "git", repo_url: repoUrl("app"), branch: "main", root_dir: "." },
      config: {
        build: { builder: "railpack" },
        networking: { port: 3000, generated_domain: true },
        deploy: { drain_s: 3 },
        healthcheck: {
          type: "http",
          path: "/health",
          interval_s: 1,
          timeout_s: 2,
          retries: 3,
          start_period_s: 0,
        },
      },
    });
    S.app.id = created.service.id;
    await setVariables(S.app.id, [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: variable-reference syntax.
      { key: "GREETING", value: "${{whoami.GREETING_SOURCE}} v1" },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: variable-reference syntax.
      { key: "PEER_URL", value: "http://${{whoami.ROUNDHOUSE_PRIVATE_DOMAIN}}:80/" },
      { key: "API_TOKEN", value: SECRET, is_secret: true },
    ]);

    const started = Date.now();
    const d = await deploy(S.app.id, { commit_sha: stack.commits.appV1 });
    S.app.v1 = d.id;
    log("step 4", `deployment ${d.id} building ${stack.commits.appV1.slice(0, 7)} with Railpack`);
    const building = await settle(d.id, ["building", "deploying", "active"], 60_000);
    assert.ok(building.build_id, "a build row exists");

    const active = await settle(d.id, ["active"], 20 * 60_000);
    const buildSeconds = Math.round((Date.now() - started) / 1000);
    assert.equal(active.build.status, "succeeded");
    const digest = active.build.image_digest;
    assert.match(digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(active.image, `${active.build.image_repository}@${digest}`);
    assert.ok(active.image.startsWith("127.0.0.1:5000/"), active.image);

    const logs = await waitFor(
      "build logs",
      async () => {
        const page = await api.get(`/v1/builds/${active.build_id}/logs?limit=1000`);
        return page.lines.length > 0 ? page : null;
      },
      { timeoutMs: 30_000 },
    );
    log("step 4", `build ${active.build_id}: ${logs.lines.length} log lines, digest ${digest}`);

    const repo = active.build.image_repository.slice("127.0.0.1:5000/".length);
    const manifest = await probe(["url", `http://127.0.0.1:5000/v2/${repo}/manifests/${digest}`]);
    assert.equal(manifest.status, 200, `registry has ${repo}@${digest}`);

    S.app.host = (await domainOf(S.app.id)).hostname;
    const res = await waitFor(
      `the app at ${S.app.host}`,
      async () => {
        const r = await viaCaddy(S.app.host);
        return r.status === 200 && r.json ? r : null;
      },
      { timeoutMs: 30_000 },
    );
    assert.equal(res.json.version, "v1");
    assert.equal(res.json.greeting, "hello-from-whoami v1", "reference resolved across services");
    assert.equal(res.json.deployment_id, d.id);

    log("step 4", "service-to-service: app → whoami over the private domain");
    const peer = await viaCaddy(S.app.host, "/peer");
    assert.equal(peer.status, 200, peer.body);
    assert.match(peer.body, /Hostname: /);
    assert.match(peer.body, /Host: whoami\.production\.internal/);

    evidence("4. git source: Railpack build, registry, Caddy, resolved references", {
      deployment: d.id,
      build_id: active.build_id,
      image: active.image,
      digest,
      build_log_lines: logs.lines.length,
      seconds_to_active: buildSeconds,
    });
  });

  step("4b. environments are isolated from each other", async () => {
    const staging = await api.post(`/v1/projects/${S.projectId}/environments`, {
      name: "staging",
      kind: "staging",
      copy_from_environment_id: S.envId,
    });
    S.stagingId = staging.id;
    const d = await api.post(
      `/v1/services/${S.whoami.id}/deployments?environment_id=${S.stagingId}`,
      {},
    );
    S.deployments.add(d.id);
    log("step 4b", `staging whoami ${d.id}; probing it from the production app`);
    await settle(d.id, ["active"], 180_000);

    const [stagingWhoami] = await running(`roundhouse.deployment_id=${d.id}`);
    const [prodApp] = await running(`roundhouse.deployment_id=${S.app.v1}`);
    assert.ok(stagingWhoami && prodApp, "both containers run");
    const inspect = JSON.parse((await docker(["inspect", stagingWhoami, prodApp])).stdout);
    const nets = inspect.map((c) => Object.keys(c.NetworkSettings.Networks));
    assert.equal(nets[0].length, 1, `staging joins one network: ${nets[0]}`);
    assert.equal(nets[1].length, 1, `production joins one network: ${nets[1]}`);
    assert.notEqual(nets[0][0], nets[1][0], "environments share no network");
    assert.equal(nets[1][0], `roundhouse-${S.projectId}-${S.envId}`);
    const stagingIp = inspect[0].NetworkSettings.Networks[nets[0][0]].IPAddress;

    const reach = await fetchFrom(prodApp, {
      ownName: "http://whoami.production.internal/",
      otherName: "http://whoami.staging.internal/",
      otherIp: `http://${stagingIp}/`,
    });
    log("step 4b", `from production: ${JSON.stringify(reach)}`);
    assert.equal(reach.ownName, "ok 200", "production still reaches its own services");
    assert.match(reach.otherName, /^fail /, "staging's private domain does not resolve");
    assert.match(reach.otherIp, /^fail /, "staging's address is unreachable");
    evidence("4b. environments are isolated from each other", {
      staging_network: nets[0][0],
      production_network: nets[1][0],
      from_production: reach,
    });
  });

  step("5. zero-downtime redeploys after a variable change", async () => {
    const before = await running(`roundhouse.deployment_id=${S.app.v1}`);
    assert.equal(before.length, 1);
    const stop = await startLoop(S.app.host);
    let summary;
    const swaps = [];
    try {
      await setVariables(S.app.id, [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: variable-reference syntax.
        { key: "GREETING", value: "${{whoami.GREETING_SOURCE}} v2" },
      ]);
      let previous = S.app.v1;
      for (let i = 1; i <= SWAPS; i++) {
        // Odd swaps deploy v2, even ones v1, so the last one serves v2.
        const version = i % 2 ? "v2" : "v1";
        const d = await deploy(S.app.id, {
          commit_sha: version === "v2" ? stack.commits.appV2 : stack.commits.appV1,
        });
        log("step 5", `swap ${i}/${SWAPS}: ${d.id} (${version}) under the request loop`);
        await settle(d.id, ["active"], 10 * 60_000);
        await settle(previous, ["removed"], 30_000);
        await waitFor(
          "the old container to be removed after draining",
          async () =>
            (await containersWithLabel(`roundhouse.deployment_id=${previous}`)).length === 0,
          { timeoutMs: 60_000 },
        );
        swaps.push({ deployment: d.id, version });
        previous = d.id;
      }
      S.app.v2 = previous;
    } finally {
      summary = await stop();
    }
    log(
      "step 5",
      `loop: ${summary.total} requests over ${swaps.length} swaps, ${summary.failed} failed, ${summary.resets.length} connection resets, max ${summary.max_ms}ms`,
    );
    assert.equal(swaps.length, SWAPS);
    assert.equal(
      summary.failed,
      0,
      `failed requests during the swaps: ${JSON.stringify(summary.failures)}`,
    );
    assert.equal(summary.resets.length, 0, `connection resets: ${JSON.stringify(summary.resets)}`);
    const bodies = Object.keys(summary.bodies).map((b) => JSON.parse(b));
    assert.ok(
      bodies.some((b) => b.version === "v1"),
      "served v1",
    );
    assert.ok(
      bodies.some((b) => b.version === "v2"),
      "served v2",
    );
    const now = await viaCaddy(S.app.host);
    assert.equal(now.json.version, "v2");
    assert.equal(now.json.greeting, "hello-from-whoami v2");
    evidence("5. zero-downtime redeploys after a variable change", {
      swaps,
      requests: summary.total,
      failed: summary.failed,
      connection_resets: summary.resets.length,
      max_ms: summary.max_ms,
      versions_seen: [...new Set(bodies.map((b) => b.version))],
    });
  });

  step("6. rollback to the first deployment without a rebuild", async () => {
    const list = async () =>
      (await api.get(`/v1/services/${S.app.id}/deployments?environment_id=${S.envId}&limit=100`))
        .deployments;
    const buildsBefore = new Set((await list()).map((d) => d.build_id).filter(Boolean));
    const first = await api.get(`/v1/deployments/${S.app.v1}`);

    const d = await api.post(`/v1/deployments/${S.app.v1}/rollback`);
    S.deployments.add(d.id);
    S.app.rollback = d.id;
    S.app.active = d.id;
    log("step 6", `rollback deployment ${d.id}`);
    const active = await settle(d.id, ["active"], 5 * 60_000);
    assert.equal(active.rollback_of, S.app.v1);
    assert.equal(active.image, first.image, "same image digest as the first deployment");
    assert.equal(active.build_id, null, "no build for a rollback");
    const buildsAfter = new Set((await list()).map((x) => x.build_id).filter(Boolean));
    assert.deepEqual([...buildsAfter].sort(), [...buildsBefore].sort(), "no new build row");
    await settle(S.app.v2, ["rolled_back"], 30_000);

    const res = await waitFor(
      "the app to serve v1 again",
      async () => {
        const r = await viaCaddy(S.app.host);
        return r.json?.version === "v1" ? r : null;
      },
      { timeoutMs: 30_000 },
    );
    evidence("6. rollback to the first deployment without a rebuild", {
      deployment: d.id,
      image: active.image,
      greeting_after_rollback: res.json.greeting,
    });
    // Rollback reuses the image and config version but reads variables as
    // they are now (the dashboard's rollback dialog says so).
    assert.equal(res.json.greeting, "hello-from-whoami v2");
  });

  step("7a. failing build: failed with a readable reason, previous still serving", async () => {
    await patchService(S.app.id, {
      source: { type: "git", repo_url: repoUrl("broken"), branch: "main", root_dir: "." },
      build: { builder: "dockerfile" },
    });
    const d = await deploy(S.app.id, { commit_sha: stack.commits.broken });
    log("step 7a", `deployment ${d.id} builds a Dockerfile that exits 3`);
    const failed = await settle(d.id, ["failed"], 10 * 60_000);
    log("step 7a", `failure_reason: ${failed.failure_reason}`);
    assert.match(failed.failure_reason, /^Build failed: /);
    assert.match(failed.failure_reason, /exit code: 3|exit status 3|exited 3/);
    assert.equal(failed.build.status, "failed");
    const prev = await api.get(`/v1/deployments/${S.app.active}`);
    assert.equal(prev.status, "active");
    const res = await viaCaddy(S.app.host);
    assert.equal(res.json?.version, "v1", "previous deployment still serving");
    evidence("7a. failing build: failed with a readable reason, previous still serving", {
      deployment: d.id,
      failure_reason: failed.failure_reason,
    });
  });

  step(
    "7b. failing health check: failed after the rollout timeout, previous still serving",
    async () => {
      await patchService(S.whoami.id, { networking: { port: 8081 } });
      const started = Date.now();
      const d = await deploy(S.whoami.id);
      log("step 7b", `deployment ${d.id} probes port 8081; whoami listens on 80`);
      const failed = await settle(d.id, ["failed"], (ROLLOUT_TIMEOUT_S + 120) * 1000);
      const seconds = Math.round((Date.now() - started) / 1000);
      log("step 7b", `failed after ${seconds}s: ${failed.failure_reason}`);
      assert.match(failed.failure_reason, /did not become healthy/);
      assert.equal((await api.get(`/v1/deployments/${S.whoami.deploymentId}`)).status, "active");
      const res = await viaCaddy(S.whoami.host);
      assert.equal(res.status, 200, "previous whoami still serving");
      await waitFor(
        "the failed deployment's container to be removed",
        async () => (await containersWithLabel(`roundhouse.deployment_id=${d.id}`)).length === 0,
        { timeoutMs: 60_000 },
      );
      await patchService(S.whoami.id, { networking: { port: 80 } });
      evidence(
        "7b. failing health check: failed after the rollout timeout, previous still serving",
        {
          deployment: d.id,
          failure_reason: failed.failure_reason,
          seconds_to_failed: seconds,
          replica_states: failed.placements.map((p) => p.state),
        },
      );
    },
  );

  step("7c. cancel mid-build: cancelled", async () => {
    await patchService(S.app.id, {
      source: { type: "git", repo_url: repoUrl("slow"), branch: "main", root_dir: "." },
      build: { builder: "dockerfile" },
    });
    const d = await deploy(S.app.id, { commit_sha: stack.commits.slow });
    log("step 7c", `deployment ${d.id}: waiting until its build is running`);
    const building = await settle(d.id, ["building"], 120_000);
    await waitFor(
      "the slow build to start its RUN step",
      async () => {
        const page = await api.get(`/v1/builds/${building.build_id}/logs?limit=1000`);
        return page.lines.some((l) => l.text.includes("slow build started"));
      },
      { timeoutMs: 5 * 60_000, intervalMs: 1000 },
    );
    const cancelled = await api.post(`/v1/deployments/${d.id}/cancel`);
    assert.equal(cancelled.status, "cancelled");
    const after = await api.get(`/v1/deployments/${d.id}`);
    assert.equal(after.status, "cancelled");
    assert.equal(after.build.status, "cancelled");
    assert.deepEqual(after.placements, []);
    assert.equal((await viaCaddy(S.app.host)).json?.version, "v1", "previous still serving");
    S.app.cancelledBuild = building.build_id;
    evidence("7c. cancel mid-build: cancelled", { deployment: d.id, build: building.build_id });
  });

  step("7d. a cancelled build frees the builder for the next build", async () => {
    await patchService(S.app.id, {
      source: { type: "git", repo_url: repoUrl("app"), branch: "main", root_dir: "." },
      build: { builder: "railpack" },
    });
    const started = Date.now();
    const d = await deploy(S.app.id, { commit_sha: stack.commits.appV1 });
    log("step 7d", `deployment ${d.id} builds right after the cancelled one`);
    const building = await settle(d.id, ["building", "deploying", "active"], 60_000);
    await waitFor(
      "the new build to start on the builder",
      async () => {
        const b = (await api.get(`/v1/deployments/${d.id}`)).build;
        if (b?.status === "failed") assert.fail(`the next build was refused: ${b.error}`);
        const page = await api.get(`/v1/builds/${building.build_id}/logs?limit=1000`);
        return page.lines.some((l) => l.text.includes("Fetching")) ? true : null;
      },
      { timeoutMs: 120_000, intervalMs: 1000 },
    );
    const ps = await buildkitProcesses();
    assert.ok(!ps.includes("sleep 900"), `the cancelled build still runs in BuildKit:\n${ps}`);
    const cancelledLogs = await api.get(`/v1/builds/${S.app.cancelledBuild}/logs?limit=1000`);
    assert.ok(
      cancelledLogs.lines.some((l) => l.text.includes("Build was cancelled")),
      "the builder reported the cancelled build as cancelled",
    );
    await settle(d.id, ["active"], 5 * 60_000);
    // Later steps count the app's containers, so the replaced one must have
    // drained and gone first.
    const replaced = S.app.active;
    await waitFor(
      "the replaced deployment's container to drain and go",
      async () => (await containersWithLabel(`roundhouse.deployment_id=${replaced}`)).length === 0,
      { timeoutMs: 60_000 },
    );
    S.app.active = d.id;
    evidence("7d. a cancelled build frees the builder for the next build", {
      deployment: d.id,
      seconds_to_active: Math.round((Date.now() - started) / 1000),
    });
  });

  step("8. logs: stored with secrets redacted, and live over the realtime socket", async () => {
    const marker = `marker-${randomId(8)}`;
    await viaCaddy(S.app.host, `/?stored=${marker}`);
    const page = await waitFor(
      "the request's log line in stored logs",
      async () => {
        const p = await api.get(`/v1/deployments/${S.app.active}/logs?limit=1000`);
        return p.lines.some((l) => l.text.includes(marker)) ? p : null;
      },
      { timeoutMs: 60_000, intervalMs: 1000 },
    );
    const line = page.lines.find((l) => l.text.includes(marker));
    log("step 8", `stored: ${line.text}`);
    assert.ok(!page.lines.some((l) => l.text.includes(SECRET)), "secret value never stored");
    assert.match(line.text, /token=\[REDACTED\]/);
    assert.ok(line.workload_id, "runtime lines carry their replica");

    const ws = new WebSocket(
      `${stack.base.replace(/^http/, "ws")}/v1/projects/${S.projectId}/realtime`,
      {
        headers: { cookie: api.cookie, origin: stack.base },
      },
    );
    const received = [];
    ws.onmessage = (ev) => received.push(JSON.parse(ev.data));
    try {
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error("realtime socket failed to open"));
      });
      ws.send(
        JSON.stringify({
          type: "subscribe",
          topic: { kind: "deployment_logs", deployment_id: S.app.active },
        }),
      );
      const live = `live-${randomId(8)}`;
      // The subscription has no acknowledgement, so keep producing lines
      // until one arrives.
      const msg = await waitFor(
        "a live log line over the realtime socket",
        async () => {
          const hit = received.find(
            (m) => m.type === "log.lines" && m.lines.some((l) => l.text.includes(live)),
          );
          if (hit) return hit;
          await viaCaddy(S.app.host, `/?live=${live}`);
          return null;
        },
        { timeoutMs: 60_000, intervalMs: 1000 },
      );
      const liveLine = msg.lines.find((l) => l.text.includes(live));
      log("step 8", `live: ${liveLine.text}`);
      assert.equal(msg.source.deployment_id, S.app.active);
      assert.ok(!liveLine.text.includes(SECRET), "secret redacted in live lines");
      assert.match(liveLine.text, /token=\[REDACTED\]/);
    } finally {
      ws.close();
    }

    const foreign = new WebSocket(
      `${stack.base.replace(/^http/, "ws")}/v1/projects/${S.projectId}/realtime`,
      { headers: { cookie: api.cookie, origin: "http://evil.example" } },
    );
    const refused = await new Promise((resolve) => {
      foreign.onopen = () => resolve(false);
      foreign.onerror = () => resolve(true);
    });
    assert.ok(refused, "a cross-origin realtime upgrade is refused");
    evidence("8. logs: stored with secrets redacted, and live over the realtime socket", {
      stored_line: line.text,
      live_messages: received.length,
    });
  });

  step("9. agent restart: workloads keep serving and desired state is resent", async () => {
    const appBefore = await running(`roundhouse.service_id=${S.app.id}`);
    const whoamiBefore = await running(
      `roundhouse.service_id=${S.whoami.id}`,
      `roundhouse.environment_id=${S.envId}`,
    );
    assert.equal(appBefore.length, 1);
    assert.equal(whoamiBefore.length, 1);
    const stop = await startLoop(S.app.host);
    let summary;
    const since = new Date(Date.now() - 1000).toISOString();
    try {
      log("step 9", "restarting the agent container");
      await docker(["restart", "-t", "10", NAMES.agent]);
      await waitFor(
        "the restarted agent to receive desired state",
        async () => {
          const { stdout, stderr } = await docker(["logs", "--since", since, NAMES.agent]);
          const text = stdout + stderr;
          return text.includes("starting agent") && text.includes("received desired state");
        },
        { timeoutMs: 60_000 },
      );
      await waitFor(
        "the node to report online again",
        async () => {
          const { nodes } = await api.get(`/v1/workspaces/${S.workspaceId}/nodes`);
          return nodes[0]?.status === "online";
        },
        { timeoutMs: 60_000 },
      );
      // A couple more seconds of traffic after the first post-restart reconcile.
      const until = Date.now() + 5000;
      await waitFor("traffic after the reconcile", () => Date.now() > until, { timeoutMs: 10_000 });
    } finally {
      summary = await stop();
    }
    log(
      "step 9",
      `loop: ${summary.total} requests, ${summary.failed} failed, ${summary.resets.length} connection resets`,
    );
    assert.equal(summary.failed, 0, JSON.stringify(summary.failures));
    assert.equal(summary.resets.length, 0, JSON.stringify(summary.resets));
    assert.deepEqual(
      await running(`roundhouse.service_id=${S.app.id}`),
      appBefore,
      "app container kept",
    );
    assert.deepEqual(
      await running(`roundhouse.service_id=${S.whoami.id}`, `roundhouse.environment_id=${S.envId}`),
      whoamiBefore,
      "whoami container kept",
    );
    assert.equal((await api.get(`/v1/deployments/${S.app.active}`)).status, "active");
    evidence("9. agent restart: workloads keep serving and desired state is resent", {
      requests: summary.total,
      failed: summary.failed,
      connection_resets: summary.resets.length,
    });
  });

  step("10. delete a service: containers and route removed", async () => {
    assert.equal((await viaCaddy(S.whoami.host)).status, 200);
    await api.delete(`/v1/services/${S.whoami.id}`);
    log("step 10", "whoami deleted; waiting for its containers and route to go");
    await waitFor(
      "whoami's containers to be removed",
      async () => (await containersWithLabel(`roundhouse.service_id=${S.whoami.id}`)).length === 0,
      { timeoutMs: 60_000 },
    );
    const gone = await waitFor(
      "whoami's route to be removed",
      async () => {
        const r = await viaCaddy(S.whoami.host);
        return r.status === 404 ? r : null;
      },
      { timeoutMs: 30_000 },
    );
    assert.equal(gone.body, "no route\n");
    assert.equal((await viaCaddy(S.app.host)).status, 200, "other services unaffected");
  });

  step("11. TLS internal: HTTPS with Caddy's internal CA", async () => {
    const settings = await api.patch("/v1/instance/settings", { tls_mode: "internal" });
    assert.equal(settings.tls_mode, "internal");
    const res = await waitFor(
      `https://${S.app.host} with a certificate from Caddy's local CA`,
      async () => {
        const r = await viaCaddy(S.app.host, "/", { https: true });
        return r.status === 200 && r.tls?.authorized ? r : null;
      },
      { timeoutMs: 60_000, intervalMs: 1000 },
    );
    log("step 11", `TLS ${res.tls.protocol}, issuer ${res.tls.issuer}`);
    assert.equal(res.json.version, "v1");
    const domain = await domainOf(S.app.id);
    assert.equal(domain.url, `https://${S.app.host}`);
    const plain = await viaCaddy(S.app.host);
    assert.equal(plain.status, 308, "plain HTTP redirects to HTTPS");
    assert.equal(plain.headers.location, `https://${S.app.host}/`);
    evidence("11. TLS internal: HTTPS with Caddy's internal CA", {
      protocol: res.tls.protocol,
      issuer: res.tls.issuer,
    });
    writeArtifact("ui.json", { projectId: S.projectId, envId: S.envId, dataDir: DATA_DIR });
  });
});
