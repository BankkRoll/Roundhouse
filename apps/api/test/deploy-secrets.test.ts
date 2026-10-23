/**
 * What a deployment freezes about its secrets (ADR 0014 "Builds",
 * "Redaction", "Node sealing"): `env_sealed` under the v2 AAD with
 * `mount_as_file` values split into `files`, `secret_keys` including
 * secret-derived plain variables, and `build_env_sealed` whose secrets reach
 * the build only sealed to the builder node.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { createDb } from "@roundhouse/db";
import { MIN_PROTOCOL_VERSION } from "@roundhouse/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Sealed, sealWith, unsealWith } from "../src/lib/crypto";
import { openDeploymentEnv, refreshNodes } from "../src/lib/desired-state";
import { deploymentBuildAadV2, deploymentEnvAadV2 } from "../src/lib/keyring";
import { deploymentEnvAad, projectKey } from "../src/lib/variables";
import { eventually, install, joinNode } from "./helpers";
import {
  COMMIT_SHA,
  connectWorkloadAgent,
  createProject,
  createService,
  deploy,
  GIT_SERVICE,
  isDesired,
  type Stage,
  settleDeployments,
  stage,
  waitForStatus,
} from "./pipeline-helpers";

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
beforeEach(async () => {
  introspector = await introspectWorkflow(env.DEPLOY_WORKFLOW);
});
afterEach(async () => {
  await settleDeployments();
  await introspector?.dispose();
});

/** A format 1 value as stored before ADR 0014: `{ v: 1, iv, ct }`, no kid. */
async function sealV1(key: CryptoKey, plaintext: string, aad: string): Promise<Sealed> {
  const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { v: 1, iv: b64(iv), ct: b64(ct) };
}

interface Frozen {
  env_sealed: string | null;
  secret_keys: string | null;
  build_env_sealed: string | null;
}

async function frozen(deploymentId: string) {
  const row = await env.DB.prepare(
    "SELECT env_sealed, secret_keys, build_env_sealed FROM deployments WHERE id = ?",
  )
    .bind(deploymentId)
    .first<Frozen>();
  return {
    envSealed: row?.env_sealed ? (JSON.parse(row.env_sealed) as Sealed) : null,
    secretKeys: row?.secret_keys ? (JSON.parse(row.secret_keys) as string[]) : null,
    buildEnvSealed: row?.build_env_sealed ? (JSON.parse(row.build_env_sealed) as Sealed) : null,
  };
}

function putVariables(s: Stage, set: Record<string, unknown>[], serviceId = s.serviceId) {
  return s.owner.json(`/v1/services/${serviceId}/variables?environment_id=${s.envId}`, {
    method: "PUT",
    json: { set, confirm_write_only: true },
  });
}

