/**
 * Variables: envelope encryption at rest, masking, audited reveal,
 * reference-syntax errors with positions, shared scope, and RBAC.
 */
import { env } from "cloudflare:test";
import { createDb } from "@openrail/db";
import { describe, expect, it } from "vitest";
import { unsealWith } from "../src/lib/crypto";
import { projectKey, variableAad } from "../src/lib/variables";
import { addMember, install } from "./helpers";
import { createProject, createService } from "./pipeline-helpers";

interface Listed {
  variables: { key: string; value: string | null; is_secret: boolean; version: number }[];
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
    revealPath: `/v1/services/${svc.service.id}/variables/reveal?environment_id=${envId}`,
  };
}

describe("service variables", () => {
  it("encrypts values at rest and masks secrets on read", async () => {
    const s = await setup();
    const res = await s.owner.json<Listed>(s.path, {
      method: "PUT",
      json: {
        set: [
          { key: "LOG_LEVEL", value: "debug" },
          { key: "API_KEY", value: "sk_live_abcdef", is_secret: true },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.variables).toEqual([
      expect.objectContaining({ key: "API_KEY", value: null, is_secret: true, version: 1 }),
      expect.objectContaining({ key: "LOG_LEVEL", value: "debug", is_secret: false, version: 1 }),
    ]);

    const rows = await env.DB.prepare("SELECT key, value_sealed FROM variables ORDER BY key").all<{
      key: string;
      value_sealed: string;
    }>();
    for (const r of rows.results) {
      expect(r.value_sealed).not.toContain("sk_live");
      expect(r.value_sealed).not.toContain("debug");
    }
    // Round trip with the project DEK and the row's AAD.
    const key = await projectKey(createDb(env.DB), env.MASTER_KEY!, s.project.id);
    const target = {
      projectId: s.project.id,
      environmentId: s.envId,
      scope: "service" as const,
      serviceId: s.serviceId,
    };
    const apiKey = rows.results.find((r) => r.key === "API_KEY")!;
    expect(
      await unsealWith(key, JSON.parse(apiKey.value_sealed), variableAad(target, "API_KEY")),
    ).toBe("sk_live_abcdef");
    // Bound to its key: the same ciphertext under another key's AAD fails.
    await expect(
      unsealWith(key, JSON.parse(apiKey.value_sealed), variableAad(target, "LOG_LEVEL")),
    ).rejects.toThrow();
  });

  it("updates, keeps the secret flag when omitted, and deletes", async () => {
    const s = await setup();
    await s.owner.json(s.path, {
      method: "PUT",
      json: {
        set: [
          { key: "TOKEN", value: "one-1234", is_secret: true },
          { key: "OLD", value: "x" },
        ],
      },
    });
    const res = await s.owner.json<Listed>(s.path, {
      method: "PUT",
      json: { set: [{ key: "TOKEN", value: "two-5678" }], delete: ["OLD", "MISSING"] },
    });
    expect(res.body.variables).toEqual([
      expect.objectContaining({ key: "TOKEN", value: null, is_secret: true, version: 2 }),
    ]);
    const revealed = await s.owner.json<{ variables: { key: string; value: string }[] }>(
      s.revealPath,
      { method: "POST", json: { keys: ["TOKEN", "NOPE"] } },
    );
    expect(revealed.body.variables).toEqual([{ key: "TOKEN", value: "two-5678" }]);
    const audit = await env.DB.prepare(
      "SELECT action, metadata FROM audit_logs WHERE action LIKE 'variables.%' ORDER BY id",
    ).all<{ action: string; metadata: string }>();
    expect(audit.results.map((a) => a.action)).toEqual([
      "variables.updated",
      "variables.updated",
      "variables.revealed",
    ]);
    const reveal = JSON.parse(audit.results[2]!.metadata);
    expect(reveal.keys).toEqual(["TOKEN"]);
    expect(audit.results[2]!.metadata).not.toContain("two-5678");
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

  it("lets viewers read masked values but only admins reveal", async () => {
    const s = await setup();
    await s.owner.json(s.path, {
      method: "PUT",
      json: { set: [{ key: "SECRET", value: "hush-hush", is_secret: true }] },
    });
    const viewer = await addMember(s.owner, s.workspaceId, "v@example.com", "viewer");
    const member = await addMember(s.owner, s.workspaceId, "m@example.com", "member");
    const admin = await addMember(s.owner, s.workspaceId, "a@example.com", "admin");
    const read = await viewer.json<Listed>(s.path);
    expect(read.status).toBe(200);
    expect(read.body.variables[0]!.value).toBeNull();
    const reveal = { method: "POST", json: { keys: ["SECRET"] } };
    expect((await viewer.json(s.revealPath, reveal)).status).toBe(403);
    expect((await member.json(s.revealPath, reveal)).status).toBe(403);
    expect((await admin.json(s.revealPath, reveal)).status).toBe(200);
    const write = { method: "PUT", json: { set: [{ key: "X", value: "1" }] } };
    expect((await viewer.json(s.path, write)).status).toBe(403);
    expect((await member.json(s.path, write)).status).toBe(200);
  });
});

describe("shared variables", () => {
  it("keeps shared values per environment, masked and revealable", async () => {
    const s = await setup();
    const path = `/v1/projects/${s.project.id}/variables?environment_id=${s.envId}`;
    const res = await s.owner.json<Listed>(path, {
      method: "PUT",
      json: {
        set: [
          { key: "REGION", value: "eu-west" },
          { key: "DB_PASSWORD", value: "pw-123456", is_secret: true },
        ],
      },
    });
    expect(res.body.variables.map((v) => [v.key, v.value])).toEqual([
      ["DB_PASSWORD", null],
      ["REGION", "eu-west"],
    ]);
    const revealed = await s.owner.json<{ variables: { value: string }[] }>(
      `/v1/projects/${s.project.id}/variables/reveal?environment_id=${s.envId}`,
      { method: "POST", json: { keys: ["DB_PASSWORD"] } },
    );
    expect(revealed.body.variables[0]!.value).toBe("pw-123456");
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
    expect(
      (
        await outsider.json(
          `/v1/projects/${s.project.id}/variables/reveal?environment_id=${s.envId}`,
          { method: "POST", json: { keys: ["A"] } },
        )
      ).status,
    ).toBe(404);
    expect(
      (await outsider.json(s.revealPath, { method: "POST", json: { keys: ["A"] } })).status,
    ).toBe(404);
  });
});
