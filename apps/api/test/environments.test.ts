/**
 * Environment lifecycle (ADR 0007): creating blank and cloned environments
 * (variables per mode, database credentials always fresh, empty volumes,
 * restores of the latest dumps), the diff (secrets by fingerprint, never by
 * value), promotion as a change set that deploys the exact source image
 * without a rebuild, and deletion (never production, confirmation,
 * protection, retirement of everything it held).
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { createDb } from "@roundhouse/db";
import { ACTIONS, AUDIT_ACTIONS } from "@roundhouse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENVIRONMENT_ROUTES, policyOf } from "../src/contracts";
import { app } from "../src/index";
import { setS3Transport } from "../src/lib/s3";
import { openVariable, projectKey } from "../src/lib/variables";
import { STORAGE_BODY } from "./backups-helpers";
import { FakeS3 } from "./fake-s3";
import { addMember, type Client, install, joinNode } from "./helpers";
import {
  COMMIT_SHA,
  connectWorkloadAgent,
  createProject,
  createService,
  GIT_SERVICE,
  settleDeployments,
  waitForStatus,
} from "./pipeline-helpers";

// Fake values only, shaped so the classifier treats them as described.
const API_KEY = "test-api-key-not-real-0002";

let introspectors: Awaited<ReturnType<typeof introspectWorkflow>>[] = [];
beforeEach(async () => {
  introspectors = [
    await introspectWorkflow(env.DEPLOY_WORKFLOW),
    await introspectWorkflow(env.RESTORE_WORKFLOW),
  ];
});
afterEach(async () => {
  await env.DB.prepare(
    "UPDATE restores SET status = 'failed' WHERE status IN ('queued', 'running')",
  ).run();
  await settleDeployments(20_000);
  for (const i of introspectors) await i.dispose();
  setS3Transport();
});

const TIMEOUT = 60_000;

async function ok<T>(res: Promise<{ status: number; body: T }>, status = 200): Promise<T> {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body;
}

interface Stage {
  owner: Client;
  workspaceId: string;
  projectId: string;
  prodId: string;
  webId: string;
  dbId: string;
}

/** A project with a git service and a Postgres database, with variables in production. */
async function stage(): Promise<Stage> {
  const { owner, workspaceId } = await install();
  const project = await createProject(owner, workspaceId, { name: "Shop" });
  const prodId = project.environments[0]!.id;
  const web = await createService(owner, project.id, {
    ...GIT_SERVICE,
    config: { networking: { port: 8080, generated_domain: true } },
  });
  const db = await ok(
    owner.json<{ service: { id: string } }>(`/v1/projects/${project.id}/databases`, {
      method: "POST",
      json: { engine: "postgres", environment_id: prodId, slug: "db", deploy: false },
    }),
    201,
  );
  await ok(
    owner.json(`/v1/services/${web.service.id}/variables?environment_id=${prodId}`, {
      method: "PUT",
      json: {
        set: [
          { key: "API_KEY", value: API_KEY, tier: "secret" },
          { key: "PUBLIC_NAME", value: "Acme Shop", tier: "plain" },
        ],
        confirm_write_only: true,
      },
    }),
  );
  return {
    owner,
    workspaceId,
    projectId: project.id,
    prodId,
    webId: web.service.id,
    dbId: db.service.id,
  };
}

function createEnv(c: Client, projectId: string, json: Record<string, unknown>) {
  return c.json<{ id: string; slug: string; kind: string; error?: { code: string } }>(
    `/v1/projects/${projectId}/environments`,
    { method: "POST", json: { kind: "staging", ...json } },
  );
}

async function variableKeys(s: Stage, environmentId: string) {
  const res = await ok(
    s.owner.json<{ variables: { key: string; tier: string; value: string | null }[] }>(
      `/v1/services/${s.webId}/variables?environment_id=${environmentId}`,
    ),
  );
  return res.variables;
}

async function dbPassword(s: Stage, environmentId: string) {
  const row = await env.DB.prepare(
    "SELECT * FROM variables WHERE service_id = ? AND environment_id = ? AND key = 'POSTGRES_PASSWORD'",
  )
    .bind(s.dbId, environmentId)
    .first<Record<string, unknown>>();
  if (!row) return null;
  const key = await projectKey(createDb(env.DB), env, s.projectId);
  return openVariable(key, {
    id: row.id as string,
    projectId: s.projectId,
    environmentId,
    scope: "service",
    serviceId: s.dbId,
    key: "POSTGRES_PASSWORD",
    version: row.version as number,
    valueSealed: JSON.parse(row.value_sealed as string),
  } as never);
}