describe("deployment env", () => {
  it("seals env and files under the v2 AAD and freezes secret and secret-derived keys", async () => {
    const s = await stage();
    const put = await putVariables(s, [
      { key: "API_KEY", value: "sk-live-0123456789", tier: "secret" },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: `${{…}}` is variable-reference syntax, not a template.
      { key: "DB_URL", value: "pg://app:${{API_KEY}}@db", tier: "plain" },
      { key: "GREETING", value: "hello", tier: "plain" },
      { key: "TLS_KEY", value: "-----tls-key-material-----", tier: "secret", mount_as_file: true },
    ]);
    expect(put.status).toBe(200);
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const active = await waitForStatus(s.owner, d.id, ["active", "failed"]);
    expect(active.failure_reason).toBeNull();

    const workload = s.agent.desired()!.workloads.find((w) => w.deployment_id === d.id)!;
    expect(s.agent.env(workload.id)).toMatchObject({
      API_KEY: "sk-live-0123456789",
      DB_URL: "pg://app:sk-live-0123456789@db",
      GREETING: "hello",
    });
    expect(s.agent.env(workload.id)).not.toHaveProperty("TLS_KEY");
    expect(s.agent.files(workload.id)).toEqual({ TLS_KEY: "-----tls-key-material-----" });
    expect(s.agent.rejected).toEqual([]);

    const row = await frozen(d.id);
    expect(row.secretKeys).toEqual(["API_KEY", "DB_URL", "TLS_KEY"]);
    expect(row.buildEnvSealed).toBeNull(); // image sources build nothing
    const key = await projectKey(createDb(env.DB), env, s.project.id);
    const opened = JSON.parse(
      await unsealWith(key, row.envSealed!, deploymentEnvAadV2(s.workspaceId, s.project.id, d.id)),
    );
    expect(opened.files).toEqual({ TLS_KEY: "-----tls-key-material-----" });
    expect(opened.env.GREETING).toBe("hello");
    await expect(unsealWith(key, row.envSealed!, deploymentEnvAad(d.id))).rejects.toThrow();
  });

  it("still runs a deployment whose env was sealed before ADR 0014", async () => {
    const s = await stage();
    await putVariables(s, [{ key: "LEGACY", value: "from-v1", tier: "plain" }]);
    const d = await deploy(s.owner, s.serviceId, s.envId);
    const active = await waitForStatus(s.owner, d.id, ["active"]);
    const db = createDb(env.DB);
    const key = await projectKey(db, env, s.project.id);
    // The pre-0014 shape: a flat map under `deployment-env:<id>`, no secret_keys.
    const legacy = await sealV1(
      key,
      JSON.stringify({ LEGACY: "from-v1", PORT: "8080" }),
      deploymentEnvAad(d.id),
    );
    await env.DB.prepare("UPDATE deployments SET env_sealed = ?, secret_keys = NULL WHERE id = ?")
      .bind(JSON.stringify(legacy), d.id)
      .run();
    const before = s.agent.received.filter(isDesired).length;
    await refreshNodes(env, db, [s.joined.node_id]);
    await eventually(async () =>
      s.agent.received.filter(isDesired).length > before ? true : undefined,
    );
    const workloadId = active.placements![0]!.workload_id;
    expect(s.agent.env(workloadId)).toEqual({ LEGACY: "from-v1", PORT: "8080" });
    expect(s.agent.files(workloadId)).toEqual({});
    expect(s.agent.rejected).toEqual([]);
  });
});

describe("deployment env AAD", () => {
  it("opens format 2 only under the v2 AAD and format 1 only under the old one", async () => {
    const s = await stage();
    const key = await projectKey(createDb(env.DB), env, s.project.id);
    const ref = { workspaceId: s.workspaceId, projectId: s.project.id, deploymentId: "dep_x" };
    const body = JSON.stringify({ env: { A: "1" }, files: {} });
    const v2 = deploymentEnvAadV2(ref.workspaceId, ref.projectId, ref.deploymentId);
    const v1 = deploymentEnvAad(ref.deploymentId);
    expect(await openDeploymentEnv(key, await sealWith(key, body, v2), ref)).toEqual({
      env: { A: "1" },
      files: {},
    });
    // A v2 value must not open under the short AAD that lacks workspace and project.
    await expect(openDeploymentEnv(key, await sealWith(key, body, v1), ref)).rejects.toThrow();
    await expect(openDeploymentEnv(key, await sealV1(key, body, v2), ref)).rejects.toThrow();
    expect(
      await openDeploymentEnv(key, await sealV1(key, JSON.stringify({ A: "1" }), v1), ref),
    ).toEqual({ env: { A: "1" }, files: {} });
    // Bound to its project: the same deployment ID under another project does not open.
    await expect(
      openDeploymentEnv(key, await sealWith(key, body, v2), { ...ref, projectId: "prj_other" }),
    ).rejects.toThrow();
  });
});

