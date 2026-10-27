/**
 * The Cloudflare Containers provider (ADR 0011) against the in-process fake
 * Cloudflare API (`./fake-cloudflare.ts`): settings, eligibility at apply,
 * the deploy workflow's Cloudflare branch (push → script → application →
 * rollout → warm → routes → drain), rollback, switching back, the minute
 * tick's deletion, `image_push_result` handling, `RuntimeEnv.resolveEnv`
 * and `tail()`.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { createDb } from "@roundhouse/db";
import {
  type ControlMessage,
  type ImagePush,
  imagePushAad,
  type JoinResponse,
  openBox,
} from "@roundhouse/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onImagePushResult } from "../src/durable/node/handlers/image-push";
import { setCloudflareApiTransport } from "../src/lib/cloudflare/client";
import { cloudflareScriptName } from "../src/lib/cloudflare/naming";
import { mintRuntimeToken } from "../src/lib/cloudflare/runtime-token";
import { MINUTE_CLAIMERS, runMinuteTick } from "../src/lib/dispatch";
import { resolveRuntimeEnv, storeRuntimeTail } from "../src/runtime-env";
import { FakeCloudflare } from "./fake-cloudflare-containers";
import {
  addMember,
  type Client,
  eventually,
  install,
  joinNode,
  NODE_ENCRYPTION_PRIVATE_KEY,
} from "./helpers";
import {
  COMMIT_SHA,
  connectWorkloadAgent,
  createProject,
  createService,
  type DeploymentBody,
  deploy,
  type FakeWorkloadAgent,
  GIT_SERVICE,
  IMAGE_DIGEST,
  IMAGE_SERVICE,
  settleDeployments,
  waitForStatus,
} from "./pipeline-helpers";

const PUSHED_DIGEST = `sha256:${"b".repeat(64)}`;
const SECRET = "sk-live-cloudflare-runtime-0123456789";

let fake: FakeCloudflare;
let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
let pushTimers: ReturnType<typeof setInterval>[] = [];

beforeEach(async () => {
  fake = new FakeCloudflare();
  setCloudflareApiTransport(fake.fetch);
  introspector = await introspectWorkflow(env.DEPLOY_WORKFLOW);
  // Drains (≥ 30 s) and poll intervals would make every test take minutes.
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
  });
});

afterEach(async () => {
  for (const t of pushTimers) clearInterval(t);
  pushTimers = [];
  await settleDeployments();
  await introspector?.dispose();
  introspector = undefined;
  setCloudflareApiTransport(null);
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const db = () => createDb(env.DB);

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: { field: string; code: string; message: string }[];
  };
}

/** Sets the apps domain and connects the fake account. */
async function connectCloudflare(owner: Client, proxied = true) {
  const apps = await owner.json("/v1/instance/settings", {
    method: "PATCH",
    json: { apps_domain: "apps.example.com" },
  });
  expect(apps.status).toBe(200);
  const res = await owner.json<Record<string, unknown>>("/v1/instance/cloudflare", {
    method: "PUT",
    json: { account_id: fake.accountId, api_token: fake.token, apps_domain_proxied: proxied },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

const CF_PLACEMENT = {
  provider: "cloudflare",
  cloudflare: { max_instances: 3, sleep_after: "10m" },
};

/** PATCHes a service's config (the direct route). */
function patchConfig(c: Client, serviceId: string, envId: string, patch: Record<string, unknown>) {
  return c.json<ErrorBody & { config: { version: number } }>(`/v1/services/${serviceId}`, {
    method: "PATCH",
    json: { environment_id: envId, ...patch },
  });
}

interface CfStage {
  owner: Client;
  workspaceId: string;
  projectId: string;
  envId: string;
  serviceId: string;
  scriptName: string;
  joined: JoinResponse;
  agent: FakeWorkloadAgent;
}

/**
 * An installed control plane with the fake account connected, a builder at
 * `protocol` and a service with a generated hostname, switched to
 * Cloudflare unless `provider` is `nodes`.
 */
async function cfStage(
  options: {
    service?: Record<string, unknown>;
    protocol?: number;
    provider?: "nodes" | "cloudflare";
    variables?: { key: string; value: string; tier?: string }[];
  } = {},
): Promise<CfStage> {
  const { owner, workspaceId } = await install();
  await connectCloudflare(owner);
  const joined = await joinNode(owner, workspaceId);
  const agent = await connectWorkloadAgent(joined, {}, { protocol_version: options.protocol ?? 7 });
  const project = await createProject(owner, workspaceId);
  const envId = project.environments[0]!.id;
  const created = await createService(owner, project.id, {
    ...(options.service ?? IMAGE_SERVICE),
    config: { networking: { port: 8080, generated_domain: true } },
  });
  const serviceId = created.service.id;
  if (options.variables) {
    const res = await owner.json(`/v1/services/${serviceId}/variables?environment_id=${envId}`, {
      method: "PUT",
      json: { set: options.variables, confirm_write_only: true },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  if ((options.provider ?? "cloudflare") === "cloudflare") {
    const res = await patchConfig(owner, serviceId, envId, { placement: CF_PLACEMENT });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  answerPushes(agent);
  return {
    owner,
    workspaceId,
    projectId: project.id,
    envId,
    serviceId,
    scriptName: await cloudflareScriptName(serviceId, envId),
    joined,
    agent,
  };
}

const isPush = (m: ControlMessage): m is ImagePush => m.type === "image_push";

/** Answers every `image_push` the agent receives with a successful result. */
function answerPushes(agent: FakeWorkloadAgent) {
  const answered = new Set<string>();
  pushTimers.push(
    setInterval(() => {
      for (const m of agent.received.filter(isPush)) {
        if (answered.has(m.push_id)) continue;
        answered.add(m.push_id);
        agent.send({
          type: "image_push_result",
          push_id: m.push_id,
          ok: true,
          digest: PUSHED_DIGEST,
          bytes: 1234,
        });
      }
    }, 20),
  );
}

async function detail(c: Client, id: string) {
  return (await c.json<DeploymentBody>(`/v1/deployments/${id}`)).body;
}

/** Index of the first logged call matching `pattern`, after `from`. */
function indexOf(pattern: RegExp, from = 0): number {
  const calls = fake.calls();
  for (let i = from; i < calls.length; i++) if (pattern.test(calls[i]!)) return i;
  return -1;
}

async function auditRows(action: string) {
  const { results } = await env.DB.prepare(
    "SELECT action, metadata FROM audit_logs WHERE action = ? ORDER BY seq",
  )
    .bind(action)
    .all<{ action: string; metadata: string | null }>();
  return results;
}

async function runtimeRow(serviceId: string, envId: string) {
  return env.DB.prepare("SELECT * FROM cf_runtimes WHERE service_id = ? AND environment_id = ?")
    .bind(serviceId, envId)
    .first<{
      script_name: string;
      generation: number;
      status: string;
      application_id: string | null;
      route_ids: string;
      delete_after: number | null;
      active_deployment_id: string | null;
    }>();
}

// -----------------------------------------------------------------------------
// Settings
// -----------------------------------------------------------------------------

describe("settings", () => {
  it("connects an account, never returns the token, and verifies it", async () => {
    const { owner } = await install();
    const before = await owner.json<Record<string, unknown>>("/v1/instance/cloudflare");
    expect(before.body).toMatchObject({ configured: false, account_id: null, token_hint: null });

    const saved = await connectCloudflare(owner);
    expect(saved).toMatchObject({
      configured: true,
      account_id: fake.accountId,
      workers_subdomain: fake.subdomain,
      apps_domain_proxied: true,
      apps_zone: "example.com",
      token_hint: fake.token.slice(-4),
      image_storage_bytes: null,
    });
    expect(JSON.stringify(saved)).not.toContain(fake.token);
    const got = await owner.json("/v1/instance/cloudflare");
    expect(JSON.stringify(got.body)).not.toContain(fake.token);
    const stored = await env.DB.prepare(
      "SELECT value FROM instance_settings WHERE key = 'cloudflare_account'",
    ).first<{ value: string }>();
    expect(stored!.value).not.toContain(fake.token);
    const audits = await auditRows("instance.settings_updated");
    expect(audits.at(-1)!.metadata).toContain("cloudflare_account");
    for (const a of audits) expect(a.metadata ?? "").not.toContain(fake.token);

    const verified = await owner.json<{ ok: boolean; checks: { name: string; ok: boolean }[] }>(
      "/v1/instance/cloudflare/verify",
      { method: "POST" },
    );
    expect(verified.status).toBe(200);
    expect(verified.body.ok).toBe(true);
    expect(verified.body.checks.map((c) => c.name)).toEqual([
      "token",
      "workers_scripts",
      "containers",
      "workers_subdomain",
      "registry",
      "apps_zone",
      "apps_domain_proxied",
    ]);
  });

  it("refuses a token Cloudflare rejects, naming Cloudflare's error", async () => {
    const { owner } = await install();
    const res = await owner.json<ErrorBody>("/v1/instance/cloudflare", {
      method: "PUT",
      json: { account_id: fake.accountId, api_token: "wrong-token-0000000000000000" },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("cloudflare_account_invalid");
    expect(res.body.error.message).toContain("Authentication error");
    expect(
      (await owner.json<{ configured: boolean }>("/v1/instance/cloudflare")).body.configured,
    ).toBe(false);
  });

  it("is for instance admins on a fresh browser session only", async () => {
    const { owner, workspaceId } = await install();
    const admin = await addMember(owner, workspaceId, "ada@example.com", "admin");
    expect((await admin.json("/v1/instance/cloudflare")).status).toBe(403);
    expect(
      (
        await admin.json("/v1/instance/cloudflare", {
          method: "PUT",
          json: { account_id: fake.accountId, api_token: fake.token },
        })
      ).status,
    ).toBe(403);
    await env.DB.prepare("UPDATE sessions SET created_at = ?, reauthenticated_at = NULL")
      .bind(Date.now() - 24 * 60 * 60 * 1000)
      .run();
    const stale = await owner.json<ErrorBody>("/v1/instance/cloudflare", {
      method: "PUT",
      json: { account_id: fake.accountId, api_token: fake.token },
    });
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe("reauth_required");
  });

  it("refuses to disconnect while a service runs on Cloudflare", async () => {
    const s = await cfStage();
    const d = await deploy(s.owner, s.serviceId, s.envId);
    expect((await waitForStatus(s.owner, d.id, ["active", "failed"])).status).toBe("active");
    const refused = await s.owner.json<ErrorBody>("/v1/instance/cloudflare", { method: "DELETE" });
    expect(refused.status).toBe(409);
    await env.DB.prepare("UPDATE cf_runtimes SET status = 'disabled'").run();
    const removed = await s.owner.json<{ configured: boolean }>("/v1/instance/cloudflare", {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(removed.body.configured).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Eligibility
// -----------------------------------------------------------------------------

describe("eligibility", () => {
  async function plain(configured = true) {
    const { owner, workspaceId } = await install();
    if (configured) await connectCloudflare(owner);
    const project = await createProject(owner, workspaceId);
    const envId = project.environments[0]!.id;
    const created = await createService(owner, project.id, IMAGE_SERVICE);
    return { owner, workspaceId, projectId: project.id, envId, serviceId: created.service.id };
  }

  async function expectRule(res: { status: number; body: ErrorBody }, rule: string) {
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error.code).toBe("provider_ineligible");
    expect(res.body.error.details!.map((d) => d.code)).toContain(rule);
  }

  it("refuses when the provider is not configured", async () => {
    const s = await plain(false);
    await expectRule(
      await patchConfig(s.owner, s.serviceId, s.envId, { placement: CF_PLACEMENT }),
      "not_configured",
    );
  });

  it("refuses services without a port, too large for any instance type, or not apps", async () => {
    const s = await plain();
    await expectRule(
      await patchConfig(s.owner, s.serviceId, s.envId, {
        placement: CF_PLACEMENT,
        networking: { port: null, generated_domain: false },
      }),
      "port",
    );
    await expectRule(
      await patchConfig(s.owner, s.serviceId, s.envId, {
        placement: CF_PLACEMENT,
        resources: { cpu_millis: 8000, memory_mb: 512 },
      }),
      "resources",
    );
    await expectRule(
      await patchConfig(s.owner, s.serviceId, s.envId, {
        placement: {
          ...CF_PLACEMENT,
          cloudflare: { ...CF_PLACEMENT.cloudflare, instance_type: "lite" },
        },
      }),
      "resources",
    );
    await env.DB.prepare("UPDATE services SET kind = 'database' WHERE id = ?")
      .bind(s.serviceId)
      .run();
    await expectRule(
      await patchConfig(s.owner, s.serviceId, s.envId, { placement: CF_PLACEMENT }),
      "kind",
    );
  });

  it("refuses a TCP proxy and a direct-mode custom domain", async () => {
    const s = await plain();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO domains (id, service_id, environment_id, hostname, type, target_port, mode, created_at, updated_at)
       VALUES ('dom_direct1', ?, ?, 'shop.customer.test', 'custom', 8080, 'direct', ?, ?)`,
    )
      .bind(s.serviceId, s.envId, now, now)
      .run();
    await expectRule(
      await patchConfig(s.owner, s.serviceId, s.envId, { placement: CF_PLACEMENT }),
      "domains",
    );
    await env.DB.prepare(
      "UPDATE domains SET mode = 'cloudflare_saas' WHERE id = 'dom_direct1'",
    ).run();
    expect(
      (await patchConfig(s.owner, s.serviceId, s.envId, { placement: CF_PLACEMENT })).status,
    ).toBe(200);

    await env.DB.prepare(
      `INSERT INTO tcp_proxies (id, project_id, service_id, environment_id, container_port, public_port, allowed_cidrs, created_at, updated_at)
       VALUES ('tcp_1', ?, ?, ?, 8080, 30001, '["0.0.0.0/0"]', ?, ?)`,
    )
      .bind(s.projectId, s.serviceId, s.envId, now, now)
      .run();
    await expectRule(
      await patchConfig(s.owner, s.serviceId, s.envId, {
        resources: { cpu_millis: 250, memory_mb: 256 },
      }),
      "tcp_proxy",
    );
  });

  it("refuses a staged volume at apply, and audits a provider switch", async () => {
    const s = await plain();
    const stage = (op: Record<string, unknown>) =>
      s.owner.json<{ id: string; revision: number }>(`/v1/environments/${s.envId}/draft/ops`, {
        method: "POST",
        json: { op },
      });
    await stage({ type: "config.patch", service: s.serviceId, patch: { placement: CF_PLACEMENT } });
    const withVolume = await stage({
      type: "volume.set",
      service: s.serviceId,
      mount_path: "/data",
      size_mb: 1024,
    });
    expect(withVolume.status, JSON.stringify(withVolume.body)).toBe(200);
    const refused = await s.owner.json<ErrorBody>(`/v1/change-sets/${withVolume.body.id}/apply`, {
      method: "POST",
      json: { expected_revision: withVolume.body.revision, deploy: "none" },
    });
    await expectRule(refused, "volume");

    const set = await s.owner.json<{ id: string; revision: number; changes: { id: string }[] }>(
      `/v1/change-sets/${withVolume.body.id}`,
    );
    const volumeOp = set.body.changes[1]!.id;
    const unstaged = await s.owner.json<{ revision: number }>(
      `/v1/change-sets/${withVolume.body.id}/ops/${volumeOp}?expected_revision=${set.body.revision}`,
      { method: "DELETE" },
    );
    expect(unstaged.status, JSON.stringify(unstaged.body)).toBe(200);
    const applied = await s.owner.json(`/v1/change-sets/${withVolume.body.id}/apply`, {
      method: "POST",
      json: { expected_revision: unstaged.body.revision, deploy: "none" },
    });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const audits = await auditRows("service.provider_changed");
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]!.metadata!)).toMatchObject({ from: "nodes", to: "cloudflare" });
  });
});

// -----------------------------------------------------------------------------
// Deploys
// -----------------------------------------------------------------------------

describe("deploy", () => {
  it("pushes a git build, then uploads, creates, warms and routes in order", async () => {
    const s = await cfStage({ service: GIT_SERVICE });
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    const done = await waitForStatus(s.owner, d.id, ["active", "failed"]);
    expect(done.failure_reason).toBeNull();
    expect(done.status).toBe("active");

    const order = [
      /^POST .*\/containers\/registries\/registry\.cloudflare\.com\/credentials$/,
      /^PUT .*\/workers\/scripts\/rh-/,
      /^POST .*\/workers\/scripts\/rh-[^/]+\/subdomain$/,
      /^POST .*\/containers\/applications$/,
      /^GET rh-.*\.workers\.dev\//,
      /^GET \/zones\/[^/]+\/workers\/routes$/,
      /^POST \/zones\/[^/]+\/workers\/routes$/,
    ];
    let at = 0;
    for (const step of order) {
      const i = indexOf(step, at);
      expect(i, `${step} after ${at}: ${fake.calls().join("\n")}`).toBeGreaterThanOrEqual(at);
      at = i + 1;
    }
    expect(indexOf(/\/rollouts$/)).toBe(-1);

    // The builder got a sealed, short-lived push to the deployment's tag.
    const push = s.agent.received.find(isPush)!;
    const repo = `127.0.0.1:5000/${s.projectId.toLowerCase()}/${s.serviceId.toLowerCase()}`;
    expect(push).toMatchObject({
      source: `${repo}@${IMAGE_DIGEST}`,
      target: `registry.cloudflare.com/${fake.accountId}/${s.scriptName}:${d.id.toLowerCase()}`,
      platform: "linux/amd64",
    });
    expect(push.exp - push.iat).toBeLessThanOrEqual(60_000);
    const login = JSON.parse(
      new TextDecoder().decode(
        await openBox(
          NODE_ENCRYPTION_PRIVATE_KEY,
          push.credential_sealed,
          "image-push",
          imagePushAad(s.joined.node_id, push.push_id),
        ),
      ),
    );
    expect(login).toEqual({ username: "v1", password: "reg-push-secret" });
    expect(JSON.stringify(s.agent.frames)).not.toContain("reg-push-secret");

    const upload = fake.log.find((r) => r.method === "PUT")!.body as Record<string, unknown>;
    expect(upload).toMatchObject({
      main_module: "runtime.worker.js",
      migrations: { new_sqlite_classes: ["AppContainer"] },
      tail_consumers: [{ service: "roundhouse" }],
    });
    const app = [...fake.applications.values()][0]!;
    expect(app).toMatchObject({
      name: s.scriptName,
      max_instances: 3,
      configuration: { image: push.target, instance_type: "standard-2" },
    });
    expect(fake.routes).toHaveLength(1);
    expect(fake.routes[0]!.pattern).toMatch(/\.apps\.example\.com\/\*$/);
    expect(fake.routes[0]!.script).toBe(s.scriptName);

    const events = (await detail(s.owner, d.id)).events!.map((e) => e.type);
    for (const t of ["image_pushed", "cf_rollout_started", "routes_switched", "rollout_finished"]) {
      expect(events).toContain(t);
    }
    expect((await detail(s.owner, d.id)).placements).toEqual([]);
    const runtime = (await runtimeRow(s.serviceId, s.envId))!;
    expect(runtime).toMatchObject({ status: "active", generation: 1, active_deployment_id: d.id });
    const status = await s.owner.json<{
      provider: string;
      runtime: { routes: string[]; instances: { total: number; running: number } };
      deployments: { status: string; image_digest: string }[];
    }>(`/v1/services/${s.serviceId}/cloudflare?environment_id=${s.envId}`);
    expect(status.body.provider).toBe("cloudflare");
    expect(status.body.runtime.routes).toHaveLength(1);
    expect(status.body.runtime.instances).toEqual({ total: 2, running: 1 });
    expect(status.body.deployments[0]).toMatchObject({
      status: "active",
      image_digest: PUSHED_DIGEST,
    });
  });

  it("references an image source directly, without image_push, and drains the node replicas", async () => {
    const s = await cfStage({ provider: "nodes" });
    const onNodes = await deploy(s.owner, s.serviceId, s.envId);
    expect((await waitForStatus(s.owner, onNodes.id, ["active", "failed"])).status).toBe("active");
    expect(s.agent.desired()!.workloads).toHaveLength(1);

    expect(
      (await patchConfig(s.owner, s.serviceId, s.envId, { placement: CF_PLACEMENT })).status,
    ).toBe(200);
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const done = await waitForStatus(s.owner, d.id, ["active", "failed"]);
    expect(done.failure_reason).toBeNull();
    expect(indexOf(/credentials$/)).toBe(-1);
    expect(s.agent.received.some(isPush)).toBe(false);
    expect([...fake.applications.values()][0]!.configuration.image).toBe(
      "docker.io/library/nginx:1.27",
    );
    expect((await detail(s.owner, onNodes.id)).status).toBe("removed");
    await eventually(async () => (s.agent.desired()!.workloads.length === 0 ? true : undefined));
  });

  it("rolls out a second deploy under a new generation; only the new token resolves", async () => {
    const s = await cfStage({ variables: [{ key: "API_KEY", value: SECRET, tier: "secret" }] });
    const first = await deploy(s.owner, s.serviceId, s.envId);
    expect((await waitForStatus(s.owner, first.id, ["active", "failed"])).status).toBe("active");
    const oldToken = fake.runtimeToken(s.scriptName);

    const second = await deploy(s.owner, s.serviceId, s.envId);
    const done = await waitForStatus(s.owner, second.id, ["active", "failed"]);
    expect(done.failure_reason).toBeNull();
    expect(fake.applications.size).toBe(1);
    expect(indexOf(/\/rollouts$/)).toBeGreaterThan(0);
    expect(fake.config(s.scriptName)).toMatchObject({ generation: 2, deployment_id: second.id });
    expect(fake.log.filter((r) => r.method === "PUT")[1]!.body).not.toHaveProperty("migrations");

    await expect(resolveRuntimeEnv(env, oldToken)).rejects.toThrow("runtime token refused");
    const resolved = await resolveRuntimeEnv(env, fake.runtimeToken(s.scriptName));
    expect(resolved.deployment_id).toBe(second.id);
    expect(resolved.env).toMatchObject({ API_KEY: SECRET, PORT: "8080" });
  });

  it("rolls back to an earlier Cloudflare deployment with its tag and no push", async () => {
    const s = await cfStage({ service: GIT_SERVICE });
    const first = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    expect((await waitForStatus(s.owner, first.id, ["active", "failed"])).status).toBe("active");
    const second = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    expect((await waitForStatus(s.owner, second.id, ["active", "failed"])).status).toBe("active");
    const pushes = s.agent.received.filter(isPush).length;
    const credentials = fake.log.filter((r) => /credentials$/.test(r.path)).length;

    const res = await s.owner.json<DeploymentBody>(`/v1/deployments/${first.id}/rollback`, {
      method: "POST",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const done = await waitForStatus(s.owner, res.body.id, ["active", "failed"]);
    expect(done.failure_reason).toBeNull();
    expect(s.agent.received.filter(isPush)).toHaveLength(pushes);
    expect(fake.log.filter((r) => /credentials$/.test(r.path)).length).toBe(credentials);
    const lastRollout = fake.log.filter((r) => /\/rollouts$/.test(r.path)).at(-1)!;
    expect(lastRollout.body).toMatchObject({
      target_configuration: {
        image: `registry.cloudflare.com/${fake.accountId}/${s.scriptName}:${first.id.toLowerCase()}`,
      },
    });
  });

  it("fails with builder_outdated when the builder can't push", async () => {
    const s = await cfStage({ service: GIT_SERVICE, protocol: 6 });
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    const done = await waitForStatus(s.owner, d.id, ["active", "failed"]);
    expect(done.status).toBe("failed");
    expect(done.failure_reason).toMatch(/^builder_outdated: /);
    expect(s.agent.received.some(isPush)).toBe(false);
  });

  it("names Cloudflare's error verbatim on the deployment", async () => {
    const s = await cfStage();
    const message = "Image docker.io/library/nginx:1.27 is not linux/amd64 (manifest unknown)";
    fake.failNext("POST", /\/containers\/applications$/, 400, message, 1009);
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const done = await waitForStatus(s.owner, d.id, ["active", "failed"]);
    expect(done.status).toBe("failed");
    expect(done.failure_reason).toContain(message);
    const row = await env.DB.prepare(
      "SELECT status, error FROM cf_deployments WHERE deployment_id = ?",
    )
      .bind(d.id)
      .first<{ status: string; error: string }>();
    expect(row!.status).toBe("failed");
    expect(row!.error).toContain(message);
    expect(row!.error).not.toContain(fake.token);
    expect(fake.routes).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Switching back and deletion
// -----------------------------------------------------------------------------

describe("switch back", () => {
  it("deletes routes only after node replicas are healthy, then stops and later deletes", async () => {
    const s = await cfStage();
    const cf = await deploy(s.owner, s.serviceId, s.envId);
    expect((await waitForStatus(s.owner, cf.id, ["active", "failed"])).status).toBe("active");
    expect(fake.routes).toHaveLength(1);

    expect(
      (await patchConfig(s.owner, s.serviceId, s.envId, { placement: { provider: "nodes" } }))
        .status,
    ).toBe(200);
    let atRouteDelete: { status: string; states: string[] } | null = null;
    let nodeDeployment = "";
    fake.onRequest = async (r) => {
      if (r.method === "DELETE" && /\/workers\/routes\//.test(r.path) && !atRouteDelete) {
        const states = await env.DB.prepare("SELECT state FROM placements WHERE deployment_id = ?")
          .bind(nodeDeployment)
          .all<{ state: string }>();
        const dep = await env.DB.prepare("SELECT status FROM deployments WHERE id = ?")
          .bind(nodeDeployment)
          .first<{ status: string }>();
        atRouteDelete = { status: dep!.status, states: states.results.map((x) => x.state) };
      }
    };
    const back = await deploy(s.owner, s.serviceId, s.envId);
    nodeDeployment = back.id;
    expect((await waitForStatus(s.owner, back.id, ["active", "failed"])).status).toBe("active");
    const runtime = await eventually(async () => {
      const row = await runtimeRow(s.serviceId, s.envId);
      return row?.status === "disabled" ? row : undefined;
    });
    expect(atRouteDelete).toEqual({ status: "active", states: ["healthy"] });
    expect(fake.routes).toHaveLength(0);
    expect([...fake.applications.values()][0]!.max_instances).toBe(0);
    expect(runtime.delete_after).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);
    expect(runtime.generation).toBe(2);
    expect(JSON.parse(runtime.route_ids)).toEqual({});

    const claimer = MINUTE_CLAIMERS.filter((c) => c.name === "cloudflare_deletions");
    expect(await runMinuteTick(env, Date.now(), claimer)).toEqual({ cloudflare_deletions: 0 });
    expect(fake.scripts.has(s.scriptName)).toBe(true);
    expect(await runMinuteTick(env, Date.now() + 25 * 60 * 60 * 1000, claimer)).toEqual({
      cloudflare_deletions: 1,
    });
    expect(fake.scripts.has(s.scriptName)).toBe(false);
    expect(fake.applications.size).toBe(0);
    expect(await runtimeRow(s.serviceId, s.envId)).toBeNull();
  });
});

describe("replicas 0", () => {
  it("stops serving on Cloudflare without deleting anything", async () => {
    const s = await cfStage();
    const d = await deploy(s.owner, s.serviceId, s.envId);
    expect((await waitForStatus(s.owner, d.id, ["active", "failed"])).status).toBe("active");
    const res = await patchConfig(s.owner, s.serviceId, s.envId, { deploy: { replicas: 0 } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const runtime = (await runtimeRow(s.serviceId, s.envId))!;
    expect(runtime).toMatchObject({ status: "disabled", delete_after: null, generation: 2 });
    expect(fake.routes).toHaveLength(0);
    expect([...fake.applications.values()][0]!.max_instances).toBe(0);
    expect(fake.scripts.has(s.scriptName)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Image push results, runtime tokens, tail
// -----------------------------------------------------------------------------

describe("image_push_result", () => {
  it("records a result only from the node the push was sent to, once", async () => {
    const s = await cfStage();
    const d = await deploy(s.owner, s.serviceId, s.envId);
    await waitForStatus(s.owner, d.id, ["active", "failed"]);
    const cfd = await env.DB.prepare("SELECT id FROM cf_deployments WHERE deployment_id = ?")
      .bind(d.id)
      .first<{ id: string }>();
    await env.DB.prepare(
      "UPDATE cf_deployments SET status = 'pushing', image_digest = NULL, push_id = 'psh_x1', push_node_id = ? WHERE id = ?",
    )
      .bind(s.joined.node_id, cfd!.id)
      .run();
    const frame = {
      type: "image_push_result",
      push_id: "psh_x1",
      ok: true,
      digest: PUSHED_DIGEST,
    } as const;
    expect(await onImagePushResult(db(), env, "node_other", frame)).toBe(false);
    expect(await onImagePushResult(db(), env, s.joined.node_id, frame)).toBe(true);
    expect(await onImagePushResult(db(), env, s.joined.node_id, frame)).toBe(false);
    const failed = await onImagePushResult(db(), env, s.joined.node_id, {
      type: "image_push_result",
      push_id: "psh_x1",
      ok: false,
      error: "denied",
    });
    expect(failed).toBe(false);
  });

  it("files the push's task log lines under the deployment's build, and drops others", async () => {
    const s = await cfStage({ service: GIT_SERVICE });
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    await waitForStatus(s.owner, d.id, ["active", "failed"]);
    const push = s.agent.received.find(isPush)!;
    const build = await env.DB.prepare("SELECT id FROM builds WHERE deployment_id = ?")
      .bind(d.id)
      .first<{ id: string }>();
    const task = (taskId: string, text: string) => ({
      type: "logs",
      source: { type: "task", task_id: taskId },
      lines: [{ ts: Date.now(), stream: "stdout", text }],
    });
    s.agent.send(task(push.push_id, "pushed 3 layers to registry.cloudflare.com"));
    s.agent.send(task("psh_someone_else", "not ours"));
    s.agent.send(task("bak_01JZZZZZZZZZZZZZZZZZZZZZZZ", "a backup line"));
    const node = env.NODE_CONNECTION.get(env.NODE_CONNECTION.idFromName(s.joined.node_id));
    await eventually(async () => {
      await node.flushLogs();
      const row = await env.DB.prepare(
        "SELECT sum(line_count) AS n FROM log_chunks WHERE build_id = ?",
      )
        .bind(build!.id)
        .first<{ n: number | null }>();
      return row?.n ? true : undefined;
    });
    const keys = await env.DB.prepare("SELECT r2_key FROM log_chunks WHERE build_id = ?")
      .bind(build!.id)
      .all<{ r2_key: string }>();
    const text = (
      await Promise.all(keys.results.map(async (k) => (await env.LOGS.get(k.r2_key))!.text()))
    ).join("");
    expect(text).toContain("pushed 3 layers");
    expect(text).not.toContain("not ours");
    expect(text).not.toContain("a backup line");
  });
});

describe("RuntimeEnv.resolveEnv", () => {
  it("rejects forged, malformed and other-service tokens", async () => {
    const s = await cfStage();
    const d = await deploy(s.owner, s.serviceId, s.envId);
    expect((await waitForStatus(s.owner, d.id, ["active", "failed"])).status).toBe("active");
    const good = fake.runtimeToken(s.scriptName);
    expect((await resolveRuntimeEnv(env, good)).deployment_id).toBe(d.id);
    const parts = good.split(".");
    const forged = [...parts.slice(0, 4), `${parts[4]!.slice(0, -2)}AA`].join(".");
    for (const bad of [forged, "", "rht1.x", 42, `${parts.slice(0, 3).join(".")}.9.${parts[4]}`]) {
      await expect(resolveRuntimeEnv(env, bad)).rejects.toThrow("runtime token refused");
    }
    const future = await mintRuntimeToken(env, {
      serviceId: s.serviceId,
      environmentId: s.envId,
      generation: 5,
    });
    await expect(resolveRuntimeEnv(env, future)).rejects.toThrow("runtime token refused");
    await env.DB.prepare("UPDATE cf_runtimes SET status = 'disabled'").run();
    await expect(resolveRuntimeEnv(env, good)).rejects.toThrow("runtime token refused");
  });
});

describe("tail", () => {
  it("stores runtime console output and exceptions as redacted system lines", async () => {
    const s = await cfStage({ variables: [{ key: "API_KEY", value: SECRET, tier: "secret" }] });
    const d = await deploy(s.owner, s.serviceId, s.envId);
    expect((await waitForStatus(s.owner, d.id, ["active", "failed"])).status).toBe("active");
    const now = Date.now();
    const stored = await storeRuntimeTail(env, [
      {
        scriptName: s.scriptName,
        logs: [{ timestamp: now, level: "log", message: ["[roundhouse] started with", SECRET] }],
        exceptions: [{ timestamp: now + 1, name: "Error", message: "boom" }],
      },
      {
        scriptName: "someone-elses-worker",
        logs: [{ timestamp: now, level: "log", message: ["x"] }],
        exceptions: [],
      },
    ]);
    expect(stored).toBe(2);
    const logs = await s.owner.json<{ lines: { stream: string; text: string }[] }>(
      `/v1/deployments/${d.id}/logs`,
    );
    expect(logs.status).toBe(200);
    expect(logs.body.lines.map((l) => l.stream)).toEqual(["system", "system"]);
    expect(logs.body.lines[0]!.text).toContain("started with");
    expect(logs.body.lines[0]!.text).not.toContain(SECRET);
    expect(logs.body.lines[1]!.text).toBe("[exception] Error: boom");
  });
});
