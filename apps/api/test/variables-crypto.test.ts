// biome-ignore-all lint/suspicious/noTemplateCurlyInString: values hold variable references (`${{svc.VAR}}`), not template literals.
/**
 * Variables under format 2 (ADR 0014 "Crypto", "Fingerprints", "Builds"):
 * row and version binding, fingerprints, short-secret warnings, and the
 * build-time checks on variables and service build args.
 */
import { env } from "cloudflare:test";
import { createDb } from "@roundhouse/db";
import { describe, expect, it } from "vitest";
import { sealWith } from "../src/lib/crypto";
import { openVariable, projectKey, variableAad } from "../src/lib/variables";
import { addMember, install } from "./helpers";
import { createProject, createService } from "./pipeline-helpers";

interface Listed {
  variables: {
    key: string;
    value: string | null;
    tier: "plain" | "secret";
    fingerprint: string | null;
    version: number;
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
    service: svc.service,
    envId,
    path: `/v1/services/${svc.service.id}/variables?environment_id=${envId}`,
    shared: `/v1/projects/${p.id}/variables?environment_id=${envId}`,
  };
}

type Row = {
  id: string;
  project_id: string;
  environment_id: string;
  scope: "service" | "shared";
  service_id: string | null;
  key: string;
  version: number;
  value_sealed: string;
};

async function row(key: string): Promise<Row> {
  return (await env.DB.prepare("SELECT * FROM variables WHERE key = ?").bind(key).first<Row>())!;
}

function open(s: Awaited<ReturnType<typeof setup>>, r: Row) {
  return projectKey(createDb(env.DB), env, s.project.id).then((key) =>
    openVariable(key, {
      id: r.id,
      projectId: r.project_id,
      environmentId: r.environment_id,
      scope: r.scope,
      serviceId: r.service_id,
      key: r.key,
      version: r.version,
      valueSealed: JSON.parse(r.value_sealed),
    }),
  );
}

