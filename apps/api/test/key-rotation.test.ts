/**
 * Master key rotation end to end (ADR 0014 "Rotation"): an install with
 * data sealed under the old key, some of it still format 1, switches
 * `MASTER_KEY` (old key in `MASTER_KEYS_PREVIOUS`), keeps working, runs
 * `KeyRotationWorkflow`, and ends with everything format 2 under the new key
 * and the old key removable.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { createDb } from "@roundhouse/db";
import { fromBase64, toBase64 } from "@roundhouse/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { deriveKey, unsealDataKey } from "../src/lib/crypto";
import { openDeploymentEnv } from "../src/lib/desired-state";
import { unsealInstanceSecret } from "../src/lib/instance-secrets";
import { masterKeyId } from "../src/lib/keyring";
import { projectKey } from "../src/lib/variables";
import { call, client, install } from "./helpers";
import { createProject, createService } from "./pipeline-helpers";

const OLD = env.MASTER_KEY!;
const NEW = btoa("n".repeat(32));
const encoder = new TextEncoder();

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;

afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
  env.MASTER_KEY = OLD;
  env.MASTER_KEYS_PREVIOUS = undefined;
});

async function gcmV1(key: CryptoKey, plaintext: string, aad: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(plaintext),
  );
  return { v: 1 as const, iv: toBase64(iv), ct: toBase64(ct) };
}

/** Format 1 under the old key's v1 KEK, as ADR 0003 stored it. */
async function sealKekV1(plaintext: string, aad: string) {
  const raw = await deriveKey(OLD, "kek");
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  return gcmV1(key, plaintext, aad);
}

async function sealDekV1(rawDek: string, plaintext: string, aad: string) {
  const key = await crypto.subtle.importKey("raw", fromBase64(rawDek), "AES-GCM", false, [
    "encrypt",
  ]);
  return gcmV1(key, plaintext, aad);
}

async function signIn() {
  const res = await call("/api/auth/sign-in/email", {
    method: "POST",
    json: { email: "mara@example.com", password: "correct horse battery" },
  });
  expect(res.status).toBe(200);
  return client(
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  );
}

interface KeyStatusBody {
  current_kid: string;
  previous_kids: string[];
  remaining: Record<string, number>;
  rotation: { id: string; state: string; finished_at: number | null } | null;
  previous_keys_removable: boolean;
}