describe("build inputs", () => {
  const BUILD_SERVICE = {
    ...GIT_SERVICE,
    config: {
      build: {
        builder: "dockerfile",
        build_args: { NODE_ENV: "production", NPM_TOKEN: "npm_marked_secret" },
        secret_build_args: ["NPM_TOKEN"],
      },
    },
  };

  it("sends available_at_build secrets only sealed to the builder, plain ones as build args", async () => {
    const s = await stage(BUILD_SERVICE);
    const put = await putVariables(s, [
      {
        key: "SENTRY_TOKEN",
        value: "sntry-0123456789abcdef",
        tier: "secret",
        available_at_build: true,
      },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: `${{…}}` is variable-reference syntax, not a template.
      { key: "SENTRY_URL", value: "https://${{SENTRY_TOKEN}}@sentry.example", tier: "plain" },
      { key: "APP_VERSION", value: "1.2.3", tier: "plain", available_at_build: true },
      // A configured build arg of the same name wins over the variable.
      { key: "NODE_ENV", value: "development", tier: "plain", available_at_build: true },
      { key: "RUNTIME_ONLY", value: "rt-0123456789-secret", tier: "secret" },
    ]);
    expect(put.status).toBe(200);
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    const active = await waitForStatus(s.owner, d.id, ["active", "failed"]);
    expect(active.failure_reason).toBeNull();

    const job = s.agent.received.find((m) => m.type === "build_job")!;
    expect(job.build_args).toEqual({
      APP_VERSION: "1.2.3",
      NODE_ENV: "production",
      NPM_TOKEN: "npm_marked_secret",
    });
    expect(job.secret_build_args).toEqual(["NPM_TOKEN"]);
    expect(job.exp - job.iat).toBeLessThanOrEqual(60_000);
    expect(s.agent.buildSecrets(job.build_id)).toEqual({ SENTRY_TOKEN: "sntry-0123456789abcdef" });
    const plain = JSON.stringify(job);
    expect(plain).not.toContain("sntry-0123456789abcdef");
    expect(plain).not.toContain("rt-0123456789-secret");
    expect(s.agent.rejected).toEqual([]);

    const row = await frozen(d.id);
    const key = await projectKey(createDb(env.DB), env, s.project.id);
    const inputs = JSON.parse(
      await unsealWith(
        key,
        row.buildEnvSealed!,
        deploymentBuildAadV2(s.workspaceId, s.project.id, d.id),
      ),
    );
    expect(inputs).toEqual({
      args: job.build_args,
      secrets: s.agent.buildSecrets(job.build_id),
      secret_args: ["NPM_TOKEN"],
    });
    expect(row.secretKeys).toEqual(["RUNTIME_ONLY", "SENTRY_TOKEN", "SENTRY_URL"]);
  });

  it("sends no sealed secrets when the build uses none", async () => {
    const s = await stage(GIT_SERVICE);
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    await waitForStatus(s.owner, d.id, ["active"]);
    const job = s.agent.received.find((m) => m.type === "build_job")!;
    expect(job.build_secrets_sealed).toBeUndefined();
  });

  it("fails a build arg that came to reach a secret unless it is marked secret", async () => {
    const s = await stage();
    const db = await createService(s.owner, s.project.id, {
      name: "db",
      source: { type: "image", image: "postgres:17" },
    });
    await putVariables(
      s,
      [{ key: "PASSWORD", value: "pg-0123456789-later", tier: "plain" }],
      db.service.id,
    );
    const api = await createService(s.owner, s.project.id, {
      ...GIT_SERVICE,
      config: {
        build: {
          builder: "dockerfile",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: `${{…}}` is variable-reference syntax, not a template.
          build_args: { DB_PASSWORD: "${{db.PASSWORD}}", MARKED: "${{db.PASSWORD}}" },
          secret_build_args: ["MARKED"],
        },
      },
    });
    // The save checked the args against a plain value; it became secret later.
    await putVariables(s, [{ key: "PASSWORD", tier: "secret" }], db.service.id);
    const d = await deploy(s.owner, api.service.id, s.envId, { commit_sha: COMMIT_SHA });
    const failed = await waitForStatus(s.owner, d.id, ["failed"]);
    expect(failed.failure_reason).toBe(
      "Build arg DB_PASSWORD references a secret; make it a secret variable with available_at_build and read it with RUN --mount=type=secret,id=DB_PASSWORD",
    );
    expect(s.agent.received.some((m) => m.type === "build_job")).toBe(false);
  });

  it("fails a plain available_at_build variable that came to reach a secret", async () => {
    const s = await stage();
    const db = await createService(s.owner, s.project.id, {
      name: "db",
      source: { type: "image", image: "postgres:17" },
    });
    const api = await createService(s.owner, s.project.id, { ...GIT_SERVICE });
    await putVariables(
      s,
      [{ key: "PASSWORD", value: "pg-0123456789-later", tier: "plain" }],
      db.service.id,
    );
    const put = await putVariables(
      s,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: `${{…}}` is variable-reference syntax, not a template.
      [{ key: "DB_PW", value: "${{db.PASSWORD}}", tier: "plain", available_at_build: true }],
      api.service.id,
    );
    expect(put.status).toBe(200);
    // Plain → secret needs no value; the reference above now reaches a secret.
    await putVariables(s, [{ key: "PASSWORD", tier: "secret" }], db.service.id);
    const d = await deploy(s.owner, api.service.id, s.envId, { commit_sha: COMMIT_SHA });
    const failed = await waitForStatus(s.owner, d.id, ["failed"]);
    expect(failed.failure_reason).toMatch(
      /^Variable DB_PW references a secret; make it a secret variable/,
    );
  });
});

