/**
 * The WireGuard mesh end to end (ADR 0005), at the API level, against the
 * real stack `run.mjs` starts: `wrangler dev` and two nodes, each with its
 * own Docker engine, Caddy and the real agent.
 *
 * Steps run in order and share state; once one fails the rest are skipped.
 * Evidence goes to `.artifacts/evidence.json`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { Api } from "../../phase1/lib/api.mjs";
import { log, waitFor } from "../../phase1/lib/util.mjs";
import { enrollTwoFactor } from "../../two-factor.mjs";
import {
  BUSYBOX,
  d1,
  docker,
  inNode,
  joinNode,
  NAMES,
  nodeContainers,
  startAgent,
  writeArtifact,
} from "./lib/stack.mjs";

const stack = JSON.parse(readFileSync(process.env.PHASE3_STACK ?? "", "utf8"));
const api = new Api(stack.base);
const [N1, N2] = NAMES.nodes;
const OWNER = {
  name: "Phase Three",
  email: "phase3@example.com",
  password: "phase three e2e password",
};
const APPS_DOMAIN = "mesh.e2e.test";

/** Shared across steps. */
const S = {
  workspaceId: "",
  projectId: "",
  projectSlug: "",
  prodId: "",
  stagingId: "",
  /** Node IDs by container name. */
  nodeIds: /** @type {Record<string, string>} */ ({}),
  services: /** @type {Record<string, { id: string, deploymentId: string, host?: string }>} */ ({}),
};
const E = {};
let broken = false;

function step(name, fn) {
  it(name, async (t) => {
    if (broken) return t.skip("an earlier step failed");
    const started = Date.now();
    try {
      await fn(t);
      E[name] = { ...(E[name] ?? {}), seconds: Math.round((Date.now() - started) / 1000) };
    } catch (err) {
      broken = true;
      E[name] = { ...(E[name] ?? {}), failed: err.message };
      throw err;
    } finally {
      writeArtifact("evidence.json", E);
    }
  });
}

const TERMINAL = ["active", "failed", "cancelled", "removed", "rolled_back", "crashed"];

async function settle(id, timeoutMs = 240_000) {
  return waitFor(
    `deployment ${id} to be active`,
    async () => {
      const d = await api.get(`/v1/deployments/${id}`);
      if (d.status === "active") return d;
      if (TERMINAL.includes(d.status)) {
        assert.fail(
          `deployment ${id} is ${d.status}: ${d.failure_reason ?? ""}\n` +
            d.events.map((e) => `  ${e.type}: ${e.message}`).join("\n"),
        );
      }
      return null;
    },
    { timeoutMs, intervalMs: 1000 },
  );
}

/**
 * Creates a busybox web service that answers `name` on :8080, pinned to a
 * node by label, and deploys it.
 */
async function webService(name, envId, node) {
  let id = S.services[name]?.id;
  if (!id) {
    const created = await api.post(`/v1/projects/${S.projectId}/services`, {
      name,
      source: { type: "image", image: BUSYBOX },
    });
    id = created.service.id;
  }
  await api.patch(`/v1/services/${id}`, {
    environment_id: envId,
    ...{
      networking: { port: 8080, generated_domain: true },
      deploy: {
        start_command: `mkdir -p /www && echo ${name}-${envId.slice(-6)} > /www/index.html && exec httpd -f -p 8080 -h /www`,
      },
      healthcheck: {
        type: "tcp",
        port: 8080,
        interval_s: 1,
        timeout_s: 2,
        retries: 3,
        start_period_s: 0,
      },
      placement: { node_selector: { "e2e.node": node.replace("roundhouse-e2e3-", "") } },
    },
  });
  const d = await api.post(`/v1/services/${id}/deployments?environment_id=${envId}`, {});
  await settle(d.id);
  S.services[`${name}:${envId}`] = { id, deploymentId: d.id };
  S.services[name] = { id, deploymentId: d.id };
  return { id, deploymentId: d.id };
}

/** The running container of a deployment inside a node's engine. */
async function containerOf(node, deploymentId) {
  return waitFor(
    `the container of ${deploymentId} on ${node}`,
    async () => (await nodeContainers(node, `roundhouse.deployment_id=${deploymentId}`))[0] ?? null,
    { timeoutMs: 60_000 },
  );
}