describe("format 2 variables", () => {
  it("binds each value to its row and version, and re-seals on every bump", async () => {
    const s = await setup();
    await s.owner.json(s.path, {
      method: "PUT",
      json: {
        set: [
          { key: "A", value: "alpha" },
          { key: "B", value: "beta" },
        ],
      },
    });
    const a1 = await row("A");
    const b1 = await row("B");
    expect(await open(s, a1)).toBe("alpha");
    // Another row's ciphertext doesn't open here.
    await expect(open(s, { ...a1, value_sealed: b1.value_sealed })).rejects.toThrow();

    // A flags-only write bumps the version and re-seals.
    const flags = await s.owner.json<Listed>(s.path, {
      method: "PUT",
      json: { set: [{ key: "A", mount_as_file: true }] },
    });
    expect(flags.body.variables.find((v) => v.key === "A")).toMatchObject({
      version: 2,
      value: "alpha",
    });
    const a2 = await row("A");
    expect(a2.value_sealed).not.toBe(a1.value_sealed);
    // The old ciphertext can't be rolled back into the row.
    await expect(open(s, { ...a2, value_sealed: a1.value_sealed })).rejects.toThrow();
  });

  it("fingerprints every value, shows fingerprints to viewers, never values", async () => {
    const s = await setup();
    await s.owner.json(s.path, {
      method: "PUT",
      json: {
        set: [
          { key: "ONE", value: "same-value-1" },
          { key: "TWO", value: "same-value-1" },
          { key: "TOKEN", value: "same-value-1", tier: "secret" },
          { key: "OTHER", value: "different" },
        ],
        confirm_write_only: true,
      },
    });
    const viewer = await addMember(s.owner, s.workspaceId, "v@example.com", "viewer");
    const seen = (await viewer.json<Listed>(s.path)).body.variables;
    const fp = Object.fromEntries(seen.map((v) => [v.key, v.fingerprint]));
    expect(seen.every((v) => v.value === null)).toBe(true);
    expect(fp.ONE).toMatch(/^[a-f0-9]{8}$/);
    expect(fp.TWO).toBe(fp.ONE);
    expect(fp.TOKEN).toBe(fp.ONE);
    expect(fp.OTHER).not.toBe(fp.ONE);
    // Per project: the same value elsewhere gets another fingerprint.
    const p2 = await createProject(s.owner, s.workspaceId, { name: "Other" });
    const svc2 = await createService(s.owner, p2.id);
    const path2 = `/v1/services/${svc2.service.id}/variables?environment_id=${p2.environments[0]!.id}`;
    const other = await s.owner.json<Listed>(path2, {
      method: "PUT",
      json: { set: [{ key: "ONE", value: "same-value-1" }] },
    });
    expect(other.body.variables[0]!.fingerprint).not.toBe(fp.ONE);
    // Fingerprints are stored, not the value.
    const stored = await row("ONE");
    expect(JSON.stringify(stored)).not.toContain("same-value-1");
  });

  it("warns about secrets too short to redact by the stored tier", async () => {
    const s = await setup();
    const res = await s.owner.json<Listed>(s.path, {
      method: "PUT",
      json: {
        set: [
          { key: "PIN", value: "1234", tier: "secret" },
          { key: "API_KEY", value: "abc", tier: "plain" },
        ],
        confirm_write_only: true,
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.warnings).toEqual([
      expect.objectContaining({ key: "PIN", code: "secret_too_short_to_redact" }),
    ]);
  });

  it("re-seals copied environments for their new rows", async () => {
    const s = await setup();
    await s.owner.json(s.path, {
      method: "PUT",
      json: { set: [{ key: "A", value: "alpha" }] },
    });
    const created = await s.owner.json<{ id: string }>(
      `/v1/projects/${s.project.id}/environments`,
      {
        method: "POST",
        json: { name: "Staging", kind: "staging", copy_from_environment_id: s.envId },
      },
    );
    expect(created.status).toBe(201);
    const listed = await s.owner.json<Listed>(
      `/v1/services/${s.service.id}/variables?environment_id=${created.body.id}`,
    );
    expect(listed.body.variables).toEqual([
      expect.objectContaining({ key: "A", value: "alpha", version: 1 }),
    ]);
  });

  it("never opens format 2 under the short format 1 AAD", async () => {
    const s = await setup();
    await s.owner.json(s.path, { method: "PUT", json: { set: [{ key: "A", value: "x" }] } });
    const key = await projectKey(createDb(env.DB), env, s.project.id);
    const legacy = await sealWith(
      key,
      "legacy",
      variableAad(
        {
          projectId: s.project.id,
          environmentId: s.envId,
          scope: "service",
          serviceId: s.service.id,
        },
        "A",
      ),
    );
    await env.DB.prepare("UPDATE variables SET value_sealed = ? WHERE key = 'A'")
      .bind(JSON.stringify(legacy))
      .run();
    // Format 2 always binds row and version, so a downgraded AAD is refused.
    await expect(open(s, await row("A"))).rejects.toThrow();
  });
});

describe("build-time variables", () => {
  it("refuses names the builder reserves", async () => {
    const s = await setup();
    const refused = await s.owner.json<ErrorBody>(s.path, {
      method: "PUT",
      json: { set: [{ key: "LD_PRELOAD", value: "/tmp/x.so", available_at_build: true }] },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("invalid_request");
    expect(refused.body.error.details).toEqual([
      expect.objectContaining({ field: "LD_PRELOAD", code: "reserved_name" }),
    ]);
    // Runtime-only is fine.
    const ok = await s.owner.json(s.path, {
      method: "PUT",
      json: { set: [{ key: "LD_PRELOAD", value: "/tmp/x.so" }] },
    });
    expect(ok.status).toBe(200);
  });

  it("refuses plain build-time variables derived from a secret", async () => {
    const s = await setup();
    await s.owner.json(s.shared, {
      method: "PUT",
      json: { set: [{ key: "DB_PASSWORD", value: "pw-123456" }], confirm_write_only: true },
    });
    const url = "postgres://app:${{shared.DB_PASSWORD}}@db/app";
    const refused = await s.owner.json<ErrorBody>(s.path, {
      method: "PUT",
      json: {
        set: [{ key: "DATABASE_LINK", value: url, tier: "plain", available_at_build: true }],
      },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("build_arg_secret");
    expect(refused.body.error.message).toContain("RUN --mount=type=secret,id=DATABASE_LINK");
    // At runtime only, or as a secret, it's fine.
    for (const entry of [
      { key: "DATABASE_LINK", value: url, tier: "plain" },
      { key: "DATABASE_LINK", value: url, tier: "secret", available_at_build: true },
    ]) {
      const ok = await s.owner.json(s.path, {
        method: "PUT",
        json: { set: [entry], confirm_write_only: true },
      });
      expect(ok.status).toBe(200);
    }
  });
});

describe("build args", () => {
  async function patchBuild(s: Awaited<ReturnType<typeof setup>>, build: Record<string, unknown>) {
    return s.owner.json<ErrorBody>(`/v1/services/${s.service.id}`, {
      method: "PATCH",
      json: { environment_id: s.envId, build: { builder: "railpack", ...build } },
    });
  }

  it("stay plain and away from reserved names", async () => {
    const s = await setup();
    await s.owner.json(s.shared, {
      method: "PUT",
      json: { set: [{ key: "NPM_TOKEN", value: "npm-tok-123456" }], confirm_write_only: true },
    });
    expect((await patchBuild(s, { build_args: { NODE_ENV: "production" } })).status).toBe(200);

    const reserved = await patchBuild(s, { build_args: { PATH: "/evil", HTTPS_PROXY: "x" } });
    expect(reserved.status).toBe(400);
    expect(reserved.body.error.code).toBe("invalid_request");
    expect(reserved.body.error.details?.map((d) => d.field)).toEqual(["PATH", "HTTPS_PROXY"]);

    const stripe = ["sk", "live", "a1B2c3D4e5F6g7H8i9J0k1L2"].join("_");
    const literal = await patchBuild(s, { build_args: { STRIPE: stripe } });
    expect(literal.status).toBe(400);
    expect(literal.body.error.code).toBe("build_arg_secret");

    const referenced = await patchBuild(s, {
      build_args: { TOKEN: "${{shared.NPM_TOKEN}}", MODE: "ci" },
    });
    expect(referenced.status).toBe(400);
    expect(referenced.body.error.code).toBe("build_arg_secret");
    expect(referenced.body.error.details?.map((d) => d.field)).toEqual(["TOKEN"]);

    // Legacy secret build args are BuildKit secrets already.
    const legacy = await patchBuild(s, {
      build_args: { TOKEN: "${{shared.NPM_TOKEN}}" },
      secret_build_args: ["TOKEN"],
    });
    expect(legacy.status).toBe(200);
  });

  it("are checked when a service is created", async () => {
    const s = await setup();
    const res = await s.owner.json<ErrorBody>(`/v1/projects/${s.project.id}/services`, {
      method: "POST",
      json: {
        name: "api",
        source: { type: "git", repo_url: "https://github.com/a/b", branch: "main", root_dir: "." },
        config: { build: { builder: "railpack", build_args: { LD_LIBRARY_PATH: "/x" } } },
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_request");
  });
});