describe("environment routes", () => {
  it("serves every lifecycle route with a coherent policy", () => {
    const live = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } });
    for (const [name, route] of Object.entries(ENVIRONMENT_ROUTES)) {
      const op = (live.paths?.[route.path] as Record<string, Record<string, unknown>>)?.[
        route.method
      ];
      expect(op, name).toBeDefined();
      expect(ACTIONS).toContain(policyOf(route).action);
      for (const a of policyOf(route).audit) expect(AUDIT_ACTIONS).toContain(a);
    }
    expect(policyOf(ENVIRONMENT_ROUTES.deleteEnvironment).reauth).toBe(true);
  });
});

describe("creating and cloning", () => {
  it(
    "clones configs and variables per mode, with fresh database credentials and empty volumes",
    async () => {
      const s = await stage();
      const all = await ok(
        createEnv(s.owner, s.projectId, {
          name: "Staging",
          clone: { from_environment_id: s.prodId },
        }),
        201,
      );
      expect((await variableKeys(s, all.id)).map((v) => v.key).sort()).toEqual([
        "API_KEY",
        "PUBLIC_NAME",
      ]);
      const [prodPassword, clonePassword] = [
        await dbPassword(s, s.prodId),
        await dbPassword(s, all.id),
      ];
      expect(clonePassword).toBeTruthy();
      expect(clonePassword).not.toBe(prodPassword);
      const volumes = await env.DB.prepare(
        "SELECT status, node_id FROM volumes WHERE environment_id = ?",
      )
        .bind(all.id)
        .all<{ status: string; node_id: string | null }>();
      expect(volumes.results).toEqual([{ status: "pending", node_id: null }]);

      const plain = await ok(
        createEnv(s.owner, s.projectId, {
          name: "QA",
          clone: { from_environment_id: s.prodId, variables: "non_secret" },
        }),
        201,
      );
      expect((await variableKeys(s, plain.id)).map((v) => v.key)).toEqual(["PUBLIC_NAME"]);
      const none = await ok(
        createEnv(s.owner, s.projectId, {
          name: "Empty",
          clone: { from_environment_id: s.prodId, variables: "none" },
        }),
        201,
      );
      expect(await variableKeys(s, none.id)).toEqual([]);
      // Even without variables, a database gets credentials of its own.
      expect(await dbPassword(s, none.id)).toBeTruthy();

      const alias = await ok(
        createEnv(s.owner, s.projectId, { name: "Old", copy_from_environment_id: s.prodId }),
        201,
      );
      expect((await variableKeys(s, alias.id)).length).toBe(2);
      expect(
        (
          await createEnv(s.owner, s.projectId, {
            name: "Both",
            copy_from_environment_id: s.prodId,
            clone: { from_environment_id: s.prodId },
          })
        ).status,
      ).toBe(400);
      expect(
        (await createEnv(s.owner, s.projectId, { name: "Prod 2", kind: "production" })).status,
      ).toBe(400);

      const audit = await env.DB.prepare(
        "SELECT action, metadata FROM audit_logs WHERE action LIKE 'environment.%' ORDER BY seq",
      ).all<{ action: string; metadata: string }>();
      expect(audit.results.filter((r) => r.action === "environment.cloned")).toHaveLength(4);
      expect(JSON.stringify(audit.results)).not.toContain(API_KEY);
    },
    TIMEOUT,
  );

  it(
    "lets developers create environments, restores dumps only for backups:restore",
    async () => {
      const s = await stage();
      const dev = await addMember(s.owner, s.workspaceId, "dev@example.com", "member");
      const viewer = await addMember(s.owner, s.workspaceId, "viewer@example.com", "viewer");
      expect((await createEnv(viewer, s.projectId, { name: "No" })).status).toBe(403);
      expect((await createEnv(dev, s.projectId, { name: "Yes" })).status).toBe(201);
      expect(
        (
          await createEnv(dev, s.projectId, {
            name: "Data",
            clone: { from_environment_id: s.prodId, volumes: "latest_backup" },
          })
        ).status,
      ).toBe(403);

      const s3 = new FakeS3();
      setS3Transport(s3.fetch);
      await ok(s.owner.json("/v1/instance/backup-storage", { method: "PUT", json: STORAGE_BODY }));
      await env.DB.prepare(
        `INSERT INTO backups (id, project_id, service_id, environment_id, trigger, method, engine, status,
           object_key, sha256, bytes_stored, pinned, finished_at, created_at, updated_at)
         VALUES ('bak_PRODDUMP', ?, ?, ?, 'manual', 'dump', 'postgres', 'succeeded', 'k/1', ?, 10, 0, 1, 0, 0)`,
      )
        .bind(s.projectId, s.dbId, s.prodId, "a".repeat(64))
        .run();
      const seeded = await ok(
        createEnv(s.owner, s.projectId, {
          name: "Seeded",
          clone: { from_environment_id: s.prodId, volumes: "latest_backup" },
        }),
        201,
      );
      const restore = await env.DB.prepare(
        "SELECT backup_id, target_service_id FROM restores WHERE target_environment_id = ?",
      )
        .bind(seeded.id)
        .first();
      expect(restore).toEqual({ backup_id: "bak_PRODDUMP", target_service_id: s.dbId });
    },
    TIMEOUT,
  );
});