/** Runs `wget` inside a container of a node; returns the body or `null`. */
async function wgetFrom(node, container, url) {
  const r = await inNode(node, `docker exec ${container} wget -q -T 4 -O - ${url}`, {
    allowFail: true,
  });
  return r.code === 0 ? r.stdout.trim() : null;
}

after(() => writeArtifact("evidence.json", E));

describe("the WireGuard mesh on a real two-node stack", () => {
  step("1. setup, two-factor, ingress and mesh settings", async () => {
    const setup = await api.post("/v1/setup", {
      master_key: stack.masterKey,
      name: OWNER.name,
      email: OWNER.email,
      password: OWNER.password,
      workspace_name: "Phase Three",
    });
    S.workspaceId = setup.workspace_id;
    const { codes } = await enrollTwoFactor((path, body) => api.post(path, body), OWNER.password);
    await api.post("/api/auth/sign-out", {});
    api.cookies.clear();
    await api.post("/api/auth/sign-in/email", { email: OWNER.email, password: OWNER.password });
    await api.post("/api/auth/two-factor/verify-totp", { code: await codes.next() });
    const settings = await api.patch("/v1/instance/settings", {
      apps_domain: APPS_DOMAIN,
      tls_mode: "off",
      mesh_enabled: true,
    });
    assert.equal(settings.mesh_enabled, true);
    assert.equal(settings.mesh_supernet, "10.200.0.0/16");
  });

  step("2. both nodes join, come online and form a direct tunnel", async () => {
    for (const node of NAMES.nodes) {
      const { token } = await api.post(`/v1/workspaces/${S.workspaceId}/nodes/join-tokens`);
      const out = await joinNode({
        node,
        url: stack.nodeUrl,
        token,
        ip: stack.ips[node],
        builder: node === N1,
      });
      assert.match(out, /joined control plane/);
      await startAgent(node);
    }
    const nodes = await waitFor(
      "both nodes online",
      async () => {
        const { nodes } = await api.get(`/v1/workspaces/${S.workspaceId}/nodes`);
        return nodes.length === 2 && nodes.every((n) => n.status === "online") ? nodes : null;
      },
      { timeoutMs: 120_000 },
    );
    for (const n of nodes) S.nodeIds[`roundhouse-e2e3-${n.name}`] = n.id;
    for (const [node, id] of Object.entries(S.nodeIds)) {
      const label = node.replace("roundhouse-e2e3-", "");
      await d1(
        stack.state,
        `UPDATE nodes SET labels = '{"e2e.node":"${label}"}' WHERE id = '${id}'`,
      );
    }
    const mesh = await waitFor(
      "both nodes mesh-ready with a recent handshake",
      async () => {
        const m = await api.get(`/v1/workspaces/${S.workspaceId}/mesh`);
        const pair = m.pairs[0];
        const ready = m.nodes.filter((n) => n.ready).length === 2;
        return ready && pair?.path === "direct" && pair.last_handshake_at ? m : null;
      },
      { timeoutMs: 180_000, intervalMs: 2000 },
    );
    E["2. both nodes join, come online and form a direct tunnel"] = {
      nodes: mesh.nodes.map((n) => ({ name: n.name, address: n.address, mode: n.mode })),
      pair: mesh.pairs[0],
    };
    log(
      "step 2",
      `mesh ready: ${mesh.nodes.map((n) => `${n.name}=${n.address}/${n.mode}`).join(", ")}`,
    );
  });

  step("3. an app on one node reaches a service on the other by private name", async () => {
    const project = await api.post(`/v1/workspaces/${S.workspaceId}/projects`, { name: "Mesh" });
    S.projectId = project.id;
    S.projectSlug = project.slug;
    S.prodId = project.environments.find((e) => e.slug === "production").id;
    await webService("api", S.prodId, N2);
    const web = await webService("web", S.prodId, N1);
    const container = await containerOf(N1, web.deploymentId);
    const name = `api.production.${S.projectSlug}.internal`;
    const body = await waitFor(
      `${name} from web on n1`,
      () => wgetFrom(N1, container, `http://${name}:8080/`),
      { timeoutMs: 60_000, intervalMs: 1000 },
    );
    assert.match(body, /^api-/);
    // The Phase 1 three-label form is answered too.
    assert.match(
      (await wgetFrom(N1, container, "http://api.production.internal:8080/")) ?? "",
      /^api-/,
    );
  });

  step("4. ingress on the node without a replica serves the app over the mesh", async () => {
    const { domains } = await api.get(
      `/v1/services/${S.services.web.id}/domains?environment_id=${S.prodId}`,
    );
    const host = domains[0].hostname;
    S.services.web.host = host;
    const body = await waitFor(
      `${host} through n2's Caddy`,
      async () => {
        const r = await inNode(N2, `curl -fsS -m 5 -H "Host: ${host}" http://127.0.0.1/`, {
          allowFail: true,
        });
        return r.code === 0 ? r.stdout.trim() : null;
      },
      { timeoutMs: 90_000, intervalMs: 1000 },
    );
    assert.match(body, /^web-/);
    const routing = await api.get(
      `/v1/services/${S.services.web.id}/domains?environment_id=${S.prodId}`,
    );
    E["4. ingress on the node without a replica serves the app over the mesh"] = { host, routing };
  });

  step("5. staging spread over both nodes cannot reach production by name or IP", async () => {
    const staging = await api.post(`/v1/projects/${S.projectId}/environments`, {
      name: "staging",
      kind: "staging",
    });
    S.stagingId = staging.id;
    // Staging: its own api on n2 and web on n1, so it spans both nodes too.
    await webService("api", S.stagingId, N2);
    const web = await webService("web", S.stagingId, N1);
    const container = await containerOf(N1, web.deploymentId);
    // Its own environment works across nodes...
    const own = await waitFor(
      "staging's own api from staging web",
      () => wgetFrom(N1, container, `http://api.staging.${S.projectSlug}.internal:8080/`),
      { timeoutMs: 60_000, intervalMs: 1000 },
    );
    assert.match(own, /^api-/);
    // ...production's name doesn't resolve...
    const lookup = await inNode(
      N1,
      `docker exec ${container} nslookup api.production.${S.projectSlug}.internal`,
      { allowFail: true },
    );
    assert.doesNotMatch(lookup.stdout, /Address:\s*10\.200\./, "production name must not resolve");
    // ...and production's mesh IP is unreachable.
    const [row] = await d1(
      stack.state,
      `SELECT p.mesh_ip FROM placements p JOIN deployments d ON d.id = p.deployment_id
       WHERE d.id = '${S.services[`api:${S.prodId}`].deploymentId}'`,
    );
    assert.match(row.mesh_ip, /^10\.200\.\d+\.\d+$/);
    const direct = await wgetFrom(N1, container, `http://${row.mesh_ip}:8080/`);
    assert.equal(direct, null, `staging reached production at ${row.mesh_ip}`);
    E["5. staging spread over both nodes cannot reach production by name or IP"] = {
      production_api_mesh_ip: row.mesh_ip,
      nslookup: lookup.stdout,
    };
  });
  step(
    "6. drain moves the app to the other node with no failed requests through ingress",
    async () => {
      // The pinned services above can't move; drain a fresh, unpinned project.
      await api.delete(`/v1/projects/${S.projectId}`);
      const project = await api.post(`/v1/workspaces/${S.workspaceId}/projects`, {
        name: "Movers",
      });
      const envId = project.environments.find((e) => e.slug === "production").id;
      const created = await api.post(`/v1/projects/${project.id}/services`, {
        name: "mover",
        source: { type: "image", image: BUSYBOX },
      });
      const id = created.service.id;
      await api.patch(`/v1/services/${id}`, {
        environment_id: envId,
        ...{
          networking: { port: 8080, generated_domain: true },
          deploy: {
            replicas: 2,
            drain_s: 2,
            start_command:
              "mkdir -p /www && hostname > /www/index.html && exec httpd -f -p 8080 -h /www",
          },
          healthcheck: {
            type: "tcp",
            port: 8080,
            interval_s: 1,
            timeout_s: 2,
            retries: 3,
            start_period_s: 0,
          },
        },
      });
      const d = await api.post(`/v1/services/${id}/deployments?environment_id=${envId}`, {});
      const active = await settle(d.id);
      const nodesOf = (dep) => new Set(dep.placements.map((p) => p.node_id));
      assert.equal(nodesOf(active).size, 2, "the two replicas spread over both nodes");
      const { domains } = await api.get(`/v1/services/${id}/domains?environment_id=${envId}`);
      const host = domains[0].hostname;
      await waitFor(
        `${host} through n2`,
        async () =>
          (
            await inNode(N2, `curl -fsS -m 3 -H "Host: ${host}" http://127.0.0.1/`, {
              allowFail: true,
            })
          ).code === 0 || null,
        { timeoutMs: 60_000 },
      );

      await inNode(N2, "rm -f /tmp/stop /tmp/loop.out");
      await docker([
        "exec",
        "-d",
        N2,
        "sh",
        "-c",
        `i=0; f=0; while [ ! -f /tmp/stop ]; do curl -fsS -m 3 -H "Host: ${host}" http://127.0.0.1/ >/dev/null 2>&1 || f=$((f+1)); i=$((i+1)); sleep 0.2; done; echo "$i $f" > /tmp/loop.out`,
      ]);
      const n1 = S.nodeIds[N1];
      const drain = await api.post(`/v1/workspaces/${S.workspaceId}/nodes/${n1}/drain`, {});
      assert.ok(["running", "completed"].includes(drain.status));
      const done = await waitFor(
        "the drain to finish",
        async () => {
          const { drain: now } = await api.get(`/v1/workspaces/${S.workspaceId}/nodes/${n1}/drain`);
          if (now.status === "failed" || now.status === "blocked") {
            assert.fail(`drain ${now.status}: ${now.error ?? ""} ${JSON.stringify(now.moves)}`);
          }
          return now.status === "completed" ? now : null;
        },
        { timeoutMs: 240_000, intervalMs: 2000 },
      );
      await inNode(N2, "touch /tmp/stop");
      const loop = await waitFor(
        "the request loop to stop",
        async () => {
          const r = await inNode(N2, "cat /tmp/loop.out", { allowFail: true });
          return r.code === 0 && r.stdout.trim() ? r.stdout.trim().split(" ").map(Number) : null;
        },
        { timeoutMs: 30_000 },
      );
      const node = await api.get(`/v1/workspaces/${S.workspaceId}/nodes/${n1}`);
      assert.equal(node.status, "maintenance");
      const after = await api.get(`/v1/deployments/${d.id}`);
      assert.deepEqual([...nodesOf(after)], [S.nodeIds[N2]], "every replica now runs on n2");
      E["6. drain moves the app to the other node with no failed requests through ingress"] = {
        moves: done.moves,
        requests: loop[0],
        failed: loop[1],
      };
      assert.ok(loop[0] > 10, `the loop ran (${loop[0]} requests)`);
      assert.equal(loop[1], 0, `${loop[1]} of ${loop[0]} requests failed during the drain`);
      S.services.mover = { id, deploymentId: d.id, host };
    },
  );

  step(
    "7. a silent node's stateless replicas are rescheduled, and its stale ones removed when it returns",
    async () => {
      const [n1, n2] = [S.nodeIds[N1], S.nodeIds[N2]];
      await api.post(`/v1/workspaces/${S.workspaceId}/nodes/${n1}/resume`);
      // Silence n2's agent; its containers keep running, as after a crash.
      await inNode(N2, "pkill -f '^roundhouse-agent run' || true");
      const moved = await waitFor(
        "the replicas to be rescheduled onto n1",
        async () => {
          const dep = await api.get(`/v1/deployments/${S.services.mover.deploymentId}`);
          const live = dep.placements.filter((p) => p.state === "healthy");
          return live.length >= 2 && live.every((p) => p.node_id === n1) ? dep : null;
        },
        { timeoutMs: 360_000, intervalMs: 5000 },
      );
      E[
        "7. a silent node's stateless replicas are rescheduled, and its stale ones removed when it returns"
      ] = { placements: moved.placements };
      const before = await nodeContainers(
        N2,
        `roundhouse.deployment_id=${S.services.mover.deploymentId}`,
      );
      assert.ok(before.length > 0, "n2 still runs its stale replicas while silent");
      await startAgent(N2);
      await waitFor(
        "n2 to remove its stale replicas",
        async () =>
          (await nodeContainers(N2, `roundhouse.deployment_id=${S.services.mover.deploymentId}`))
            .length === 0 || null,
        { timeoutMs: 120_000, intervalMs: 2000 },
      );
      const node = await api.get(`/v1/workspaces/${S.workspaceId}/nodes/${n2}`);
      assert.equal(node.status, "online");
    },
  );
});