/** An install whose rows look like ADR 0003 left them, all under {@link OLD}. */
async function legacyInstall() {
  const installed = await install();
  const p = await createProject(installed.owner, installed.workspaceId);
  const svc = await createService(installed.owner, p.id);
  const envId = p.environments[0]!.id;
  const path = `/v1/services/${svc.service.id}/variables?environment_id=${envId}`;
  const put = await installed.owner.json(path, {
    method: "PUT",
    json: {
      set: [
        { key: "LOG_LEVEL", value: "debug" },
        { key: "API_TOKEN", value: "tok-0123456789", tier: "secret" },
      ],
      confirm_write_only: true,
    },
  });
  expect(put.status).toBe(200);

  const db = env.DB;
  const keyRow = (await db
    .prepare("SELECT dek_sealed FROM project_keys WHERE project_id = ?")
    .bind(p.id)
    .first<{ dek_sealed: string }>())!;
  const rawDek = await unsealDataKey(
    OLD,
    JSON.parse(keyRow.dek_sealed),
    installed.workspaceId,
    p.id,
  );

  // DEK: format 1 under the old key's v1 KEK, no kek_kid.
  await db
    .prepare(
      "UPDATE project_keys SET dek_sealed = ?, kek_kid = NULL, dek_id = NULL WHERE project_id = ?",
    )
    .bind(JSON.stringify(await sealKekV1(rawDek, `project-key:${p.id}`)), p.id)
    .run();
  // LOG_LEVEL: format 1 with the short AAD, no fingerprint.
  const v1Aad = `variable:${p.id}:${envId}:service:${svc.service.id}:LOG_LEVEL`;
  await db
    .prepare("UPDATE variables SET value_sealed = ?, fingerprint = NULL WHERE key = 'LOG_LEVEL'")
    .bind(JSON.stringify(await sealDekV1(rawDek, "debug", v1Aad)))
    .run();
  // Signing key: format 1.
  const signing = (await db
    .prepare("SELECT value FROM instance_settings WHERE key = 'signing_key'")
    .first<{ value: string }>())!;
  const signingValue = JSON.parse(signing.value);
  const pkcs8 = await unsealInstanceSecret(
    { MASTER_KEY: OLD },
    signingValue.private_key,
    "signing_key",
  );
  signingValue.private_key = await sealKekV1(pkcs8, "setting:signing_key");
  await db
    .prepare("UPDATE instance_settings SET value = ? WHERE key = 'signing_key'")
    .bind(JSON.stringify(signingValue))
    .run();
  // A provider token: format 1, AAD as `lib/cloud-providers.ts` builds it.
  const credId = "pcr_rotation1";
  const field = `${installed.workspaceId}:hetzner:${credId}`;
  await db
    .prepare(
      `INSERT INTO provider_credentials (id, workspace_id, provider, token_sealed, fingerprint, token_last4, validated_at, created_at, updated_at)
       VALUES (?, ?, 'hetzner', ?, 'abcd1234', 'oken', 0, 0, 0)`,
    )
    .bind(
      credId,
      installed.workspaceId,
      JSON.stringify(await sealKekV1("hetzner-token", `setting:provider_credential:${field}`)),
    )
    .run();
  // A deployment whose env is format 1.
  const depId = "dep_rotation1";
  await db
    .prepare(
      `INSERT INTO deployments (id, service_id, environment_id, config_version, status, trigger, env_sealed, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'succeeded', 'manual', ?, 0, 0)`,
    )
    .bind(
      depId,
      svc.service.id,
      envId,
      JSON.stringify(await sealDekV1(rawDek, '{"A":"1"}', `deployment-env:${depId}`)),
    )
    .run();
  return { ...installed, project: p, serviceId: svc.service.id, path, credId, field, depId };
}