describe("diff", () => {
  it(
    "compares configs and variables, secrets by fingerprint, never showing a value",
    async () => {
      const s = await stage();
      const staging = await ok(
        createEnv(s.owner, s.projectId, {
          name: "Staging",
          clone: { from_environment_id: s.prodId },
        }),
        201,
      );
      const diff = () =>
        ok(
          s.owner.json<{
            services: {
              slug: string;
              presence: string;
              config: { path: string }[];
              variables: { key: string; change: string; secret: boolean }[];
            }[];
          }>(`/v1/projects/${s.projectId}/environments/diff?base=${s.prodId}&target=${staging.id}`),
        );
      const same = await diff();
      const web = same.services.find((x) => x.slug === "api")!;
      expect(web.presence).toBe("both");
      expect(web.config).toEqual([]);
      expect(web.variables.every((v) => v.change === "same")).toBe(true);
      // Database credentials differ by design and are left out.
      expect(same.services.find((x) => x.slug === "db")!.variables).toEqual([]);

      await ok(
        s.owner.json(`/v1/services/${s.webId}?environment_id=${staging.id}`, {
          method: "PATCH",
          json: {
            environment_id: staging.id,
            deploy: { replicas: 2 },
            networking: { generated_domain: false },
          },
        }),
      );
      await ok(
        s.owner.json(`/v1/services/${s.webId}/variables?environment_id=${staging.id}`, {
          method: "PUT",
          json: {
            set: [
              { key: "API_KEY", value: "test-api-key-not-real-0003", tier: "secret" },
              { key: "NEW_FLAG", value: "on", tier: "plain" },
            ],
            delete: ["PUBLIC_NAME"],
            confirm_write_only: true,
          },
        }),
      );
      const changed = await diff();
      const after = changed.services[0]!;
      expect(after.slug).toBe("api");
      expect(after.config.map((e) => e.path)).toEqual(["/deploy/replicas"]);
      expect(after.variables).toEqual([
        { key: "API_KEY", change: "changed", secret: true },
        { key: "NEW_FLAG", change: "added", secret: false },
        { key: "PUBLIC_NAME", change: "removed", secret: false },
      ]);
      expect(JSON.stringify(changed)).not.toContain("test-api-key-not-real");
    },
    TIMEOUT,
  );
});

