/**
 * Canvas follow-ups to ADR 0006: change set review (submit, approve, reject,
 * approvals bound to a revision, self-review refused, protection that
 * requires approval, API tokens and `changes:auto_apply`), the rebase
 * route, explicit service edges, volume and domain ops staged and applied
 * through the direct routes' rules, database nodes on the canvas, the
 * `staged_changes` workspace flag, the workspace review queue, and that no
 * staged secret ever leaves the server through any of them.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { API_TOKEN_PRESETS, VOLUME_DELETE_GRACE_MS } from "@roundhouse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CHANGE_ROUTES, POLICY_KEY, policyOf } from "../src/contracts";
import { setDnsTransport } from "../src/lib/domains/dns";
import { app } from "../src/index";
import { addMember, type Client, call, install } from "./helpers";
import { createProject, createService } from "./pipeline-helpers";

const SECRET = "review-only-secret-Tq7Wm2Lp9Xz4Kd8";

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
beforeEach(async () => {
  introspector = await introspectWorkflow(env.DEPLOY_WORKFLOW);
  // Every lookup answers NXDOMAIN: domains stay pending, which is all these tests need.
  setDnsTransport((async () => Response.json({ Status: 3 })) as typeof fetch);
});
afterEach(async () => {
  setDnsTransport(null);
  await introspector?.dispose();
  introspector = undefined;
});

interface ChangeSetBody {
  id: string;
  status: string;
  revision: number;
  review_status: string;
  approved_by: string | null;
  rejected_by: string | null;
  submitted_by: string | null;
  review_note: string | null;
  op_count: number;
  changes: {
    id: string;
    status: string;
    op: Record<string, unknown>;
    diff: { path: string; before: unknown; after: unknown }[];
  }[];
}

interface ErrorBody {
  error: { code: string; message: string };
}

async function setup() {
  const installed = await install();
  const project = await createProject(installed.owner, installed.workspaceId);
  const envId = project.environments[0]!.id;
  const api = await createService(installed.owner, project.id, {
    name: "api",
    source: { type: "image", image: "ghcr.io/acme/api:1" },
  });
  const admin = await addMember(installed.owner, installed.workspaceId, "ada@example.com", "admin");
  const dev = await addMember(installed.owner, installed.workspaceId, "dev@example.com", "member");
  return { ...installed, project, envId, apiId: api.service.id, admin, dev };
}

function stageDraft(c: Client, envId: string, op: Record<string, unknown>) {
  return c.json<ChangeSetBody & ErrorBody>(`/v1/environments/${envId}/draft/ops`, {
    method: "POST",
    json: { op },
  });
}

function post<T = ChangeSetBody>(c: Client, path: string, json: unknown) {
  return c.json<T & ErrorBody>(path, { method: "POST", json });
}

function apply(c: Client, set: { id: string; revision: number }) {
  return post<{ change_set: ChangeSetBody; deployment_ids: string[] }>(
    c,
    `/v1/change-sets/${set.id}/apply`,
    { expected_revision: set.revision, deploy: "none" },
  );
}

async function requireApproval(envId: string, on = true) {
  await env.DB.prepare("UPDATE environments SET protected = 1, require_approval = ? WHERE id = ?")
    .bind(on ? 1 : 0, envId)
    .run();
}

async function auditRows(prefix: string) {
  const { results } = await env.DB.prepare(
    "SELECT action, actor_type, metadata FROM audit_logs WHERE action LIKE ? ORDER BY seq",
  )
    .bind(`${prefix}%`)
    .all<{ action: string; actor_type: string; metadata: string | null }>();
  return results;
}

async function mint(c: Client, workspaceId: string, scopes: readonly string[]) {
  const res = await c.json<{ secret: string }>(`/v1/workspaces/${workspaceId}/tokens`, {
    method: "POST",
    json: { name: "ci", scopes, expires_in_days: 1 },
  });
  if (res.status !== 201) throw new Error(`mint: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.secret;
}

function asToken(secret: string, path: string, json?: unknown) {
  return call(path, {
    method: json === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${secret}` },
    ...(json !== undefined ? { json } : {}),
  });
}

describe("contracts", () => {
  it("serves every new change route with its policy", () => {
    const live = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } });
    for (const name of [
      "submitChangeSet",
      "approveChangeSet",
      "rejectChangeSet",
      "rebaseChangeSet",
      "addServiceEdge",
      "removeServiceEdge",
      "listWorkspaceChangeSets",
    ] as const) {
      const route = CHANGE_ROUTES[name];
      const item = live.paths?.[route.path] as Record<string, Record<string, unknown>> | undefined;
      expect(item?.[route.method]?.[POLICY_KEY], name).toEqual(policyOf(route));
    }
    expect(policyOf(CHANGE_ROUTES.approveChangeSet)).toMatchObject({
      action: "changes:approve",
      audit: ["change_set.approved"],
    });
    expect(policyOf(CHANGE_ROUTES.rejectChangeSet).action).toBe("changes:approve");
  });
});

describe("review", () => {
  it("submits, approves the reviewed revision, and voids the approval on any edit", async () => {
    const s = await setup();
    const staged = await stageDraft(s.dev, s.envId, {
      type: "config.patch",
      service: s.apiId,
      patch: { deploy: { replicas: 2 } },
    });
    expect(staged.body.review_status).toBe("none");

    const submitted = await post(s.dev, `/v1/change-sets/${staged.body.id}/submit`, {
      note: "Scale api for the launch",
    });
    expect(submitted.status).toBe(200);
    expect(submitted.body).toMatchObject({
      review_status: "submitted",
      revision: staged.body.revision,
      review_note: "Scale api for the launch",
    });
    // Submitting again changes nothing.
    const again = await post(s.dev, `/v1/change-sets/${staged.body.id}/submit`, {});
    expect(again.body.revision).toBe(staged.body.revision);

    const byOwner = await post(s.owner, `/v1/change-sets/${staged.body.id}/approve`, {
      expected_revision: staged.body.revision,
    });
    expect(byOwner.body).toMatchObject({ review_status: "approved", revision: staged.body.revision });

    // An author can't review the set they staged into, whatever their role.
    const selfStaged = await stageDraft(s.admin, s.envId, {
      type: "config.patch",
      service: s.apiId,
      patch: { resources: { memory_mb: 256 } },
    });
    const selfReview = await post(s.admin, `/v1/change-sets/${selfStaged.body.id}/approve`, {
      expected_revision: selfStaged.body.revision,
    });
    expect(selfReview.status).toBe(403);
    expect(selfReview.body.error.code).toBe("self_review");

    // The admin's edit voided the owner's approval.
    const now = await s.owner.json<ChangeSetBody>(`/v1/change-sets/${staged.body.id}`);
    expect(now.body).toMatchObject({ review_status: "submitted", approved_by: null });
    expect(now.body.revision).toBeGreaterThan(staged.body.revision);

    // A member (developer) holds no changes:approve.
    const devApprove = await post(s.dev, `/v1/change-sets/${staged.body.id}/approve`, {
      expected_revision: now.body.revision,
    });
    expect(devApprove.status).toBe(403);

    // An approval names the revision the reviewer saw.
    const stale = await post(s.owner, `/v1/change-sets/${staged.body.id}/approve`, {
      expected_revision: staged.body.revision,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("change_set_changed");

    expect((await auditRows("change_set.")).map((r) => r.action)).toEqual([
      "change_set.submitted",
      "change_set.approved",
    ]);
  });

  it("refuses to apply a rejected set until it changes", async () => {
    const s = await setup();
    const staged = await stageDraft(s.dev, s.envId, {
      type: "config.patch",
      service: s.apiId,
      patch: { deploy: { replicas: 2 } },
    });
    const rejected = await post(s.owner, `/v1/change-sets/${staged.body.id}/reject`, {
      expected_revision: staged.body.revision,
      note: "Not before the freeze ends",
    });
    expect(rejected.body).toMatchObject({ review_status: "rejected", review_note: "Not before the freeze ends" });
    const refused = await apply(s.dev, rejected.body);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("change_set_rejected");

    const edited = await stageDraft(s.dev, s.envId, {
      type: "config.patch",
      service: s.apiId,
      patch: { deploy: { replicas: 3 } },
    });
    expect(edited.body.review_status).toBe("submitted");
    expect((await apply(s.dev, edited.body)).status).toBe(200);
    const audit = await auditRows("change_set.rejected");
    expect(audit).toHaveLength(1);
    // A reviewer's words stay out of the audit log, like every user-written value.
    expect(audit[0]!.metadata).not.toContain("freeze");
  });

  it("requires an approval where protection says so, and keeps approver and applier apart", async () => {
    const s = await setup();
    await requireApproval(s.envId);
    const staged = await stageDraft(s.dev, s.envId, {
      type: "config.patch",
      service: s.apiId,
      patch: { deploy: { replicas: 2 } },
    });
    const unapproved = await apply(s.dev, staged.body);
    expect(unapproved.status).toBe(403);
    expect(unapproved.body.error.code).toBe("approval_required");
    // Nothing was locked or written.
    const still = await s.dev.json<ChangeSetBody>(`/v1/change-sets/${staged.body.id}`);
    expect(still.body).toMatchObject({ status: "open", revision: staged.body.revision });

    const approved = await post(s.admin, `/v1/change-sets/${staged.body.id}/approve`, {
      expected_revision: staged.body.revision,
    });
    expect(approved.body.review_status).toBe("approved");
    const byApprover = await apply(s.admin, approved.body);
    expect(byApprover.status).toBe(403);
    expect(byApprover.body.error.message).toMatch(/someone else must apply/);

    const review = await s.dev.json<{ approval: Record<string, unknown> }>(
      `/v1/change-sets/${staged.body.id}/diff`,
    );
    expect(review.body.approval).toMatchObject({ required: true, approved: true });

    const ok = await apply(s.dev, approved.body);
    expect(ok.status).toBe(200);
    expect(ok.body.change_set.status).toBe("applied");
  });

  it("keeps an approval through a failed apply, since no op changed", async () => {
    const s = await setup();
    await requireApproval(s.envId);
    const staged = await stageDraft(s.owner, s.envId, {
      type: "variable.set",
      scope: "service",
      service: s.apiId,
      key: "QUEUE_URL",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a variable reference.
      value: "${{queue.URL}}",
    });
    expect(staged.status).toBe(200);
    const approved = await post(s.admin, `/v1/change-sets/${staged.body.id}/approve`, {
      expected_revision: staged.body.revision,
    });
    const failed = await apply(s.owner, approved.body);
    expect(failed.status).toBe(422);
    const after = await s.owner.json<ChangeSetBody>(`/v1/change-sets/${staged.body.id}`);
    expect(after.body).toMatchObject({ status: "open", review_status: "approved" });
    expect(after.body.revision).toBe(approved.body.revision + 1);

    // Taking the bad op out is an edit: the approval no longer covers the set.
    const unstaged = await s.owner.json<ChangeSetBody>(
      `/v1/change-sets/${staged.body.id}/ops/${staged.body.changes[0]!.id}?expected_revision=${after.body.revision}`,
      { method: "DELETE" },
    );
    expect(unstaged.body.review_status).toBe("submitted");
  });

  it("lets an API token apply only with changes:auto_apply, or a person's approval", async () => {
    const s = await setup();
    await env.DB.prepare("UPDATE environments SET protected = 0 WHERE id = ?").bind(s.envId).run();
    const plain = await mint(s.owner, s.workspaceId, API_TOKEN_PRESETS.deploy);
    const opened = await asToken(plain, `/v1/environments/${s.envId}/change-sets`, {
      ops: [{ type: "config.patch", service: s.apiId, patch: { deploy: { replicas: 2 } } }],
    });
    expect(opened.status).toBe(201);
    const set = (await opened.json()) as ChangeSetBody;
    const refused = await asToken(plain, `/v1/change-sets/${set.id}/apply`, {
      expected_revision: set.revision,
      deploy: "none",
    });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as ErrorBody).error).toMatchObject({
      code: "approval_required",
      message: expect.stringMatching(/changes:auto_apply/),
    });

    // A person's approval is enough for the token.
    const approved = await post(s.admin, `/v1/change-sets/${set.id}/approve`, {
      expected_revision: set.revision,
    });
    const ok = await asToken(plain, `/v1/change-sets/${set.id}/apply`, {
      expected_revision: approved.body.revision,
      deploy: "none",
    });
    expect(ok.status).toBe(200);

    // A token granted auto-apply needs nobody.
    const auto = await mint(s.owner, s.workspaceId, [
      ...API_TOKEN_PRESETS.deploy,
      "changes:auto_apply",
    ]);
    const second = (await (
      await asToken(auto, `/v1/environments/${s.envId}/change-sets`, {
        ops: [{ type: "config.patch", service: s.apiId, patch: { deploy: { replicas: 3 } } }],
      })
    ).json()) as ChangeSetBody;
    const applied = await asToken(auto, `/v1/change-sets/${second.id}/apply`, {
      expected_revision: second.revision,
      deploy: "none",
    });
    expect(applied.status).toBe(200);

  });

  it("leaves direct routes free of review: adding a database works where approval is required", async () => {
    const s = await setup();
    await requireApproval(s.envId);
    const res = await s.owner.json<{ service: { id: string } }>(
      `/v1/projects/${s.project.id}/databases`,
      { method: "POST", json: { engine: "postgres", environment_id: s.envId, deploy: false } },
    );
    expect(res.status).toBe(201);
  });
});

describe("rebase", () => {
  it("moves clean ops onto the current config, marks conflicts, and voids approvals", async () => {
    const s = await setup();
    const staged = await stageDraft(s.dev, s.envId, {
      type: "config.patch",
      service: s.apiId,
      patch: { deploy: { replicas: 2 } },
    });
    const approved = await post(s.owner, `/v1/change-sets/${staged.body.id}/approve`, {
      expected_revision: staged.body.revision,
    });
    // Nothing drifted: rebasing changes nothing.
    const noop = await post<{ change_set: ChangeSetBody; rebased: string[] }>(
      s.dev,
      `/v1/change-sets/${staged.body.id}/rebase`,
      { expected_revision: approved.body.revision },
    );
    expect(noop.body.rebased).toEqual([]);
    expect(noop.body.change_set).toMatchObject({
      revision: approved.body.revision,
      review_status: "approved",
    });

    await s.owner.json(`/v1/services/${s.apiId}`, {
      method: "PATCH",
      json: { environment_id: s.envId, resources: { memory_mb: 384 } },
    });
    const rebased = await post<{
      change_set: ChangeSetBody;
      rebased: string[];
      conflicts: unknown[];
    }>(s.dev, `/v1/change-sets/${staged.body.id}/rebase`, {
      expected_revision: approved.body.revision,
    });
    expect(rebased.status).toBe(200);
    expect(rebased.body.rebased).toEqual([staged.body.changes[0]!.id]);
    expect(rebased.body.conflicts).toEqual([]);
    expect(rebased.body.change_set.revision).toBe(approved.body.revision + 1);
    expect(rebased.body.change_set.review_status).toBe("submitted");

    await s.owner.json(`/v1/services/${s.apiId}`, {
      method: "PATCH",
      json: { environment_id: s.envId, deploy: { replicas: 5 } },
    });
    const conflicted = await post<{ change_set: ChangeSetBody; conflicts: { id: string }[] }>(
      s.dev,
      `/v1/change-sets/${staged.body.id}/rebase`,
      { expected_revision: rebased.body.change_set.revision },
    );
    expect(conflicted.body.conflicts.map((c) => c.id)).toEqual([staged.body.changes[0]!.id]);
    expect(conflicted.body.change_set.changes[0]!.status).toBe("conflicted");

    const viewer = await addMember(s.owner, s.workspaceId, "vic@example.com", "viewer");
    const denied = await post(viewer, `/v1/change-sets/${staged.body.id}/rebase`, {
      expected_revision: conflicted.body.change_set.revision,
    });
    expect(denied.status).toBe(403);
  });
});

describe("service edges", () => {
  it("connects services on the canvas, audited, and only within the project", async () => {
    const s = await setup();
    const worker = await createService(s.owner, s.project.id, {
      name: "worker",
      source: { type: "image", image: "ghcr.io/acme/worker:1" },
    });
    const added = await post<{ id: string }>(s.dev, `/v1/projects/${s.project.id}/edges`, {
      from_service_id: s.apiId,
      to_service_id: worker.service.id,
    });
    expect(added.status).toBe(201);
    expect(added.body.id).toMatch(/^edg_/);
    const duplicate = await post(s.dev, `/v1/projects/${s.project.id}/edges`, {
      from_service_id: s.apiId,
      to_service_id: worker.service.id,
    });
    expect(duplicate.status).toBe(409);
    const self = await post(s.dev, `/v1/projects/${s.project.id}/edges`, {
      from_service_id: s.apiId,
      to_service_id: s.apiId,
    });
    expect(self.status).toBe(400);

    const other = await createProject(s.owner, s.workspaceId, { name: "Elsewhere" });
    const outside = await createService(s.owner, other.id, {
      name: "far",
      source: { type: "image", image: "nginx:1.27" },
    });
    const crossing = await post(s.dev, `/v1/projects/${s.project.id}/edges`, {
      from_service_id: s.apiId,
      to_service_id: outside.service.id,
    });
    expect(crossing.status).toBe(404);

    const viewer = await addMember(s.owner, s.workspaceId, "vic@example.com", "viewer");
    const denied = await post(viewer, `/v1/projects/${s.project.id}/edges`, {
      from_service_id: worker.service.id,
      to_service_id: s.apiId,
    });
    expect(denied.status).toBe(403);

    const canvas = await s.dev.json<{ edges: { id: string; kind: string; state: string }[] }>(
      `/v1/projects/${s.project.id}/canvas?environment_id=${s.envId}`,
    );
    expect(canvas.body.edges).toContainEqual(
      expect.objectContaining({ id: added.body.id, kind: "explicit", state: "current" }),
    );

    // An edge to a deleted service stops showing.
    await s.owner.request(`/v1/services/${worker.service.id}`, { method: "DELETE" });
    const after = await s.dev.json<{ edges: { id: string }[] }>(
      `/v1/projects/${s.project.id}/canvas?environment_id=${s.envId}`,
    );
    expect(after.body.edges.map((e) => e.id)).not.toContain(added.body.id);

    const removed = await s.dev.request(`/v1/projects/${s.project.id}/edges/${added.body.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(204);
    const gone = await s.dev.request(`/v1/projects/${s.project.id}/edges/${added.body.id}`, {
      method: "DELETE",
    });
    expect(gone.status).toBe(404);
    expect((await auditRows("canvas.")).map((r) => r.action)).toEqual([
      "canvas.edge_added",
      "canvas.edge_removed",
    ]);
  });
});

describe("volume and domain ops", () => {
  it("creates, grows and deletes a volume through a change set, with the 72 h grace", async () => {
    const s = await setup();
    const missingPath = await stageDraft(s.dev, s.envId, {
      type: "volume.set",
      service: s.apiId,
      size_mb: 1024,
    });
    expect(missingPath.status).toBe(400);
    const unsafe = await stageDraft(s.dev, s.envId, {
      type: "volume.set",
      service: s.apiId,
      mount_path: "/proc/data",
      size_mb: 1024,
    });
    expect(unsafe.status).toBe(400);

    const created = await stageDraft(s.dev, s.envId, {
      type: "volume.set",
      service: s.apiId,
      mount_path: "/data",
      size_mb: 1024,
    });
    expect(created.status).toBe(200);
    expect(created.body.changes[0]!.diff).toEqual([
      { path: "/volume", before: null, after: { mount_path: "/data", size_mb: 1024 } },
    ]);
    // A service with a volume runs one replica, staged or not.
    const replicas = await stageDraft(s.dev, s.envId, {
      type: "config.patch",
      service: s.apiId,
      patch: { deploy: { replicas: 2 } },
    });
    expect(replicas.status).toBe(200);
    const tooMany = await apply(s.dev, replicas.body);
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.error.code).toBe("volume_requires_single_replica");
    const reverted = await s.dev.json<ChangeSetBody>(`/v1/change-sets/${created.body.id}`);
    const patchOp = reverted.body.changes.find((c) => c.op.type === "config.patch")!;
    const unstaged = await s.dev.json<ChangeSetBody>(
      `/v1/change-sets/${created.body.id}/ops/${patchOp.id}?expected_revision=${reverted.body.revision}`,
      { method: "DELETE" },
    );
    const applied = await apply(s.dev, unstaged.body);
    expect(applied.status).toBe(200);
    const volume = await s.dev.json<{ id: string; size_mb: number; mount_path: string }>(
      `/v1/services/${s.apiId}/volume?environment_id=${s.envId}`,
    );
    expect(volume.body).toMatchObject({ size_mb: 1024, mount_path: "/data" });

    const shrink = await stageDraft(s.dev, s.envId, {
      type: "volume.set",
      service: s.apiId,
      size_mb: 512,
    });
    expect(shrink.status).toBe(422);
    expect(shrink.body.error.code).toBe("volume_shrink_unsupported");
    const grow = await stageDraft(s.dev, s.envId, {
      type: "volume.set",
      service: s.apiId,
      size_mb: 2048,
    });
    expect(grow.body.changes[0]!.diff).toEqual([
      { path: "/volume/size_mb", before: 1024, after: 2048 },
    ]);
    expect((await apply(s.dev, grow.body)).status).toBe(200);

    const del = await stageDraft(s.dev, s.envId, { type: "volume.delete", service: s.apiId });
    const before = Date.now();
    expect((await apply(s.dev, del.body)).status).toBe(200);
    const gone = await env.DB.prepare(
      "SELECT status, delete_after FROM volumes WHERE id = ?",
    )
      .bind(volume.body.id)
      .first<{ status: string; delete_after: number }>();
    expect(gone?.status).toBe("pending_deletion");
    expect(gone!.delete_after).toBeGreaterThanOrEqual(before + VOLUME_DELETE_GRACE_MS);

    const actions = (await auditRows("volume.")).map((r) => r.action);
    expect(actions).toEqual(["volume.created", "volume.resized", "volume.deleted"]);
    for (const row of await auditRows("volume.")) {
      expect(JSON.parse(row.metadata!)).toHaveProperty("change_set_id");
    }
  });

  it("adds and removes custom domains with the direct route's rules", async () => {
    const s = await setup();
    const web = await createService(s.owner, s.project.id, {
      name: "web",
      source: { type: "image", image: "nginx:1.27" },
    });
    const own = await stageDraft(s.dev, s.envId, {
      type: "domain.add",
      service: web.service.id,
      hostname: "cp.test",
    });
    expect(own.status).toBe(422);
    expect(own.body.error.code).toBe("hostname_not_allowed");

    const staged = await stageDraft(s.dev, s.envId, {
      type: "domain.add",
      service: web.service.id,
      hostname: "Shop.Example.COM.",
    });
    expect(staged.status).toBe(200);
    expect(staged.body.changes[0]!.op).toMatchObject({ hostname: "shop.example.com" });

    // The protected production environment's config rule admits developers.
    expect((await apply(s.dev, staged.body)).status).toBe(200);
    const listed = await s.dev.json<{ domains: { id: string; hostname: string; type: string }[] }>(
      `/v1/services/${web.service.id}/domains?environment_id=${s.envId}`,
    );
    const domain = listed.body.domains.find((d) => d.hostname === "shop.example.com")!;
    expect(domain).toBeDefined();

    const taken = await stageDraft(s.dev, s.envId, {
      type: "domain.add",
      service: s.apiId,
      hostname: "shop.example.com",
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe("domain_taken");

    const canvas = await s.dev.json<{
      nodes: { id: string; domains: { hostname: string; staged: string | null }[] }[];
    }>(`/v1/projects/${s.project.id}/canvas?environment_id=${s.envId}`);
    expect(canvas.body.nodes.find((n) => n.id === web.service.id)!.domains).toEqual([
      expect.objectContaining({ hostname: "shop.example.com", staged: null }),
    ]);

    const remove = await stageDraft(s.dev, s.envId, { type: "domain.remove", domain_id: domain.id });
    expect(remove.body.changes[0]!.op).toMatchObject({
      hostname: "shop.example.com",
      service: web.service.id,
    });
    // Adding it back cancels the staged removal.
    const back = await stageDraft(s.dev, s.envId, {
      type: "domain.add",
      service: web.service.id,
      hostname: "shop.example.com",
    });
    expect(back.body.op_count).toBe(0);
    const again = await stageDraft(s.dev, s.envId, { type: "domain.remove", domain_id: domain.id });
    expect((await apply(s.dev, again.body)).status).toBe(200);
    const after = await s.dev.json<{ domains: { hostname: string }[] }>(
      `/v1/services/${web.service.id}/domains?environment_id=${s.envId}`,
    );
    expect(after.body.domains.map((d) => d.hostname)).not.toContain("shop.example.com");
    const audit = await auditRows("domain.");
    expect(audit.map((r) => r.action)).toEqual(["domain.added", "domain.removed"]);
    for (const row of audit) expect(JSON.parse(row.metadata!)).toHaveProperty("change_set_id");

    const viewer = await addMember(s.owner, s.workspaceId, "vic@example.com", "viewer");
    const denied = await stageDraft(viewer, s.envId, {
      type: "domain.add",
      service: web.service.id,
      hostname: "blog.example.com",
    });
    expect(denied.status).toBe(403);
  });
});

describe("canvas", () => {
  it("draws database nodes with engine, version and volume, live or staged", async () => {
    const s = await setup();
    await s.owner.json(`/v1/projects/${s.project.id}/databases`, {
      method: "POST",
      json: { engine: "postgres", environment_id: s.envId, deploy: false, size_mb: 2048 },
    });
    await stageDraft(s.dev, s.envId, {
      type: "service.create",
      ref: "new:1",
      name: "cache",
      kind: "database",
      database: { engine: "redis" },
    });
    const canvas = await s.dev.json<{
      staging: boolean;
      environment_requires_approval: boolean;
      nodes: {
        name: string;
        kind: string;
        staged: string | null;
        database: { engine: string; version: string } | null;
        volume: { size_mb: number; status: string | null; staged: string | null } | null;
      }[];
    }>(`/v1/projects/${s.project.id}/canvas?environment_id=${s.envId}`);
    expect(canvas.body).toMatchObject({ staging: true, environment_requires_approval: false });
    const pg = canvas.body.nodes.find((n) => n.database?.engine === "postgres")!;
    expect(pg).toMatchObject({
      kind: "database",
      volume: { size_mb: 2048, status: "pending", staged: null },
    });
    expect(pg.database!.version).toBeTruthy();
    expect(canvas.body.nodes.find((n) => n.name === "cache")).toMatchObject({
      staged: "create",
      database: { engine: "redis" },
      volume: { staged: "create" },
    });
    expect(canvas.body.nodes.find((n) => n.name === "api")).toMatchObject({
      database: null,
      volume: null,
    });
  });
});

describe("workspace settings and protection", () => {
  it("toggles staged_changes with workspace:update, audited", async () => {
    const s = await setup();
    const ws = await s.owner.json<{ staged_changes: boolean }>(`/v1/workspaces/${s.workspaceId}`);
    expect(ws.body.staged_changes).toBe(true);
    const denied = await s.dev.json(`/v1/workspaces/${s.workspaceId}`, {
      method: "PATCH",
      json: { staged_changes: false },
    });
    expect(denied.status).toBe(403);
    const off = await s.owner.json<{ staged_changes: boolean; name: string }>(
      `/v1/workspaces/${s.workspaceId}`,
      { method: "PATCH", json: { staged_changes: false } },
    );
    expect(off.body).toMatchObject({ staged_changes: false, name: "Nightjar Labs" });
    const empty = await s.owner.json(`/v1/workspaces/${s.workspaceId}`, {
      method: "PATCH",
      json: {},
    });
    expect(empty.status).toBe(400);
    const audit = await auditRows("workspace.settings_updated");
    expect(JSON.parse(audit[0]!.metadata!)).toEqual({
      from: { staged_changes: true },
      to: { staged_changes: false },
    });
    const canvas = await s.owner.json<{ staging: boolean }>(
      `/v1/projects/${s.project.id}/canvas?environment_id=${s.envId}`,
    );
    expect(canvas.body.staging).toBe(false);
  });

  it("stores require_approval with the environment's protection", async () => {
    const s = await setup();
    const path = `/v1/environments/${s.envId}/protection`;
    const before = await s.owner.json<{ require_approval: boolean }>(path);
    expect(before.body.require_approval).toBe(false);
    const put = await s.owner.json<{ require_approval: boolean; protected: boolean }>(path, {
      method: "PUT",
      json: { protected: true, require_approval: true },
    });
    expect(put.body).toMatchObject({ protected: true, require_approval: true });
    const kept = await s.owner.json<{ require_approval: boolean }>(path, {
      method: "PUT",
      json: { protected: true },
    });
    expect(kept.body.require_approval).toBe(true);
  });
});

describe("workspace review queue", () => {
  it("lists open sets of projects the caller can see, pending ones on request", async () => {
    const s = await setup();
    const hidden = await createProject(s.owner, s.workspaceId, { name: "Secret project" });
    const hiddenSvc = await createService(s.owner, hidden.id, {
      name: "vault",
      source: { type: "image", image: "nginx:1.27" },
    });
    await stageDraft(s.owner, hidden.environments[0]!.id, {
      type: "config.patch",
      service: hiddenSvc.service.id,
      patch: { deploy: { replicas: 2 } },
    });
    const staged = await stageDraft(s.dev, s.envId, {
      type: "config.patch",
      service: s.apiId,
      patch: { deploy: { replicas: 2 } },
    });

    // Members get no implied role, and a grant on the first project only.
    await s.owner.request(`/v1/workspaces/${s.workspaceId}/access-settings`, {
      method: "PATCH",
      json: { member_default_project_role: "none" },
    });
    const devId = (
      await env.DB.prepare("SELECT id FROM users WHERE email = 'dev@example.com'").first<{
        id: string;
      }>()
    )!.id;
    const grant = await s.owner.request(`/v1/projects/${s.project.id}/access`, {
      method: "PUT",
      json: { principal: { type: "user", id: devId }, role: "developer" },
    });
    expect(grant.status).toBeLessThan(300);

    const all = await s.dev.json<{ change_sets: { id: string; project_name: string }[] }>(
      `/v1/workspaces/${s.workspaceId}/change-sets`,
    );
    expect(all.body.change_sets.map((c) => c.project_name)).toEqual(["Storefront"]);
    const pendingBefore = await s.dev.json<{ change_sets: unknown[] }>(
      `/v1/workspaces/${s.workspaceId}/change-sets?review=pending`,
    );
    expect(pendingBefore.body.change_sets).toEqual([]);
    await post(s.dev, `/v1/change-sets/${staged.body.id}/submit`, {});
    const pending = await s.owner.json<{ change_sets: { id: string; review_status: string }[] }>(
      `/v1/workspaces/${s.workspaceId}/change-sets?review=pending`,
    );
    expect(pending.body.change_sets).toEqual([
      expect.objectContaining({ id: staged.body.id, review_status: "submitted" }),
    ]);
  });
});

describe("staged secrets", () => {
  it("never appear in review, rebase, queue, canvas or audit output", async () => {
    const s = await setup();
    const staged = await stageDraft(s.dev, s.envId, {
      type: "variable.set",
      scope: "service",
      service: s.apiId,
      key: "PAYMENTS_KEY",
      value: SECRET,
      tier: "secret",
      confirm_write_only: true,
    });
    expect(staged.status).toBe(200);
    const outputs: unknown[] = [staged.body];
    outputs.push((await post(s.dev, `/v1/change-sets/${staged.body.id}/submit`, {})).body);
    outputs.push(
      (
        await post(s.dev, `/v1/change-sets/${staged.body.id}/rebase`, {
          expected_revision: staged.body.revision,
        })
      ).body,
    );
    const approved = await post(s.owner, `/v1/change-sets/${staged.body.id}/approve`, {
      expected_revision: staged.body.revision,
    });
    outputs.push(approved.body);
    outputs.push((await s.owner.json(`/v1/change-sets/${staged.body.id}/diff`)).body);
    outputs.push((await s.owner.json(`/v1/workspaces/${s.workspaceId}/change-sets`)).body);
    outputs.push(
      (await s.owner.json(`/v1/projects/${s.project.id}/canvas?environment_id=${s.envId}`)).body,
    );
    outputs.push((await apply(s.owner, approved.body)).body);
    for (const out of outputs) expect(JSON.stringify(out)).not.toContain(SECRET);
    const { results } = await env.DB.prepare("SELECT metadata FROM audit_logs").all<{
      metadata: string | null;
    }>();
    for (const r of results) expect(r.metadata ?? "").not.toContain(SECRET);
  });
});
