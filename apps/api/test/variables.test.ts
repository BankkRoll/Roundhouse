/**
 * Variables: envelope encryption at rest, tiers (secrets are write-only, ADR
 * 0014), the write-only confirmation, public-prefix checks, reference-syntax
 * errors with positions, shared scope, and RBAC.
 */
import { env } from "cloudflare:test";
import { createDb } from "@roundhouse/db";
import { describe, expect, it } from "vitest";
import { dataKeyInfo, unsealWith } from "../src/lib/crypto";
import { variableAadV2 } from "../src/lib/keyring";
import { projectKey } from "../src/lib/variables";
import { addMember, install } from "./helpers";
import { createProject, createService } from "./pipeline-helpers";

interface Listed {
  variables: {
    key: string;
    value: string | null;
    tier: "plain" | "secret";
    locked: boolean;
    version: number;
    updated_by: string | null;
  }[];
  warnings?: { key: string; code: string }[];
}

interface ErrorBody {
  error: { code: string; message: string; details?: { field: string; code: string }[] };
}

async function setup() {
  const installed = await install();
  const p = await createProject(installed.owner, installed.workspaceId);
  const svc = await createService(installed.owner, p.id);
  const envId = p.environments[0]!.id;
  return {
    ...installed,
    project: p,
    serviceId: svc.service.id,
    envId,
    path: `/v1/services/${svc.service.id}/variables?environment_id=${envId}`,
  };
}

