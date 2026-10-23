/**
 * Staged changes and the project canvas (ADR 0006): staging into the shared
 * draft with coalescing and optimistic revisions, sealed staged secrets that
 * never appear in a response, audit row, realtime frame or the database in
 * plaintext, apply (re-authorization per op and per environment, rebase and
 * conflicts, reference validation, deployments, atomicity), discard, and
 * the canvas's derived edges and layout.
 */
import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { API_TOKEN_PRESETS } from "@roundhouse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHANGE_ROUTES, POLICY_KEY, policyOf } from "../src/contracts";
import { app } from "../src/index";
import { addMember, type Client, call, failStatement, install, ORIGIN } from "./helpers";
import { createProject, createService } from "./pipeline-helpers";

const SECRET = "staged-only-secret-Vq3nB8xK2mP5tR9wL4";
const SECRET_2 = "another-staged-secret-Hj7Fd2Ks9Lq4Wz";
// biome-ignore-start lint/suspicious/noTemplateCurlyInString: `${{…}}` is variable-reference syntax, not a template.
const MALFORMED_REF = "${{db.";
const DATABASE_URL = "postgres://app:${{db.PASSWORD}}@${{db.ROUNDHOUSE_PRIVATE_DOMAIN}}/app";
const CACHE_HOST = "${{cache.ROUNDHOUSE_PRIVATE_DOMAIN}}";
const UNKNOWN_REF = "${{queue.URL}}";
// biome-ignore-end lint/suspicious/noTemplateCurlyInString: see above

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
beforeEach(async () => {
  introspector = await introspectWorkflow(env.DEPLOY_WORKFLOW);
});
afterEach(async () => {
  await introspector?.dispose();
  introspector = undefined;
});

interface StagedChangeBody {
  id: string;
  target_key: string;
  status: string;
  summary: string;
  op: Record<string, unknown>;
  diff: { path: string; before: unknown; after: unknown }[];
  conflict: unknown;
}

interface ChangeSetBody {
  id: string;
  status: string;
  revision: number;
  is_draft: boolean;
  op_count: number;
  conflicted_count: number;
  error: { code: string; message: string } | null;
  changes: StagedChangeBody[];
}

interface ErrorBody {
  error: { code: string; message: string; details?: { field: string; code: string }[] };
}

async function setup() {
  const installed = await install();
  const project = await createProject(installed.owner, installed.workspaceId);
  const env0 = project.environments[0]!;
  const api = await createService(installed.owner, project.id, {
    name: "api",
    source: { type: "image", image: "ghcr.io/acme/api:1" },
  });
  return { ...installed, project, envId: env0.id, apiId: api.service.id };
}

function stageDraft(c: Client, envId: string, op: Record<string, unknown>, expected?: number) {
  return c.json<ChangeSetBody & ErrorBody>(`/v1/environments/${envId}/draft/ops`, {
    method: "POST",
    json: { op, ...(expected !== undefined ? { expected_revision: expected } : {}) },
  });
}

function apply(
  c: Client,
  setId: string,
  revision: number,
  deploy: "affected" | "none" = "affected",
) {
  return c.json<
    { change_set: ChangeSetBody; deployment_ids: string[]; skipped: unknown[] } & ErrorBody
  >(`/v1/change-sets/${setId}/apply`, {
    method: "POST",
    json: { expected_revision: revision, deploy },
  });
}

async function latestConfig(c: Client, serviceId: string, envId: string) {
  const res = await c.json<{
    version: number;
    deploy: { replicas: number };
    resources: { memory_mb: number };
  }>(`/v1/services/${serviceId}/config?environment_id=${envId}`);
  return res.body;
}

async function auditRows(action?: string) {
  const { results } = await env.DB.prepare(
    `SELECT action, metadata FROM audit_logs ${action ? "WHERE action = ?" : ""} ORDER BY seq`,
  )
    .bind(...(action ? [action] : []))
    .all<{ action: string; metadata: string | null }>();
  return results;
}

