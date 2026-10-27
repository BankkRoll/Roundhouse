/**
 * Pull request previews end to end (ADR 0007, "Testing strategy"), against
 * the real stack `run-previews.mjs` starts, with this file serving the fake
 * GitHub the control plane calls:
 *
 * 1. setup, a builder node, the GitHub App through the manifest flow (the
 *    fake converts the code), and its installation claimed;
 * 2. a same-repository PR builds its head in its own `pr-7` environment,
 *    served through Caddy; one comment carries the URL and the commit
 *    status turns `success`; a push redeploys and edits the comment;
 *    merging tears it down (containers gone, comment updated);
 * 3. a fork's PR waits for approval: a read-only sender's label does
 *    nothing, a writer's builds it on the dedicated builder, and the running
 *    containers see every secret, and every value resolving through one,
 *    empty; a push takes the label off and waits again.
 *
 * Steps share state and stop at the first failure.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { deliver, INSTALLATION_ID, startFakeGithub } from "../lib/fake-github.mjs";
import { Api } from "../phase1/lib/api.mjs";
import {
  containersWithLabel,
  docker,
  GIT_PORT,
  IMAGES,
  joinNode,
  NAMES,
  probe,
  startAgent,
} from "../phase1/lib/stack.mjs";
import { isWindows, log, ROOT, run, waitFor } from "../phase1/lib/util.mjs";
import { enrollTwoFactor } from "../two-factor.mjs";

const stack = JSON.parse(readFileSync(process.env.PREVIEWS_STACK ?? "", "utf8"));
const api = new Api(stack.base);
const OWNER = {
  name: "Previews",
  email: "previews@example.com",
  password: "previews e2e password",
};
const APPS_DOMAIN = "127.0.0.1.nip.io";
const REPO_URL = `https://127.0.0.1:${GIT_PORT}/app.git`;
// Fake values only; nothing here is a credential.
const SECRET = "e2e-secret-value-not-real-0001";

/** @type {Awaited<ReturnType<typeof startFakeGithub>>} */
let github;
const S = { workspaceId: "", nodeId: "", shop: "", forked: "", forkedProd: "" };
let broken = false;

function step(name, fn) {
  it(name, async (t) => {
    if (broken) return t.skip("an earlier step failed");
    try {
      await fn(t);
    } catch (err) {
      broken = true;
      throw err;
    }
  });
}

let clock = Date.parse("2026-10-27T09:00:00Z");

/** A `pull_request` delivery of `acme/app`, from the repository itself or a fork. */
function pr({
  action = "opened",
  number,
  sha,
  fork = false,
  base = "main",
  label,
  sender,
  merged = false,
}) {
  clock += 1000;
  const repo = { full_name: "acme/app", clone_url: REPO_URL, fork: false };
  return {
    action,
    number,
    pull_request: {
      number,
      title: `PR ${number}`,
      updated_at: new Date(clock).toISOString(),
      draft: false,
      merged,
      user: { login: fork ? "mallory" : "ada", type: "User" },
      author_association: fork ? "NONE" : "MEMBER",
      head: {
        ref: fork ? "patch-1" : "feature",
        sha,
        repo: fork ? { full_name: "mallory/app", clone_url: REPO_URL, fork: true } : repo,
      },
      base: { ref: base, repo },
    },
    sender: { login: sender ?? (fork ? "mallory" : "ada"), type: "User" },
    ...(label ? { label: { name: label } } : {}),
    installation: { id: INSTALLATION_ID },
  };
}

async function previewOf(projectId, number) {
  const { previews } = await api.get(`/v1/projects/${projectId}/previews?status=all`);
  return previews.find((p) => p.pr_number === number);
}

function previewWhere(projectId, number, check, what, timeoutMs = 300_000) {
  return waitFor(
    what,
    async () => {
      const p = await previewOf(projectId, number);
      return p && check(p) ? p : null;
    },
    {
      timeoutMs,
      intervalMs: 2000,
      explain: async () => {
        const p = await previewOf(projectId, number);
        if (!p) return "no preview; GitHub saw " + JSON.stringify(github.requests.slice(-5));
        const deployments = [];
        for (const s of p.services) {
          if (!s.deployment_id) continue;
          const d = await api.get(`/v1/deployments/${s.deployment_id}`);
          deployments.push({
            service: s.slug,
            status: d.status,
            reason: d.failure_reason,
            events: d.events.slice(-6).map((e) => `${e.type}: ${e.message}`),
          });
        }
        return JSON.stringify({ status: p.status, error: p.error, deployments });
      },
    },
  );
}