describe("service variables", () => {
  it("encrypts values at rest and never returns a secret", async () => {
    const s = await setup();
    const res = await s.owner.json<Listed>(s.path, {
      method: "PUT",
      json: {
        set: [
          { key: "LOG_LEVEL", value: "debug" },
          { key: "API_KEY", value: "sk_live_abcdef" },
        ],
        confirm_write_only: true,
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.variables).toEqual([
      expect.objectContaining({ key: "API_KEY", value: null, tier: "secret", version: 1 }),
      expect.objectContaining({ key: "LOG_LEVEL", value: "debug", tier: "plain", version: 1 }),
    ]);
    expect(res.body.variables[0]!.updated_by).toBe(s.userId);

    const rows = await env.DB.prepare("SELECT key, value_sealed FROM variables ORDER BY key").all<{
      key: string;
      value_sealed: string;
    }>();
    for (const r of rows.results) {
      expect(r.value_sealed).not.toContain("sk_live");
      expect(r.value_sealed).not.toContain("debug");
    }
    // Round trip with the project DEK and the row's format 2 AAD.
    const key = await projectKey(createDb(env.DB), env, s.project.id);
    const row = await env.DB.prepare("SELECT * FROM variables WHERE key = 'API_KEY'").first<{
      id: string;
      value_sealed: string;
      version: number;
    }>();
    const sealed = JSON.parse(row!.value_sealed);
    expect(sealed).toMatchObject({ v: 2, kid: dataKeyInfo(key).dekId });
    const coordinates = {
      workspaceId: s.workspaceId,
      projectId: s.project.id,
      environmentId: s.envId,
      scope: "service" as const,
      serviceId: s.serviceId,
      key: "API_KEY",
      rowId: row!.id,
      version: row!.version,
    };
    expect(await unsealWith(key, sealed, variableAadV2(coordinates))).toBe("sk_live_abcdef");
    // Bound to its key: the same ciphertext under another key's AAD fails.
    await expect(
      unsealWith(key, sealed, variableAadV2({ ...coordinates, key: "LOG_LEVEL" })),
    ).rejects.toThrow();
  });

  it("needs confirm_write_only before anything becomes secret", async () => {
    const s = await setup();
    const refused = await s.owner.json<ErrorBody>(s.path, {
      method: "PUT",
      json: {
        set: [
          { key: "DB_PASSWORD", value: "pw-123456" },
          { key: "A", value: "1" },
        ],
      },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("confirmation_required");
    expect(refused.body.error.details?.map((d) => d.field)).toEqual(["DB_PASSWORD"]);
    expect((await s.owner.json<Listed>(s.path)).body.variables).toEqual([]);

    // Plain to secret later needs it too, and no value.
    await s.owner.json(s.path, { method: "PUT", json: { set: [{ key: "A", value: "1" }] } });
    const upgrade = { set: [{ key: "A", tier: "secret" }] };
    expect((await s.owner.json(s.path, { method: "PUT", json: upgrade })).status).toBe(400);
    const ok = await s.owner.json<Listed>(s.path, {
      method: "PUT",
      json: { ...upgrade, confirm_write_only: true },
    });
    expect(ok.body.variables).toEqual([
      expect.objectContaining({ key: "A", tier: "secret", value: null }),
    ]);
  });

  it("keeps a secret secret when updated, needs a value to make it plain, and deletes", async () => {
    const s = await setup();
    await s.owner.json(s.path, {
      method: "PUT",
      json: {
        set: [
          { key: "TOKEN", value: "one-1234", tier: "secret" },
          { key: "OLD", value: "x" },
        ],
        confirm_write_only: true,
      },
    });
    const res = await s.owner.json<Listed>(s.path, {
      method: "PUT",
      json: { set: [{ key: "TOKEN", value: "two-5678" }], delete: ["OLD", "MISSING"] },
    });
    expect(res.body.variables).toEqual([
      expect.objectContaining({ key: "TOKEN", value: null, tier: "secret", version: 2 }),
    ]);
    const noValue = await s.owner.json<ErrorBody>(s.path, {
      method: "PUT",
      json: { set: [{ key: "TOKEN", tier: "plain" }] },
    });
    expect(noValue.body.error.code).toBe("value_required");
    const plain = await s.owner.json<Listed>(s.path, {
      method: "PUT",
      json: { set: [{ key: "TOKEN", value: "now-public", tier: "plain" }] },
    });
    expect(plain.body.variables).toEqual([
      expect.objectContaining({ key: "TOKEN", value: "now-public", tier: "plain", version: 3 }),
    ]);
    const audit = await env.DB.prepare(
      "SELECT action, metadata FROM audit_logs WHERE action LIKE 'variables.%' ORDER BY seq",
    ).all<{ action: string; metadata: string }>();
    expect(audit.results.map((a) => a.action)).toEqual([
      "variables.updated",
      "variables.updated",
      "variables.updated",
    ]);
    for (const a of audit.results) expect(a.metadata).not.toContain("two-5678");
  });

  it("locks recognised credentials and public prefixes", async () => {
    const s = await setup();
    const pat = ["ghp", "_", "a1B2c3D4e5F6g7H8i9J0".repeat(2)].join("");
    const locked = await s.owner.json<ErrorBody>(s.path, {
      method: "PUT",
      json: { set: [{ key: "CONFIG", value: pat, tier: "plain" }] },
    });
    expect(locked.body.error.code).toBe("tier_locked");
    const stored = await s.owner.json<Listed>(s.path, {
      method: "PUT",
      json: { set: [{ key: "CONFIG", value: pat }], confirm_write_only: true },
    });
    expect(stored.body.variables).toEqual([
      expect.objectContaining({ key: "CONFIG", tier: "secret", locked: true, value: null }),
    ]);

    const leak = { set: [{ key: "VITE_GITHUB", value: pat }] };
    const refused = await s.owner.json<ErrorBody>(s.path, { method: "PUT", json: leak });
    expect(refused.body.error.code).toBe("public_prefix_secret_value");
    const acked = await s.owner.json<Listed>(s.path, {
      method: "PUT",
      json: { ...leak, acknowledge_public: ["VITE_GITHUB"] },
    });
    expect(acked.body.variables.find((v) => v.key === "VITE_GITHUB")).toMatchObject({
      tier: "plain",
      locked: true,
    });
    expect(acked.body.warnings).toEqual([
      expect.objectContaining({ key: "VITE_GITHUB", code: "public_prefix_secret_value" }),
    ]);
    const asSecret = await s.owner.json<ErrorBody>(s.path, {
      method: "PUT",
      json: { set: [{ key: "VITE_URL", value: "x", tier: "secret" }], confirm_write_only: true },
    });
    expect(asSecret.body.error.code).toBe("tier_locked");
  });

  it("rejects malformed references with every position", async () => {
    const s = await setup();
    const res = await s.owner.json<{
      error: {
        code: string;
        message: string;
        details: { field: string; code: string; start: number; end: number }[];
      };
    }>(s.path, {
      method: "PUT",
      json: {
        set: [
          // biome-ignore lint/suspicious/noTemplateCurlyInString: `${{…}}` is variable-reference syntax, not a template.
          { key: "A", value: "x ${{ bad ref }} y" },
          { key: "B", value: "ok ${{db.URL" },
          // biome-ignore lint/suspicious/noTemplateCurlyInString: `${{…}}` is variable-reference syntax, not a template.
          { key: "C", value: "fine ${{db.URL}} and ${{literal}}" },
        ],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_reference");
    expect(res.body.error.details).toEqual([
      expect.objectContaining({ field: "A", code: "malformed_reference", start: 2, end: 16 }),
      expect.objectContaining({ field: "B", code: "unclosed_reference", start: 3, end: 12 }),
    ]);
    expect(res.body.error.message).toMatch(/^A: .*\(at 2-16\)$/);
    const list = await s.owner.json<Listed>(s.path);
    expect(list.body.variables).toEqual([]);
  });

  it("validates keys, duplicates and the environment", async () => {
    const s = await setup();
    const bad = await s.owner.json(s.path, {
      method: "PUT",
      json: { set: [{ key: "1BAD", value: "x" }] },
    });
    expect(bad.status).toBe(400);
    const dup = await s.owner.json(s.path, {
      method: "PUT",
      json: { set: [{ key: "A", value: "x" }], delete: ["A"] },
    });
    expect(dup.status).toBe(400);
    const other = await createProject(s.owner, s.workspaceId, { name: "Other" });
    const foreignEnv = await s.owner.json(
      `/v1/services/${s.serviceId}/variables?environment_id=${other.environments[0]!.id}`,
    );
    expect(foreignEnv.status).toBe(404);
    expect((await s.owner.json(`/v1/services/${s.serviceId}/variables`)).status).toBe(400);
  });

  it("hides plain values from viewers and secrets from everyone", async () => {
    const s = await setup();
    await s.owner.json(s.path, {
      method: "PUT",
      json: {
        set: [
          { key: "SECRET", value: "hush-hush", tier: "secret" },
          { key: "PLAIN", value: "visible" },
        ],
        confirm_write_only: true,
      },
    });
    const viewer = await addMember(s.owner, s.workspaceId, "v@example.com", "viewer");
    const member = await addMember(s.owner, s.workspaceId, "m@example.com", "member");
    const admin = await addMember(s.owner, s.workspaceId, "a@example.com", "admin");
    const values = async (c: typeof viewer) =>
      Object.fromEntries(
        (await c.json<Listed>(s.path)).body.variables.map((v) => [v.key, v.value]),
      );
    expect(await values(viewer)).toEqual({ PLAIN: null, SECRET: null });
    expect(await values(member)).toEqual({ PLAIN: "visible", SECRET: null });
    expect(await values(admin)).toEqual({ PLAIN: "visible", SECRET: null });
    const write = { method: "PUT", json: { set: [{ key: "X", value: "1" }] } };
    expect((await viewer.json(s.path, write)).status).toBe(403);
    // Production starts protected: variables there are for project admins.
    expect((await member.json(s.path, write)).status).toBe(403);
    expect((await admin.json(s.path, write)).status).toBe(200);
  });
});

describe("shared variables", () => {
  it("keeps shared values per environment, secrets write-only", async () => {
    const s = await setup();
    const path = `/v1/projects/${s.project.id}/variables?environment_id=${s.envId}`;
    const res = await s.owner.json<Listed>(path, {
      method: "PUT",
      json: {
        set: [
          { key: "REGION", value: "eu-west" },
          { key: "DB_PASSWORD", value: "pw-123456" },
        ],
        confirm_write_only: true,
      },
    });
    expect(res.body.variables.map((v) => [v.key, v.tier, v.value])).toEqual([
      ["DB_PASSWORD", "secret", null],
      ["REGION", "plain", "eu-west"],
    ]);
    // Service scope doesn't see shared keys.
    const svc = await s.owner.json<Listed>(s.path);
    expect(svc.body.variables).toEqual([]);
    const bad = await s.owner.json(path, {
      method: "PUT",
      json: { set: [{ key: "X", value: "${{" }] },
    });
    expect(bad.status).toBe(400);
  });

  it("is invisible across workspaces", async () => {
    const s = await setup();
    const ws2 = await s.owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Other" },
    });
    const outsider = await addMember(s.owner, ws2.body.id, "o@example.com", "admin");
    const path = `/v1/projects/${s.project.id}/variables?environment_id=${s.envId}`;
    expect((await outsider.json(path)).status).toBe(404);
    const write = { method: "PUT", json: { set: [{ key: "A", value: "1" }] } };
    expect((await outsider.json(path, write)).status).toBe(404);
    expect((await outsider.json(s.path, write)).status).toBe(404);
  });
});