describe("promote", () => {
  it(
    "proposes a change set that, applied, runs staging's exact image in production without a build",
    async () => {
      const s = await stage();
      const agent = await connectWorkloadAgent(await joinNode(s.owner, s.workspaceId));
      const staging = await ok(
        createEnv(s.owner, s.projectId, {
          name: "Staging",
          clone: { from_environment_id: s.prodId },
        }),
        201,
      );
      await ok(
        s.owner.json(`/v1/services/${s.webId}?environment_id=${staging.id}`, {
          method: "PATCH",
          json: { environment_id: staging.id, resources: { memory_mb: 640 } },
        }),
      );
      await ok(
        s.owner.json(`/v1/services/${s.webId}/variables?environment_id=${staging.id}`, {
          method: "PUT",
          json: { set: [{ key: "FEATURE", value: "beta", tier: "plain" }] },
        }),
      );
      const built = await ok(
        s.owner.json<{ id: string }>(
          `/v1/services/${s.webId}/deployments?environment_id=${staging.id}`,
          { method: "POST", json: { commit_sha: COMMIT_SHA } },
        ),
        201,
      );
      const stagingDeployment = await waitForStatus(s.owner, built.id, ["active", "failed"]);
      expect(stagingDeployment.status).toBe("active");

      const dev = await addMember(s.owner, s.workspaceId, "viewer@example.com", "viewer");
      expect(
        (
          await dev.json(`/v1/environments/${s.prodId}/promote`, {
            method: "POST",
            json: { from_environment_id: staging.id },
          })
        ).status,
      ).toBe(403);
      const set = await ok(
        s.owner.json<{
          id: string;
          revision: number;
          source: string;
          changes: { op: { type: string; key?: string; image?: string; fingerprint?: string } }[];
        }>(`/v1/environments/${s.prodId}/promote`, {
          method: "POST",
          json: { from_environment_id: staging.id, include: { variables: "all" } },
        }),
        201,
      );
      expect(set.source).toBe("promote");
      const types = set.changes.map((o) => o.op.type).sort();
      expect(types).toEqual(["config.patch", "deployment.promote", "variable.set"]);
      expect(set.changes.find((o) => o.op.type === "deployment.promote")!.op.image).toBe(
        stagingDeployment.image,
      );
      expect(JSON.stringify(set)).not.toContain("beta");

      const builds = async () =>
        (await env.DB.prepare("SELECT count(*) AS n FROM builds").first<{ n: number }>())!.n;
      const before = await builds();
      const applied = await ok(
        s.owner.json<{ deployment_ids: string[] }>(`/v1/change-sets/${set.id}/apply`, {
          method: "POST",
          json: { expected_revision: set.revision },
        }),
      );
      expect(applied.deployment_ids).toHaveLength(1);
      const promoted = await waitForStatus(s.owner, applied.deployment_ids[0]!, [
        "active",
        "failed",
      ]);
      expect(promoted).toMatchObject({
        status: "active",
        trigger: "promote",
        image: stagingDeployment.image,
        build_id: stagingDeployment.build_id,
      });
      expect(await builds()).toBe(before);
      expect(agent.received.filter((m) => m.type === "build_job")).toHaveLength(1);

      // Nothing left to promote.
      expect(
        (
          await s.owner.json(`/v1/environments/${s.prodId}/promote`, {
            method: "POST",
            json: { from_environment_id: staging.id, include: { variables: "all" } },
          })
        ).status,
      ).toBe(409);
      const proposed = await env.DB.prepare(
        "SELECT count(*) AS n FROM audit_logs WHERE action = 'environment.promote_proposed'",
      ).first<{ n: number }>();
      expect(proposed?.n).toBe(1);
    },
    TIMEOUT,
  );
});

describe("delete", () => {
  it(
    "retires a staging environment and refuses production, a wrong slug and missing rights",
    async () => {
      const s = await stage();
      const staging = await ok(
        createEnv(s.owner, s.projectId, {
          name: "Staging",
          clone: { from_environment_id: s.prodId },
        }),
        201,
      );
      const del = (c: Client, id: string, confirm: string) =>
        c.json<{ error?: { code: string } }>(
          `/v1/environments/${id}?confirm=${encodeURIComponent(confirm)}`,
          { method: "DELETE" },
        );
      expect((await del(s.owner, s.prodId, "production")).status).toBe(409);
      expect((await del(s.owner, staging.id, "nope")).status).toBe(400);
      const viewer = await addMember(s.owner, s.workspaceId, "viewer@example.com", "viewer");
      expect((await del(viewer, staging.id, staging.slug)).status).toBe(403);

      await ok(
        s.owner.json(`/v1/environments/${staging.id}/protection`, {
          method: "PUT",
          json: { protected: true },
        }),
      );
      // A developer may delete environments, but not a protected one.
      const dev = await addMember(s.owner, s.workspaceId, "dev@example.com", "member");
      expect((await del(dev, staging.id, staging.slug)).status).toBe(403);

      const res = await s.owner.request(`/v1/environments/${staging.id}?confirm=${staging.slug}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(204);
      const listed = await ok(
        s.owner.json<{ environments: { id: string }[] }>(
          `/v1/projects/${s.projectId}/environments`,
        ),
      );
      expect(listed.environments.some((e) => e.id === staging.id)).toBe(false);
      const volumes = await env.DB.prepare("SELECT status FROM volumes WHERE environment_id = ?")
        .bind(staging.id)
        .all<{ status: string }>();
      expect(volumes.results.every((v) => v.status === "pending_deletion")).toBe(true);
      expect((await del(s.owner, staging.id, staging.slug)).status).toBe(404);
      const audit = await env.DB.prepare(
        "SELECT actor_type FROM audit_logs WHERE action = 'environment.deleted'",
      ).first<{ actor_type: string }>();
      expect(audit?.actor_type).toBe("user");
    },
    TIMEOUT,
  );

  it(
    "keeps the base of enabled previews",
    async () => {
      const s = await stage();
      const staging = await ok(
        createEnv(s.owner, s.projectId, {
          name: "Staging",
          clone: { from_environment_id: s.prodId },
        }),
        201,
      );
      await ok(
        s.owner.json(`/v1/projects/${s.projectId}/preview-settings`, {
          method: "PUT",
          json: { enabled: true, base_environment_id: staging.id },
        }),
      );
      const res = await s.owner.json(`/v1/environments/${staging.id}?confirm=${staging.slug}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(409);
    },
    TIMEOUT,
  );
});