describe("builder choice", () => {
  it("never builds on a keyless or pre-sealing builder node", async () => {
    const { owner, workspaceId } = await install();
    const keyless = await joinNode(owner, workspaceId, {
      name: "keyless-builder",
      encryption_public_key: undefined,
    });
    const keylessAgent = await connectWorkloadAgent(keyless);
    const old = await joinNode(owner, workspaceId, { name: "old-builder" });
    const oldAgent = await connectWorkloadAgent(
      old,
      {},
      { protocol_version: MIN_PROTOCOL_VERSION },
    );
    const project = await createProject(owner, workspaceId);
    const svc = await createService(owner, project.id, GIT_SERVICE);
    const d = await deploy(owner, svc.service.id, project.environments[0]!.id, {
      commit_sha: COMMIT_SHA,
    });
    const failed = await waitForStatus(owner, d.id, ["failed"]);
    expect(failed.failure_reason).toMatch(/No online builder node/);
    for (const agent of [keylessAgent, oldAgent]) {
      expect(agent.received.some((m) => m.type === "build_job")).toBe(false);
    }
  });
});

describe("failure", () => {
  it("records the error event and audit entry before the deployment reads failed", async () => {
    const s = await stage({
      name: "huge",
      source: { type: "image", image: "nginx:1.27" },
      config: { resources: { memory_mb: 262_144 } },
    });
    const d = await deploy(s.owner, s.serviceId, s.envId);
    // One statement, so the three are read at a single point in time: the
    // first moment the status reads `failed` must already show the rest.
    const seen = await eventually(async () => {
      const row = await env.DB.prepare(
        `SELECT status,
           (SELECT count(*) FROM deployment_events WHERE deployment_id = d.id AND type = 'error') AS errors,
           (SELECT count(*) FROM audit_logs WHERE target_id = d.id AND action = 'deployment.failed') AS audits
         FROM deployments d WHERE id = ?`,
      )
        .bind(d.id)
        .first<{ status: string; errors: number; audits: number }>();
      return row?.status === "failed" ? row : undefined;
    }, 20_000);
    expect(seen).toEqual({ status: "failed", errors: 1, audits: 1 });
    await waitForStatus(s.owner, d.id, ["failed"]);
  });
});