describe("contracts", () => {
  it("serves every change route with its policy, and audits only mutations", () => {
    const live = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } });
    for (const [name, route] of Object.entries(CHANGE_ROUTES)) {
      const item = live.paths?.[route.path] as Record<string, Record<string, unknown>> | undefined;
      const op = item?.[route.method];
      expect(op, name).toBeDefined();
      expect(op?.[POLICY_KEY]).toEqual(policyOf(route));
      if (route.method === "get") expect(policyOf(route).audit, name).toEqual([]);
    }
  });
});

describe("staging", () => {
  it("stages into the shared draft, coalesces by target, and bumps the revision", async () => {
    const s = await setup();
    const first = await stageDraft(s.owner, s.envId, {
      type: "config.patch",
      service: s.apiId,
      patch: { deploy: { replicas: 2 } },
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ is_draft: true, status: "open", revision: 2, op_count: 1 });
    expect(first.body.changes[0]!.diff).toEqual([
      { path: "/deploy/replicas", before: 1, after: 2 },
    ]);

    const second = await stageDraft(
      s.owner,
      s.envId,
      { type: "config.patch", service: s.apiId, patch: { resources: { memory_mb: 256 } } },
      2,
    );
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.changes).toHaveLength(1);
    expect(second.body.changes[0]!.op).toMatchObject({
      patch: { deploy: { replicas: 2 }, resources: { memory_mb: 256 } },
    });
    expect(second.body.changes[0]!.diff.map((d) => d.path)).toEqual([
      "/deploy/replicas",
      "/resources/memory_mb",
    ]);

    const stale = await stageDraft(
      s.owner,
      s.envId,
      { type: "config.patch", service: s.apiId, patch: { deploy: { replicas: 3 } } },
      2,
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("change_set_changed");

    // Nothing was written to the service itself.
    expect((await latestConfig(s.owner, s.apiId, s.envId)).version).toBe(1);
  });

  it("refuses ops the caller's role or token can't perform, and invalid ones", async () => {
    const s = await setup();
    const viewer = await addMember(s.owner, s.workspaceId, "vic@example.com", "viewer");
    const denied = await stageDraft(viewer, s.envId, {
      type: "variable.set",
      scope: "service",
      service: s.apiId,
      key: "LOG_LEVEL",
      value: "debug",
    });
    expect(denied.status).toBe(403);

    const token = await s.owner.json<{ secret: string }>(`/v1/workspaces/${s.workspaceId}/tokens`, {
      method: "POST",
      json: { name: "ro", scopes: API_TOKEN_PRESETS.read, expires_in_days: 1 },
    });
    const viaToken = await call(`/v1/environments/${s.envId}/draft/ops`, {
      method: "POST",
      headers: { authorization: `Bearer ${token.body.secret}` },
      json: {
        op: { type: "config.patch", service: s.apiId, patch: { deploy: { replicas: 2 } } },
      },
    });
    expect(viaToken.status).toBe(403);

    const invalid = await stageDraft(s.owner, s.envId, {
      type: "config.patch",
      service: s.apiId,
      patch: { deploy: { replicas: 99 } },
    });
    expect(invalid.status).toBe(400);

    const unknown = await stageDraft(s.owner, s.envId, {
      type: "config.patch",
      service: "new:7",
      patch: { deploy: { replicas: 2 } },
    });
    expect(unknown.status).toBe(400);

    const malformed = await stageDraft(s.owner, s.envId, {
      type: "variable.set",
      scope: "service",
      service: s.apiId,
      key: "URL",
      value: MALFORMED_REF,
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("invalid_reference");
  });

  it("applies the classifier's rules when staging a secret", async () => {
    const s = await setup();
    const op = {
      type: "variable.set",
      scope: "service",
      service: s.apiId,
      key: "STRIPE_KEY",
      value: SECRET,
      tier: "secret",
    };
    const unconfirmed = await stageDraft(s.owner, s.envId, op);
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body.error.code).toBe("confirmation_required");
    expect(JSON.stringify(unconfirmed.body)).not.toContain(SECRET);

    const confirmed = await stageDraft(s.owner, s.envId, { ...op, confirm_write_only: true });
    expect(confirmed.status).toBe(200);
    const staged = confirmed.body.changes[0]!;
    expect(staged.op).toMatchObject({ key: "STRIPE_KEY", staged_tier: "secret" });
    expect(staged.op.fingerprint).toMatch(/^[a-f0-9]{8}$/);
    expect(staged.op).not.toHaveProperty("value");
    expect(staged.diff).toEqual([
      {
        path: "/variables/STRIPE_KEY",
        before: null,
        after: { tier: "secret", fingerprint: staged.op.fingerprint },
      },
    ]);
  });
});

describe("staged secrets", () => {
  it("never appear in any response, realtime frame, audit row or stored row", async () => {
    const s = await setup();
    const res = await SELF.fetch(`${ORIGIN}/v1/projects/${s.project.id}/realtime`, {
      headers: { upgrade: "websocket", origin: ORIGIN, cookie: s.owner.cookie },
    });
    const ws = res.webSocket!;
    ws.accept();
    const frames: string[] = [];
    ws.addEventListener("message", (e) => frames.push(String(e.data)));

    const bodies: string[] = [];
    const staged = await stageDraft(s.owner, s.envId, {
      type: "variable.set",
      scope: "service",
      service: s.apiId,
      key: "API_SECRET",
      value: SECRET,
      tier: "secret",
      confirm_write_only: true,
    });
    bodies.push(JSON.stringify(staged.body));
    const shared = await stageDraft(s.owner, s.envId, {
      type: "variable.set",
      scope: "shared",
      key: "SHARED_TOKEN",
      value: SECRET_2,
      tier: "secret",
      confirm_write_only: true,
    });
    bodies.push(JSON.stringify(shared.body));
    const setId = staged.body.id;

    for (const path of [
      `/v1/environments/${s.envId}/draft`,
      `/v1/change-sets/${setId}`,
      `/v1/change-sets/${setId}/diff`,
      `/v1/environments/${s.envId}/change-sets?status=all`,
      `/v1/projects/${s.project.id}/canvas?environment_id=${s.envId}`,
    ]) {
      const read = await s.owner.request(path);
      expect(read.status, path).toBe(200);
      bodies.push(await read.text());
    }

    const { results: stored } = await env.DB.prepare(
      "SELECT op, value_sealed, diff FROM staged_changes",
    ).all<{ op: string; value_sealed: string; diff: string }>();
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(row.value_sealed).toMatch(/"ct"/);
      bodies.push(row.op, row.value_sealed, row.diff);
    }

    const applied = await apply(s.owner, setId, shared.body.revision, "none");
    expect(applied.status).toBe(200);
    bodies.push(JSON.stringify(applied.body));
    const after = await env.DB.prepare("SELECT value_sealed FROM staged_changes").all<{
      value_sealed: string | null;
    }>();
    expect(after.results.every((r) => r.value_sealed === null)).toBe(true);

    const vars = await s.owner.request(
      `/v1/services/${s.apiId}/variables?environment_id=${s.envId}`,
    );
    bodies.push(await vars.text());
    for (const row of await auditRows()) bodies.push(row.metadata ?? "");
    await new Promise((r) => setTimeout(r, 200));
    expect(frames.some((f) => f.includes("change_set.updated"))).toBe(true);
    bodies.push(...frames);
    ws.close();

    for (const text of bodies) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(SECRET_2);
    }
    // The applied value went through the normal write path: stored as a secret.
    expect(
      JSON.parse(
        await (
          await s.owner.request(`/v1/services/${s.apiId}/variables?environment_id=${s.envId}`)
        ).text(),
      ),
    ).toMatchObject({
      variables: [{ key: "API_SECRET", tier: "secret", value: null }],
    });
  });
});