/** Runs SQL against the control plane's local D1 (test setup GitHub's OAuth can't fake). */
async function sql(statement) {
  const dir = mkdtempSync(join(tmpdir(), "rh-previews-sql-"));
  const file = join(dir, "q.sql");
  writeFileSync(file, statement);
  try {
    await run(
      "npx",
      [
        "wrangler",
        "d1",
        "execute",
        "DB",
        "--local",
        "--persist-to",
        stack.state,
        "--file",
        file,
        "--yes",
      ],
      { cwd: join(ROOT, "apps", "api"), shell: isWindows, timeoutMs: 120_000 },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function gitRef(ref, sha) {
  await docker(["exec", NAMES.git, "git", "-C", "/srv/git/app.git", "update-ref", ref, sha]);
}

async function viaCaddy(url, path = "/") {
  const host = new URL(url).host;
  return probe(["get", host, path]);
}

before(async () => {
  github = await startFakeGithub({ port: stack.githubPort, repositories: ["acme/app"] });
});
after(async () => {
  await github?.close();
});

describe("PR previews on the real stack", () => {
  step("1. setup, a builder, and the GitHub App with its installation", async () => {
    const setup = await api.post("/v1/setup", {
      master_key: stack.masterKey,
      name: OWNER.name,
      email: OWNER.email,
      password: OWNER.password,
      workspace_name: "Previews",
    });
    S.workspaceId = setup.workspace_id;
    await enrollTwoFactor((path, body) => api.post(path, body), OWNER.password);
    await api.patch("/v1/instance/settings", { apps_domain: APPS_DOMAIN, tls_mode: "off" });

    const { token } = await api.post(`/v1/workspaces/${S.workspaceId}/nodes/join-tokens`);
    await joinNode({ url: stack.nodeUrl, token, insecure: stack.insecure });
    await startAgent();
    const node = await waitFor(
      "the node online as a builder",
      async () => {
        const { nodes } = await api.get(`/v1/workspaces/${S.workspaceId}/nodes`);
        return nodes[0]?.status === "online" && nodes[0].capabilities?.builder ? nodes[0] : null;
      },
      { timeoutMs: 120_000 },
    );
    S.nodeId = node.id;

    const manifest = await api.post("/v1/github/manifest", { workspace_id: S.workspaceId });
    const callback = await api.request(
      "GET",
      `/v1/github/callback?code=e2e-code&state=${encodeURIComponent(manifest.state)}`,
    );
    assert.equal(callback.status, 302, JSON.stringify(callback.body));
    const status = await api.get(`/v1/github/status?workspace_id=${S.workspaceId}`);
    assert.equal(status.configured, true);
    assert.equal(
      await deliver(stack.base, "installation", {
        action: "created",
        installation: {
          id: INSTALLATION_ID,
          account: { id: 9919, login: "acme", type: "Organization" },
        },
      }),
      202,
    );
    // GitHub's OAuth step of a claim can't be faked here; the claim itself is ordinary SQL.
    await sql(
      `UPDATE github_installations SET workspace_id = '${S.workspaceId}', claimed_at = 1 WHERE installation_id = ${INSTALLATION_ID};`,
    );
    await gitRef("refs/heads/release", stack.commits.appV1);
  });

  step("2. a same-repository PR gets its environment, URL, comment and status", async () => {
    const project = await api.post(`/v1/workspaces/${S.workspaceId}/projects`, { name: "Shop" });
    S.shop = project.id;
    const prodId = project.environments[0].id;
    const app = await api.post(`/v1/projects/${S.shop}/services`, {
      name: "app",
      source: { type: "git", repo_url: REPO_URL, branch: "main", root_dir: "." },
      config: { networking: { port: 3000, generated_domain: true } },
    });
    await api.put(`/v1/services/${app.service.id}/variables?environment_id=${prodId}`, {
      set: [{ key: "GREETING", value: "hello-from-preview" }],
    });
    await api.put(`/v1/projects/${S.shop}/preview-settings`, {
      enabled: true,
      base_environment_id: prodId,
      max_active: 2,
    });

    await gitRef("refs/pull/7/head", stack.commits.appV1);
    assert.equal(
      await deliver(stack.base, "pull_request", pr({ number: 7, sha: stack.commits.appV1 })),
      202,
    );
    const active = await previewWhere(
      S.shop,
      7,
      (p) => p.status === "active" && p.services.some((s) => s.status === "active" && s.url),
      "PR 7's preview to be active",
      // The first Railpack build after a teardown pulls images and starts cold.
      900_000,
    );
    assert.equal(active.environment_slug, "pr-7");
    const url = active.services.find((s) => s.slug === "app").url;
    const res = await viaCaddy(url);
    assert.equal(res.status, 200, JSON.stringify(res));
    const body = JSON.parse(res.body);
    assert.equal(body.version, "v1");
    assert.equal(body.greeting, "hello-from-preview");

    await waitFor(
      "a success commit status and the comment with the URL",
      async () =>
        github.statuses.some((s) => s.state === "success" && s.sha === stack.commits.appV1) &&
        github.comments.get("acme/app#7")?.[0]?.body.includes(url),
      { timeoutMs: 120_000 },
    );

    log("previews", "pushing a new commit to PR 7");
    await gitRef("refs/pull/7/head", stack.commits.appV2);
    await deliver(
      stack.base,
      "pull_request",
      pr({ action: "synchronize", number: 7, sha: stack.commits.appV2 }),
    );
    await waitFor(
      "PR 7 to serve v2",
      async () => {
        const r = await viaCaddy(url);
        return r.status === 200 && JSON.parse(r.body).version === "v2";
      },
      { timeoutMs: 480_000, intervalMs: 3000 },
    );
    assert.equal(
      github.comments.get("acme/app#7").length,
      1,
      "the comment is edited, not repeated",
    );

    log("previews", "merging PR 7");
    await deliver(
      stack.base,
      "pull_request",
      pr({ action: "closed", number: 7, sha: stack.commits.appV2, merged: true }),
    );
    await previewWhere(S.shop, 7, (p) => p.status === "closed", "PR 7 to close", 60_000);
    await waitFor(
      "PR 7's containers to go",
      async () =>
        (await containersWithLabel(`roundhouse.environment_id=${active.environment_id}`)).length ===
        0,
      { timeoutMs: 120_000 },
    );
    await waitFor(
      "the comment to say the preview was torn down",
      async () => github.comments.get("acme/app#7")[0].body.includes("torn down"),
      { timeoutMs: 60_000 },
    );
  });

  step(
    "3. a fork's PR builds only once a writer approves it, with every secret withheld",
    async () => {
      const project = await api.post(`/v1/workspaces/${S.workspaceId}/projects`, {
        name: "Forked",
      });
      S.forked = project.id;
      const prodId = project.environments[0].id;
      const whoami = await api.post(`/v1/projects/${S.forked}/services`, {
        name: "whoami",
        source: { type: "image", image: IMAGES.whoami },
        config: { networking: { port: 80, generated_domain: true } },
      });
      await api.post(`/v1/projects/${S.forked}/services`, {
        name: "app",
        source: { type: "git", repo_url: REPO_URL, branch: "release", root_dir: "." },
        config: { networking: { port: 3000, generated_domain: true } },
      });
      await api.put(`/v1/projects/${S.forked}/variables?environment_id=${prodId}`, {
        set: [{ key: "API_SECRET", value: SECRET, tier: "secret" }],
        confirm_write_only: true,
      });
      await api.put(`/v1/services/${whoami.service.id}/variables?environment_id=${prodId}`, {
        set: [
          { key: "DERIVED", value: "x-${{shared.API_SECRET}}" },
          { key: "PUBLIC_MARK", value: "visible-mark" },
        ],
      });
      await api.put(`/v1/workspaces/${S.workspaceId}/nodes/${S.nodeId}/labels`, {
        labels: { pool: "untrusted" },
      });
      await api.put(`/v1/projects/${S.forked}/preview-settings`, {
        enabled: true,
        base_environment_id: prodId,
        fork_policy: "approval",
        build_node_selector: { pool: "untrusted" },
      });

      await gitRef("refs/pull/8/head", stack.commits.appV2);
      await deliver(
        stack.base,
        "pull_request",
        pr({ number: 8, sha: stack.commits.appV2, fork: true, base: "release" }),
      );
      await previewWhere(
        S.forked,
        8,
        (p) => p.status === "pending_approval",
        "PR 8 to wait for approval",
        60_000,
      );

      github.permissions.set("rita", "read");
      await deliver(
        stack.base,
        "pull_request",
        pr({
          action: "labeled",
          number: 8,
          sha: stack.commits.appV2,
          fork: true,
          base: "release",
          label: "roundhouse:preview",
          sender: "rita",
        }),
      );
      await new Promise((r) => setTimeout(r, 5000));
      assert.equal((await previewOf(S.forked, 8)).status, "pending_approval");

      github.permissions.set("wes", "write");
      await deliver(
        stack.base,
        "pull_request",
        pr({
          action: "labeled",
          number: 8,
          sha: stack.commits.appV2,
          fork: true,
          base: "release",
          label: "roundhouse:preview",
          sender: "wes",
        }),
      );
      const active = await previewWhere(
        S.forked,
        8,
        (p) =>
          p.status === "active" &&
          p.services.length >= 2 &&
          p.services.every((s) => s.status === "active"),
        "PR 8's preview to be active",
        480_000,
      );
      assert.equal(active.withheld, true);
      const whoamiUrl = active.services.find((s) => s.slug === "whoami").url;
      const env = await viaCaddy(whoamiUrl, "/?env=true");
      assert.equal(env.status, 200);
      assert.ok(!env.body.includes(SECRET), "no secret reaches a fork preview");
      assert.match(env.body, /PUBLIC_MARK=visible-mark/);
      assert.match(env.body, /DERIVED=\s*$/m);

      log("previews", "a new commit on the fork");
      github.labels.set("acme/app#8", new Set(["roundhouse:preview"]));
      await deliver(
        stack.base,
        "pull_request",
        pr({
          action: "synchronize",
          number: 8,
          sha: stack.commits.appV1,
          fork: true,
          base: "release",
        }),
      );
      await previewWhere(
        S.forked,
        8,
        (p) => p.status === "pending_approval",
        "PR 8 to wait again",
        60_000,
      );
      await waitFor(
        "the approval label to come off",
        async () => !github.labels.get("acme/app#8").has("roundhouse:preview"),
        { timeoutMs: 60_000 },
      );
    },
  );
});