describe("key rotation", () => {
  it("re-wraps everything under the new key and frees the old one", async () => {
    const s = await legacyInstall();
    env.MASTER_KEY = NEW;
    env.MASTER_KEYS_PREVIOUS = OLD;
    // Rotating the key derives a new auth secret: everyone signs in again.
    const owner = await signIn();

    // Everything keeps working before the rotation runs.
    const listed = await owner.json<{ variables: { key: string; value: string | null }[] }>(s.path);
    expect(listed.status).toBe(200);
    expect(listed.body.variables.find((v) => v.key === "LOG_LEVEL")?.value).toBe("debug");

    const before = await owner.json<KeyStatusBody>("/v1/instance/keys");
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      current_kid: await masterKeyId(NEW),
      previous_kids: [await masterKeyId(OLD)],
      remaining: {
        project_keys: 1,
        instance_secrets: 2,
        v1_variables: 1,
        v1_deployments: 1,
        missing_fingerprints: 1,
      },
      previous_keys_removable: false,
    });

    introspector = await introspectWorkflow(env.KEY_ROTATION_WORKFLOW);
    const started = await owner.json<{ rotation_id: string }>("/v1/instance/keys/rotate", {
      method: "POST",
    });
    expect(started.status).toBe(202);
    expect(started.body.rotation_id).toMatch(/^krot_/);
    const [instance] = await introspector.get();
    await instance!.waitForStatus("complete");

    const after = await owner.json<KeyStatusBody>("/v1/instance/keys");
    expect(after.body.remaining).toEqual({
      project_keys: 0,
      instance_secrets: 0,
      v1_variables: 0,
      v1_deployments: 0,
      missing_fingerprints: 0,
    });
    expect(after.body.previous_keys_removable).toBe(true);
    expect(after.body.rotation).toMatchObject({
      id: started.body.rotation_id,
      state: "completed",
      finished_at: expect.any(Number),
    });

    // Everything opens with the new key alone.
    const newOnly = { MASTER_KEY: NEW };
    const newKid = await masterKeyId(NEW);
    const keyRow = (await env.DB.prepare(
      "SELECT dek_sealed, kek_kid, dek_id FROM project_keys WHERE project_id = ?",
    )
      .bind(s.project.id)
      .first<{ dek_sealed: string; kek_kid: string; dek_id: string }>())!;
    expect(keyRow.kek_kid).toBe(newKid);
    expect(keyRow.dek_id).toMatch(/^[a-f0-9]{8}$/);
    expect(JSON.parse(keyRow.dek_sealed)).toMatchObject({ v: 2, kid: newKid });
    await expect(
      unsealDataKey(newOnly, JSON.parse(keyRow.dek_sealed), s.workspaceId, s.project.id),
    ).resolves.toBeTypeOf("string");

    const signing = JSON.parse(
      (await env.DB.prepare("SELECT value FROM instance_settings WHERE key = 'signing_key'").first<{
        value: string;
      }>())!.value,
    );
    expect(signing.private_key).toMatchObject({ v: 2, kid: newKid });
    await expect(
      unsealInstanceSecret(newOnly, signing.private_key, "signing_key"),
    ).resolves.toBeTypeOf("string");

    const cred = (await env.DB.prepare("SELECT token_sealed FROM provider_credentials WHERE id = ?")
      .bind(s.credId)
      .first<{ token_sealed: string }>())!;
    expect(
      await unsealInstanceSecret(
        newOnly,
        JSON.parse(cred.token_sealed),
        "provider_credential",
        s.field,
      ),
    ).toBe("hetzner-token");

    const vars = await env.DB.prepare(
      "SELECT key, value_sealed, fingerprint, version FROM variables ORDER BY key",
    ).all<{ key: string; value_sealed: string; fingerprint: string; version: number }>();
    for (const v of vars.results) {
      expect(JSON.parse(v.value_sealed).v).toBe(2);
      expect(v.fingerprint).toMatch(/^[a-f0-9]{8}$/);
      expect(v.version).toBe(1);
    }

    const dep = (await env.DB.prepare("SELECT env_sealed FROM deployments WHERE id = ?")
      .bind(s.depId)
      .first<{ env_sealed: string }>())!;
    const key = await projectKey(createDb(env.DB), newOnly, s.project.id);
    expect(JSON.parse(dep.env_sealed).v).toBe(2);
    expect(
      await openDeploymentEnv(key, JSON.parse(dep.env_sealed), {
        workspaceId: s.workspaceId,
        projectId: s.project.id,
        deploymentId: s.depId,
      }),
    ).toEqual({ env: { A: "1" }, files: {} });

    const audit = await env.DB.prepare(
      "SELECT action, metadata FROM audit_logs WHERE action LIKE 'instance.key_rotation_%' ORDER BY seq",
    ).all<{ action: string; metadata: string }>();
    expect(audit.results.map((a) => a.action)).toEqual([
      "instance.key_rotation_started",
      "instance.key_rotation_completed",
    ]);
    for (const a of audit.results) {
      expect(a.metadata).not.toContain("hetzner-token");
      expect(a.metadata).not.toContain(NEW);
    }

    // A second run finds nothing to do.
    const again = await owner.json<{ rotation_id: string }>("/v1/instance/keys/rotate", {
      method: "POST",
    });
    expect(again.status).toBe(202);
  });

  it("refuses a second rotation while one runs, and non-admins", async () => {
    const s = await install();
    env.MASTER_KEY = NEW;
    env.MASTER_KEYS_PREVIOUS = OLD;
    const owner = await signIn();
    introspector = await introspectWorkflow(env.KEY_ROTATION_WORKFLOW);
    const [a, b] = await Promise.all([
      owner.request("/v1/instance/keys/rotate", { method: "POST" }),
      owner.request("/v1/instance/keys/rotate", { method: "POST" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    for (const instance of await introspector.get()) await instance.waitForStatus("complete");

    const unauthenticated = await call("/v1/instance/keys");
    expect(unauthenticated.status).toBe(401);
    expect(s.workspaceId).toBeTruthy();
  });
});