describe("apply", () => {
  it("writes config versions and variables, deploys affected services, and audits without values", async () => {
    const s = await setup();
    const db = await createService(s.owner, s.project.id, {
      name: "db",
      kind: "database",
      source: { type: "image", image: "postgres:17" },
    });
    await stageDraft(s.owner, s.envId, {
      type: "variable.set",
      scope: "service",
      service: db.service.id,
      key: "PASSWORD",
      value: SECRET,
      tier: "secret",
      confirm_write_only: true,
    });
    const url = await stageDraft(s.owner, s.envId, {
      type: "variable.set",
      scope: "service",
      service: s.apiId,
      key: "DATABASE_URL",
      value: DATABASE_URL,
      confirm_write_only: true,
    });
    expect(url.status).toBe(200);
    const draft = await stageDraft(s.owner, s.envId, {
      type: "config.patch",
      service: s.apiId,
      patch: { deploy: { replicas: 2 } },
    });

    const review = await s.owner.json<{ deploys: { service: string; reason: string }[] }>(
      `/v1/change-sets/${draft.body.id}/diff`,
    );
    expect(review.body.deploys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ service: s.apiId, reason: "config" }),
        expect.objectContaining({ service: db.service.id, reason: "variables" }),
      ]),
    );

    const res = await apply(s.owner, draft.body.id, draft.body.revision);
    expect(res.status).toBe(200);
    expect(res.body.change_set.status).toBe("applied");
    expect(res.body.deployment_ids).toHaveLength(2);
    expect((await latestConfig(s.owner, s.apiId, s.envId)).deploy.replicas).toBe(2);

    const { results: deps } = await env.DB.prepare(
      "SELECT service_id, trigger, change_set_id FROM deployments ORDER BY id",
    ).all<{ service_id: string; trigger: string; change_set_id: string }>();
    // The database deploys first.
    expect(deps.map((d) => d.service_id)).toEqual([db.service.id, s.apiId]);
    for (const d of deps)
      expect(d).toMatchObject({ trigger: "change_set", change_set_id: draft.body.id });

    const [appliedAudit] = await auditRows("change_set.applied");
    expect(JSON.parse(appliedAudit!.metadata!)).toMatchObject({
      environment_id: s.envId,
      ops: expect.arrayContaining(["set db.PASSWORD", "set api.DATABASE_URL"]),
    });
    const varAudits = await auditRows("variables.updated");
    expect(varAudits).toHaveLength(2);
    for (const row of [...varAudits, appliedAudit!]) {
      expect(row.metadata).not.toContain(SECRET);
      expect(row.metadata).not.toContain("postgres://");
    }
    for (const row of varAudits) {
      expect(JSON.parse(row.metadata!).change_set_id).toBe(draft.body.id);
    }

    // The draft is gone; the next staged change opens a new one.
    const next = await s.owner.json<{ change_set: unknown }>(`/v1/environments/${s.envId}/draft`);
    expect(next.body.change_set).toBeNull();
  });

  it("applies exactly what was reviewed: a stale revision is refused", async () => {
    const s = await setup();
    const draft = await stageDraft(s.owner, s.envId, {
      type: "config.patch",
      service: s.apiId,
      patch: { deploy: { replicas: 2 } },
    });
    await stageDraft(s.owner, s.envId, {
      type: "config.patch",
      service: s.apiId,
      patch: { deploy: { replicas: 5 } },
    });
    const res = await apply(s.owner, draft.body.id, draft.body.revision);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("change_set_changed");
    expect((await latestConfig(s.owner, s.apiId, s.envId)).version).toBe(1);
  });

  it("rebases onto disjoint direct edits and refuses overlapping ones until resolved", async () => {
    const s = await setup();
    const draft = await stageDraft(s.owner, s.envId, {
      type: "config.patch",
      service: s.apiId,
      patch: { deploy: { replicas: 3 } },
    });
    // Someone else changes memory directly: a different pointer, so it merges.
    await s.owner.json(`/v1/services/${s.apiId}`, {
      method: "PATCH",
      json: { environment_id: s.envId, resources: { memory_mb: 1024 } },
    });
    // …and replicas: the same pointer, a real conflict.
    await s.owner.json(`/v1/services/${s.apiId}`, {
      method: "PATCH",
      json: { environment_id: s.envId, deploy: { replicas: 4 } },
    });
    const refused = await apply(s.owner, draft.body.id, draft.body.revision, "none");
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("change_set_conflict");
    expect(refused.body.error.details).toEqual([
      expect.objectContaining({ field: draft.body.changes[0]!.id, code: "conflict" }),
    ]);

    const set = await s.owner.json<ChangeSetBody>(`/v1/change-sets/${draft.body.id}`);
    expect(set.body).toMatchObject({ status: "open", conflicted_count: 1 });
    expect(set.body.changes[0]!.conflict).toMatchObject({ paths: ["/deploy/replicas"] });

    const resolved = await s.owner.json<ChangeSetBody>(
      `/v1/change-sets/${draft.body.id}/ops/${draft.body.changes[0]!.id}/resolve`,
      { method: "POST", json: { keep: "mine", expected_revision: set.body.revision } },
    );
    expect(resolved.status).toBe(200);
    const ok = await apply(s.owner, draft.body.id, resolved.body.revision, "none");
    expect(ok.status).toBe(200);
    const config = await latestConfig(s.owner, s.apiId, s.envId);
    expect(config).toMatchObject({ deploy: { replicas: 3 }, resources: { memory_mb: 1024 } });
  });

  it("drops an op whose variable changed directly when the caller takes theirs", async () => {
    const s = await setup();
    const draft = await stageDraft(s.owner, s.envId, {
      type: "variable.set",
      scope: "service",
      service: s.apiId,
      key: "LOG_LEVEL",
      value: "debug",
    });
    await s.owner.json(`/v1/services/${s.apiId}/variables?environment_id=${s.envId}`, {
      method: "PUT",
      json: { set: [{ key: "LOG_LEVEL", value: "warn" }] },
    });
    const refused = await apply(s.owner, draft.body.id, draft.body.revision);
    expect(refused.status).toBe(409);
    const set = await s.owner.json<ChangeSetBody>(`/v1/change-sets/${draft.body.id}`);
    const theirs = await s.owner.json<ChangeSetBody>(
      `/v1/change-sets/${draft.body.id}/ops/${set.body.changes[0]!.id}/resolve`,
      { method: "POST", json: { keep: "theirs", expected_revision: set.body.revision } },
    );
    expect(theirs.body.changes).toEqual([]);
  });

  it("re-authorizes every op for the applier in a protected environment", async () => {
    const s = await setup();
    const dev = await addMember(s.owner, s.workspaceId, "dev@example.com", "member");
    await env.DB.prepare("UPDATE environments SET protected = 1 WHERE id = ?").bind(s.envId).run();

    // A developer may propose a variable change they can't make directly here…
    const draft = await stageDraft(dev, s.envId, {
      type: "variable.set",
      scope: "service",
      service: s.apiId,
      key: "FEATURE_FLAG",
      value: "on",
    });
    expect(draft.status).toBe(200);
    // …but not apply it: the variables rule admits project admins only.
    const refused = await apply(dev, draft.body.id, draft.body.revision);
    expect(refused.status).toBe(403);
    expect(refused.body.error.details?.[0]).toMatchObject({ code: "forbidden" });
    const still = await s.owner.json<ChangeSetBody>(`/v1/change-sets/${draft.body.id}`);
    expect(still.body).toMatchObject({ status: "open", revision: draft.body.revision });

    const ok = await apply(s.owner, draft.body.id, draft.body.revision);
    expect(ok.status).toBe(200);
  });

  it("creates services by ref, resolves references to them, and validates every reference", async () => {
    const s = await setup();
    await stageDraft(s.owner, s.envId, {
      type: "service.create",
      ref: "new:1",
      name: "cache",
      source: { type: "image", image: "valkey/valkey:8" },
    });
    await stageDraft(s.owner, s.envId, {
      type: "config.patch",
      service: "new:1",
      patch: { networking: { port: 6379 } },
    });
    const draft = await stageDraft(s.owner, s.envId, {
      type: "variable.set",
      scope: "service",
      service: s.apiId,
      key: "CACHE_HOST",
      value: CACHE_HOST,
    });
    expect(draft.body.changes.map((c) => c.target_key)).toEqual([
      "create:new:1",
      `var:${s.apiId}:CACHE_HOST`,
    ]);

    const canvas = await s.owner.json<{
      nodes: { id: string; staged: string | null }[];
      edges: { from: string; to: string; kind: string; state: string }[];
    }>(`/v1/projects/${s.project.id}/canvas?environment_id=${s.envId}`);
    expect(canvas.body.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "new:1", staged: "create" })]),
    );
    expect(canvas.body.edges).toEqual([
      expect.objectContaining({
        from: s.apiId,
        to: "new:1",
        kind: "private_network",
        state: "staged",
      }),
    ]);

    const res = await apply(s.owner, draft.body.id, draft.body.revision, "none");
    expect(res.status).toBe(200);
    const created = res.body.change_set.changes.find((c) => c.op.type === "service.create")!;
    const services = await s.owner.json<{ services: { id: string; slug: string }[] }>(
      `/v1/projects/${s.project.id}/services`,
    );
    const cache = services.body.services.find((x) => x.slug === "cache")!;
    expect(cache).toBeDefined();
    expect(created.status).toBe("applied");
    const config = await s.owner.json<{ networking: { port: number } }>(
      `/v1/services/${cache.id}/config?environment_id=${s.envId}`,
    );
    expect(config.body.networking.port).toBe(6379);

    const after = await s.owner.json<{ edges: { from: string; to: string; state: string }[] }>(
      `/v1/projects/${s.project.id}/canvas?environment_id=${s.envId}`,
    );
    expect(after.body.edges).toEqual([
      expect.objectContaining({ from: s.apiId, to: cache.id, state: "current" }),
    ]);

    const broken = await stageDraft(s.owner, s.envId, {
      type: "variable.set",
      scope: "service",
      service: s.apiId,
      key: "QUEUE_URL",
      value: UNKNOWN_REF,
    });
    const invalid = await apply(s.owner, broken.body.id, broken.body.revision, "none");
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.code).toBe("invalid_references");
    const reopened = await s.owner.json<ChangeSetBody>(`/v1/change-sets/${broken.body.id}`);
    expect(reopened.body.status).toBe("open");
    expect(reopened.body.error?.code).toBe("invalid_references");
  });

  it("writes nothing when the service batch fails, and returns the set to open", async () => {
    const s = await setup();
    await stageDraft(s.owner, s.envId, {
      type: "service.create",
      ref: "new:1",
      name: "worker",
      source: { type: "image", image: "ghcr.io/acme/worker:1" },
    });
    const draft = await stageDraft(s.owner, s.envId, {
      type: "config.patch",
      service: s.apiId,
      patch: { deploy: { replicas: 2 } },
    });
    const restore = failStatement(/^insert into "service_configs"/);
    let res: Awaited<ReturnType<typeof apply>>;
    try {
      res = await apply(s.owner, draft.body.id, draft.body.revision, "none");
    } finally {
      restore();
    }
    expect(res.status).toBe(500);
    const services = await env.DB.prepare("SELECT slug FROM services").all<{ slug: string }>();
    expect(services.results.map((r) => r.slug)).toEqual(["api"]);
    expect((await latestConfig(s.owner, s.apiId, s.envId)).version).toBe(1);
    const set = await s.owner.json<ChangeSetBody>(`/v1/change-sets/${draft.body.id}`);
    expect(set.body.status).toBe("open");
    expect(set.body.changes.every((c) => c.status === "pending")).toBe(true);
    expect((await auditRows("service.created")).length).toBe(1);

    const retry = await apply(s.owner, draft.body.id, set.body.revision, "none");
    expect(retry.status).toBe(200);
  });
});

describe("discard and unstage", () => {
  it("discards a set, erasing its sealed values, and audits keys only", async () => {
    const s = await setup();
    const draft = await stageDraft(s.owner, s.envId, {
      type: "variable.set",
      scope: "service",
      service: s.apiId,
      key: "TOKEN",
      value: SECRET,
      tier: "secret",
      confirm_write_only: true,
    });
    const res = await s.owner.json<ChangeSetBody>(`/v1/change-sets/${draft.body.id}/discard`, {
      method: "POST",
      json: { expected_revision: draft.body.revision },
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("discarded");
    const rows = await env.DB.prepare("SELECT value_sealed FROM staged_changes").all<{
      value_sealed: string | null;
    }>();
    expect(rows.results.every((r) => r.value_sealed === null)).toBe(true);
    const [audit] = await auditRows("change_set.discarded");
    expect(JSON.parse(audit!.metadata!).ops).toEqual(["set api.TOKEN"]);
    expect(audit!.metadata).not.toContain(SECRET);

    const again = await apply(s.owner, draft.body.id, res.body.revision);
    expect(again.status).toBe(409);
  });

  it("unstages a created service together with the ops on it", async () => {
    const s = await setup();
    const created = await stageDraft(s.owner, s.envId, {
      type: "service.create",
      ref: "new:1",
      name: "worker",
      source: { type: "image", image: "ghcr.io/acme/worker:1" },
    });
    const withVar = await stageDraft(s.owner, s.envId, {
      type: "variable.set",
      scope: "service",
      service: "new:1",
      key: "MODE",
      value: "batch",
    });
    expect(withVar.body.changes).toHaveLength(2);
    const res = await s.owner.json<ChangeSetBody>(
      `/v1/change-sets/${created.body.id}/ops/${created.body.changes[0]!.id}?expected_revision=${withVar.body.revision}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect(res.body.changes).toEqual([]);
  });
});

describe("canvas layout", () => {
  it("stores positions per project with optimistic versions", async () => {
    const s = await setup();
    const first = await s.owner.json<{ positions: Record<string, unknown>; version: number }>(
      `/v1/projects/${s.project.id}/canvas/layout`,
      {
        method: "PATCH",
        json: {
          positions: { [s.apiId]: { x: 320, y: 160 }, svc_unknown: { x: 1, y: 1 } },
          expected_version: 0,
        },
      },
    );
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ positions: { [s.apiId]: { x: 320, y: 160 } }, version: 1 });
    const stale = await s.owner.json(`/v1/projects/${s.project.id}/canvas/layout`, {
      method: "PATCH",
      json: { positions: { [s.apiId]: { x: 0, y: 0 } }, expected_version: 0 },
    });
    expect(stale.status).toBe(409);
    const canvas = await s.owner.json<{ positions: unknown; layout_version: number }>(
      `/v1/projects/${s.project.id}/canvas?environment_id=${s.envId}`,
    );
    expect(canvas.body).toMatchObject({
      positions: { [s.apiId]: { x: 320, y: 160 } },
      layout_version: 1,
    });

    const viewer = await addMember(s.owner, s.workspaceId, "vee@example.com", "viewer");
    const denied = await viewer.json(`/v1/projects/${s.project.id}/canvas/layout`, {
      method: "PATCH",
      json: { positions: {}, expected_version: 1 },
    });
    expect(denied.status).toBe(403);
  });
});
