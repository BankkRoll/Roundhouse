/**
 * Backups end to end (ADR 0004): backup storage settings, policies and the
 * minute-tick claimer, the backup workflow against a fake S3 with a
 * simulated protocol 5 agent (happy path, agent failure, offline node,
 * frames from another node), sealing of part URLs, retention, download and
 * delete, RBAC, and audit entries free of URLs and keys.
 */

import { env, introspectWorkflow } from "cloudflare:test";
import { OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import { createDb } from "@roundhouse/db";
import { backupPartsAad, openBox, SealedBackupPartsSchema } from "@roundhouse/protocol";
import { ACTIONS, AUDIT_ACTIONS, newId } from "@roundhouse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKUP_ROUTES, POLICY_KEY, policyOf, type RoutePolicy } from "../src/contracts";
import { app } from "../src/index";
import { applyBackupRetention, scrubError } from "../src/lib/backups/backups";
import { claimDueBackups, runBackupMaintenance } from "../src/lib/backups/schedule";
import { setS3Transport } from "../src/lib/s3";
import {
  allAuditText,
  auditRows,
  backupStage,
  connectDataAgent,
  STORAGE_BODY,
  waitForBackup,
} from "./backups-helpers";
import { FAKE_S3 } from "./fake-s3";
import {
  addMember,
  type Client,
  connectAgent,
  hello,
  joinNode,
  NODE_ENCRYPTION_PRIVATE_KEY,
} from "./helpers";

let introspectors: { dispose(): Promise<void> }[] = [];

beforeEach(async () => {
  introspectors = [
    await introspectWorkflow(env.BACKUP_WORKFLOW),
    await introspectWorkflow(env.RESTORE_WORKFLOW),
  ];
});

afterEach(async () => {
  for (const i of introspectors) await i.dispose();
  setS3Transport();
});

const backupNow = (s: { owner: Client; serviceId: string; envId: string }) =>
  s.owner.json<{ id: string; status: string }>(`/v1/services/${s.serviceId}/backups`, {
    method: "POST",
    json: { environment_id: s.envId },
  });

describe("backup contracts", () => {
  const routes = Object.entries(BACKUP_ROUTES) as [
    string,
    RouteConfig & { [POLICY_KEY]: RoutePolicy },
  ][];

  it("builds an operation per route, served by the app with its policy", () => {
    const router = new OpenAPIHono();
    for (const [, r] of routes) router.openapi(r, (c) => c.body(null, 204) as never);
    const doc = router.getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "t", version: "0" },
    });
    const ops = Object.values(doc.paths ?? {}).flatMap((p) => Object.values(p as object));
    expect(ops).toHaveLength(routes.length);
    const live = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } });
    for (const [name, r] of routes) {
      const op = (live.paths?.[r.path] as Record<string, Record<string, unknown>>)?.[r.method];
      expect(op?.[POLICY_KEY], name).toEqual(policyOf(r));
      const placeholders = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const params = r.request && "params" in r.request ? r.request.params : undefined;
      const declared = params ? Object.keys((params as { shape: object }).shape) : [];
      expect(declared.sort(), name).toEqual(placeholders.sort());
    }
  });

  it("declares known actions and audits, and fresh sessions for keys and restores", () => {
    for (const [name, r] of routes) {
      const p = policyOf(r);
      expect(ACTIONS, name).toContain(p.action);
      for (const a of p.audit) expect(AUDIT_ACTIONS, name).toContain(a);
    }
    expect(policyOf(BACKUP_ROUTES.restoreBackup)).toMatchObject({
      action: "backups:restore",
      reauth: true,
    });
    expect(policyOf(BACKUP_ROUTES.getBackupDecryptionKey)).toMatchObject({ reauth: true });
    expect(policyOf(BACKUP_ROUTES.putBackupStorage)).toMatchObject({
      auth: "session_only",
      action: "instance:manage",
      reauth: true,
    });
    expect(policyOf(BACKUP_ROUTES.listBackups).action).toBe("services:read");
  });
});

describe("backup storage setting", () => {
  it("answers 409 backup_storage_not_configured until it is set", async () => {
    const s = await backupStage({ storage: false, agent: false });
    const res = await backupNow(s);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: "backup_storage_not_configured" } });
    const view = await s.owner.json("/v1/instance/backup-storage");
    expect(view.body).toEqual({
      configured: false,
      endpoint: null,
      bucket: null,
      region: null,
      access_key_id: null,
      secret_access_key_set: false,
    });
  });

  it("stores the secret sealed and write-only, checks reachability, audits no values", async () => {
    const s = await backupStage({ storage: false, agent: false });
    const set = await s.owner.json("/v1/instance/backup-storage", {
      method: "PUT",
      json: STORAGE_BODY,
    });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({
      configured: true,
      endpoint: FAKE_S3.endpoint,
      bucket: FAKE_S3.bucket,
      region: "auto",
      access_key_id: FAKE_S3.accessKeyId,
      secret_access_key_set: true,
    });
    expect(JSON.stringify(set.body)).not.toContain(FAKE_S3.secretAccessKey);
    const raw = await env.DB.prepare(
      "SELECT value FROM instance_settings WHERE key = 'backup_storage'",
    ).first<{ value: string }>();
    expect(raw!.value).not.toContain(FAKE_S3.secretAccessKey);
    expect(JSON.parse(raw!.value).secret_access_key).toMatchObject({ v: 2 });

    // Keeping the secret: omit it.
    const { secret_access_key: _, ...rest } = STORAGE_BODY;
    expect(
      (await s.owner.json("/v1/instance/backup-storage", { method: "PUT", json: rest })).status,
    ).toBe(200);

    // A wrong secret fails the reachability probe and changes nothing.
    const bad = await s.owner.json("/v1/instance/backup-storage", {
      method: "PUT",
      json: { ...STORAGE_BODY, secret_access_key: "not-the-test-secret" },
    });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ error: { code: "backup_storage_unreachable" } });

    const plain = await s.owner.json("/v1/instance/backup-storage", {
      method: "PUT",
      json: { ...STORAGE_BODY, endpoint: "http://s3.fake.test" },
    });
    expect(plain.status).toBe(400);
    const withPath = await s.owner.json("/v1/instance/backup-storage", {
      method: "PUT",
      json: { ...STORAGE_BODY, endpoint: "https://user:pw@s3.fake.test/bucket" },
    });
    expect(withPath.status).toBe(400);

    const audits = await auditRows("instance.settings_updated");
    expect(audits.length).toBe(2);
    expect(audits[0]!.metadata).toMatchObject({ setting: "backup_storage" });
    const text = await allAuditText();
    expect(text).not.toContain(FAKE_S3.secretAccessKey);
    expect(text).not.toContain("not-the-test-secret");
  });

  it("is for instance admins on a fresh browser session only", async () => {
    const s = await backupStage({ storage: false, agent: false });
    const admin = await addMember(s.owner, s.workspaceId, "ada@example.com", "admin");
    expect((await admin.json("/v1/instance/backup-storage")).status).toBe(403);
    await env.DB.prepare("UPDATE sessions SET created_at = ?, reauthenticated_at = NULL")
      .bind(Date.now() - 24 * 60 * 60 * 1000)
      .run();
    const stale = await s.owner.json("/v1/instance/backup-storage", {
      method: "PUT",
      json: STORAGE_BODY,
    });
    expect(stale.status).toBe(403);
    expect(stale.body).toMatchObject({ error: { code: "reauth_required" } });
  });
});

describe("backup workflow", () => {
  it("backs up through the agent: sealed parts, multipart upload, completion", async () => {
    const s = await backupStage();
    const created = await backupNow(s);
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({ status: "queued" });

    const done = await waitForBackup(s.owner, created.body.id);
    expect(done.error).toBeNull();
    expect(done).toMatchObject({
      status: "succeeded",
      trigger: "manual",
      method: "snapshot",
      pinned: true,
      part_count: 2,
      node_id: s.joined.node_id,
    });
    const job = s.agent!.received.find((m) => m.type === "backup_job")!;
    expect(job).toMatchObject({
      volume_id: s.volumeId,
      quiesce: "none",
      databases: null,
      part_size_bytes: 16 * 1024 * 1024,
    });
    expect(job.exp - job.iat).toBeLessThanOrEqual(60_000);
    expect(s.agent!.rejected).toEqual([]);

    // One object, exactly the uploaded bytes.
    const key = `backups/${s.project.id}/${s.serviceId}/${s.envId}/${done.id}.rhbk.zst.age`;
    expect(s.fake.objects.get(key)?.byteLength).toBe(done.bytes_stored);
    expect(s.fake.uploads.size).toBe(0);

    // Every part URL names this one object and part, for at most an hour.
    const urls = [...s.agent!.partUrls.get(done.id)!.entries()];
    expect(urls).toHaveLength(16);
    for (const [n, u] of urls) {
      const url = new URL(u);
      expect(url.pathname).toBe(`/${FAKE_S3.bucket}/${key}`);
      expect(url.searchParams.get("partNumber")).toBe(String(n));
      expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(3600);
    }

    // The box opens only for this node and backup.
    const box = s.agent!.boxes.find((b) => b.frame === "backup_job")!.box;
    await expect(
      openBox(
        NODE_ENCRYPTION_PRIVATE_KEY,
        box,
        "backup-parts",
        backupPartsAad("node_other", done.id),
      ),
    ).rejects.toThrow();
    await expect(
      openBox(
        NODE_ENCRYPTION_PRIVATE_KEY,
        box,
        "backup-parts",
        backupPartsAad(s.joined.node_id, "bak_other"),
      ),
    ).rejects.toThrow();
    await expect(
      openBox(
        NODE_ENCRYPTION_PRIVATE_KEY,
        box,
        "restore",
        backupPartsAad(s.joined.node_id, done.id),
      ),
    ).rejects.toThrow();

    // The project's age recipient was created and sent; parts rows are gone.
    const keys = await env.DB.prepare(
      "SELECT backup_recipient, backup_identity_sealed FROM project_keys WHERE project_id = ?",
    )
      .bind(s.project.id)
      .first<{ backup_recipient: string; backup_identity_sealed: string }>();
    expect(job.age_recipient).toBe(keys!.backup_recipient);
    expect(keys!.backup_identity_sealed).not.toContain("AGE-SECRET-KEY");
    const parts = await env.DB.prepare("SELECT COUNT(*) AS n FROM backup_parts").first<{
      n: number;
    }>();
    expect(parts!.n).toBe(0);

    expect(await auditRows("backup.requested")).toHaveLength(1);
    const text = await allAuditText();
    expect(text).not.toMatch(/X-Amz|https?:\/\/|AGE-SECRET-KEY/);
  });

  it("answers backup_parts_request with more sealed URLs, only for its own backups", async () => {
    const s = await backupStage({ behaviour: { backup: "silent" } });
    const created = await backupNow(s);
    await s.agent!.waitFor((m) => m.type === "backup_job");
    s.agent!.send({
      type: "backup_parts_request",
      backup_id: created.body.id,
      from_part: 17,
      count: 2,
    });
    const more = await s.agent!.waitFor((m) => m.type === "backup_parts");
    expect(more.exp - more.iat).toBeLessThanOrEqual(60_000);
    const opened = SealedBackupPartsSchema.parse(
      JSON.parse(
        new TextDecoder().decode(
          await openBox(
            NODE_ENCRYPTION_PRIVATE_KEY,
            more.parts_sealed,
            "backup-parts",
            backupPartsAad(s.joined.node_id, created.body.id),
          ),
        ),
      ),
    );
    expect(opened.parts.map((p) => p.part_number)).toEqual([17, 18]);

    // Another node asking for this backup's URLs, or reporting on it, is ignored.
    const otherJoined = await joinNode(s.owner, s.workspaceId, {
      name: "hel-2",
      hostname: "hel-2",
      // RFC 8032 section 7.1 test 2 public key: a second, test-only identity.
      public_key: "PUAXw+hDiVqStwqnTRt+vJyYLM8uxJaMwM1V8Sr0Zgw=",
    });
    {
      const other = await connectDataAgent(otherJoined, s.fake, { backup: "silent" });
      other.send({
        type: "backup_parts_request",
        backup_id: created.body.id,
        from_part: 1,
        count: 2,
      });
      other.send({
        type: "backup_result",
        backup_id: created.body.id,
        ok: false,
        error: "spoofed",
        duration_ms: 1,
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(other.received.filter((m) => m.type === "backup_parts")).toEqual([]);
    }
    const still = await s.owner.json<{ status: string; error: string | null }>(
      `/v1/backups/${created.body.id}`,
    );
    expect(still.body).toMatchObject({ status: "running", error: null });
  });

  it("fails on an agent error: aborts the upload, scrubs the error, audits as the system", async () => {
    const s = await backupStage({ behaviour: { backup: "fail" } });
    const created = await backupNow(s);
    const failed = await waitForBackup(s.owner, created.body.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("connection reset by peer");
    expect(failed.error).not.toMatch(/X-Amz|https?:\/\//);
    expect(s.fake.seen.some((r) => r.op === "AbortMultipartUpload")).toBe(true);
    expect(s.fake.uploads.size).toBe(0);
    const [audit] = await auditRows("backup.failed");
    expect(audit).toMatchObject({
      actor_type: "system",
      actor_id: null,
      target_id: created.body.id,
    });
    expect(await allAuditText()).not.toMatch(/X-Amz|https?:\/\//);
  });

  it("fails node_offline when the volume's node isn't connected", async () => {
    const s = await backupStage({ agent: false });
    // Protocol 5 recorded, then disconnected.
    await env.DB.prepare("UPDATE nodes SET protocol_version = 5 WHERE id = ?")
      .bind(s.joined.node_id)
      .run();
    const created = await backupNow(s);
    const failed = await waitForBackup(s.owner, created.body.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/^node_offline/);
    expect(s.fake.seen.some((r) => r.op === "AbortMultipartUpload")).toBe(true);
  });

  it("refuses a node below protocol 5", async () => {
    const s = await backupStage({ agent: false });
    const agent = await connectAgent(s.joined);
    agent.send(hello(s.joined.node_id, { protocol_version: 4 }));
    await agent.next();
    const created = await backupNow(s);
    const failed = await waitForBackup(s.owner, created.body.id);
    expect(failed.error).toMatch(/^agent_outdated/);
  });
});

describe("backup routes", () => {
  it("lists, downloads (15 min, one object, audited) and deletes", async () => {
    const s = await backupStage();
    const created = await backupNow(s);
    await waitForBackup(s.owner, created.body.id);

    const list = await s.owner.json<{ backups: { id: string }[]; next_cursor: string | null }>(
      `/v1/services/${s.serviceId}/backups?environment_id=${s.envId}`,
    );
    expect(list.body.backups.map((b) => b.id)).toEqual([created.body.id]);
    expect(list.body.next_cursor).toBeNull();
    expect(JSON.stringify(list.body)).not.toMatch(/upload|X-Amz/i);

    const dl = await s.owner.json<{ url: string; expires_at: number; sha256: string }>(
      `/v1/backups/${created.body.id}/download`,
    );
    expect(dl.status).toBe(200);
    const url = new URL(dl.body.url);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.pathname).toMatch(new RegExp(`/${created.body.id}\\.rhbk\\.zst\\.age$`));
    const got = await s.fake.fetch(new Request(dl.body.url));
    expect(got.status).toBe(200);
    expect(await auditRows("backup.downloaded")).toHaveLength(1);
    expect(await allAuditText()).not.toMatch(/X-Amz|https?:\/\//);

    expect(
      (await s.owner.request(`/v1/backups/${created.body.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect(s.fake.objects.size).toBe(0);
    const gone = await s.owner.json<{ status: string }>(`/v1/backups/${created.body.id}`);
    expect(gone.body.status).toBe("deleted");
    expect(await auditRows("backup.deleted")).toHaveLength(1);
    const after = await s.owner.json<{ backups: unknown[] }>(
      `/v1/services/${s.serviceId}/backups?environment_id=${s.envId}`,
    );
    expect(after.body.backups).toEqual([]);
  });

  it("applies RBAC: viewers read, members back up, only admins download", async () => {
    const s = await backupStage();
    const viewer = await addMember(s.owner, s.workspaceId, "vic@example.com", "viewer");
    const member = await addMember(s.owner, s.workspaceId, "dev@example.com", "member");
    const listPath = `/v1/services/${s.serviceId}/backups?environment_id=${s.envId}`;
    expect((await viewer.json(listPath)).status).toBe(200);
    expect((await backupNow({ ...s, owner: viewer })).status).toBe(403);
    const byMember = await backupNow({ ...s, owner: member });
    expect(byMember.status).toBe(202);
    await waitForBackup(s.owner, byMember.body.id);
    expect((await member.json(`/v1/backups/${byMember.body.id}/download`)).status).toBe(403);
    expect(
      (await member.json(`/v1/backups/${byMember.body.id}/decryption-key`, { method: "POST" }))
        .status,
    ).toBe(403);
    expect(
      (
        await member.json(`/v1/backups/${byMember.body.id}/restore`, {
          method: "POST",
          json: { mode: "in_place", confirm: s.serviceSlug, skip_safety_backup: true },
        })
      ).status,
    ).toBe(403);
    expect((await viewer.json(`/v1/backups/${byMember.body.id}`)).status).toBe(200);
  });

  it("hands out the decryption key only on a fresh session, audited without it", async () => {
    const s = await backupStage();
    const created = await backupNow(s);
    await waitForBackup(s.owner, created.body.id);
    const key = await s.owner.json<{ identity: string; recipient: string }>(
      `/v1/backups/${created.body.id}/decryption-key`,
      { method: "POST" },
    );
    expect(key.status).toBe(200);
    expect(key.body.identity).toMatch(/^AGE-SECRET-KEY-1/);
    const job = s.agent!.received.find((m) => m.type === "backup_job")!;
    expect(key.body.recipient).toBe(job.age_recipient);
    expect(await auditRows("backup.key_revealed")).toHaveLength(1);
    expect(await allAuditText()).not.toContain(key.body.identity);

    await env.DB.prepare("UPDATE sessions SET created_at = ?, reauthenticated_at = NULL")
      .bind(Date.now() - 24 * 60 * 60 * 1000)
      .run();
    const stale = await s.owner.json(`/v1/backups/${created.body.id}/decryption-key`, {
      method: "POST",
    });
    expect(stale.status).toBe(403);
    expect(stale.body).toMatchObject({ error: { code: "reauth_required" } });
  });
});

describe("backup policies and schedule", () => {
  it("returns defaults, validates, saves with next_run_at, and audits", async () => {
    const s = await backupStage({ agent: false });
    const path = `/v1/services/${s.serviceId}/backup-policy`;
    const defaults = await s.owner.json(`${path}?environment_id=${s.envId}`);
    expect(defaults.body).toMatchObject({
      id: null,
      enabled: false,
      method: "snapshot",
      schedule: "0 3 * * *",
      keep_last: 7,
      next_runs: [],
    });
    for (const bad of [
      { schedule: "every day" },
      { keep_last: 0 },
      { keep_last: 366 },
      { max_age_days: 0 },
    ]) {
      const res = await s.owner.json(path, {
        method: "PUT",
        json: { environment_id: s.envId, ...bad },
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const dbs = await s.owner.json(path, {
      method: "PUT",
      json: { environment_id: s.envId, databases: ["app"] },
    });
    expect(dbs.status).toBe(422);

    const saved = await s.owner.json<{ id: string; next_run_at: number; next_runs: number[] }>(
      path,
      {
        method: "PUT",
        json: { environment_id: s.envId, schedule: "*/15 * * * *", keep_last: 3, quiesce: "stop" },
      },
    );
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ enabled: true, keep_last: 3, quiesce: "stop" });
    expect(saved.body.next_run_at % (15 * 60_000)).toBe(0);
    expect(saved.body.next_run_at).toBeGreaterThan(Date.now());
    expect(saved.body.next_runs).toHaveLength(3);
    const again = await s.owner.json<{ id: string; keep_last: number }>(path, {
      method: "PUT",
      json: { environment_id: s.envId, max_age_days: 30 },
    });
    expect(again.body).toMatchObject({ id: saved.body.id, keep_last: 3, max_age_days: 30 });
    const audits = await auditRows("backup.policy_updated");
    expect(audits).toHaveLength(2);
    expect(audits[0]!.metadata).toMatchObject({ changed: ["schedule", "keep_last", "quiesce"] });

    const viewer = await addMember(s.owner, s.workspaceId, "vic@example.com", "viewer");
    expect((await viewer.json(`${path}?environment_id=${s.envId}`)).status).toBe(200);
    expect(
      (await viewer.json(path, { method: "PUT", json: { environment_id: s.envId } })).status,
    ).toBe(403);
  });

  it("claims a due slot once, however many ticks or missed slots", async () => {
    const s = await backupStage({ agent: false });
    const policyId = newId("backupPolicy");
    const now = Date.now();
    const seen = now - 3 * 60 * 60 * 1000;
    await env.DB.prepare(
      `INSERT INTO backup_policies (id, service_id, environment_id, enabled, method, schedule, timezone, keep_last, quiesce, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'snapshot', '0 * * * *', 'UTC', 7, 'none', ?, ?, ?)`,
    )
      .bind(policyId, s.serviceId, s.envId, seen, now, now)
      .run();
    const results = await Promise.all([claimDueBackups(env, now), claimDueBackups(env, now)]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await claimDueBackups(env, now)).toBe(0);
    const rows = await env.DB.prepare(
      "SELECT trigger, scheduled_for, pinned FROM backups WHERE policy_id = ?",
    )
      .bind(policyId)
      .all<{ trigger: string; scheduled_for: number; pinned: number }>();
    expect(rows.results).toEqual([{ trigger: "schedule", scheduled_for: seen, pinned: 0 }]);
    const policy = await env.DB.prepare("SELECT next_run_at FROM backup_policies WHERE id = ?")
      .bind(policyId)
      .first<{ next_run_at: number }>();
    expect(policy!.next_run_at).toBeGreaterThan(now);
    expect(policy!.next_run_at - now).toBeLessThanOrEqual(60 * 60 * 1000);
  });
});

describe("backup retention", () => {
  it("deletes scheduled backups past keep_last (object first), never pinned ones", async () => {
    const s = await backupStage({ agent: false });
    const policyId = newId("backupPolicy");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO backup_policies (id, service_id, environment_id, enabled, method, schedule, timezone, keep_last, max_age_days, quiesce, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'snapshot', '0 3 * * *', 'UTC', 2, 30, 'none', ?, ?)`,
    )
      .bind(policyId, s.serviceId, s.envId, now, now)
      .run();
    const ids: string[] = [];
    const insert = async (trigger: string, pinned: boolean, ageDays: number) => {
      const id = newId("backup");
      const key = `backups/${s.project.id}/${s.serviceId}/${s.envId}/${id}.rhbk.zst.age`;
      s.fake.objects.set(key, new Uint8Array(10));
      const at = now - ageDays * 86_400_000;
      await env.DB.prepare(
        `INSERT INTO backups (id, project_id, service_id, environment_id, trigger, method, status, object_key, pinned, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'snapshot', 'succeeded', ?, ?, ?, ?)`,
      )
        .bind(id, s.project.id, s.serviceId, s.envId, trigger, key, pinned ? 1 : 0, at, at)
        .run();
      ids.push(id);
      return id;
    };
    const newest = await insert("schedule", false, 1);
    const second = await insert("schedule", false, 2);
    const third = await insert("schedule", false, 3);
    const pinnedOld = await insert("manual", true, 90);
    const manualOld = await insert("manual", false, 90);

    const deleted = await applyBackupRetention(
      createDb(env.DB),
      FAKE_S3,
      s.serviceId,
      s.envId,
      now,
    );
    expect(deleted).toBe(2);
    const status = async (id: string) =>
      (await env.DB.prepare("SELECT status FROM backups WHERE id = ?")
        .bind(id)
        .first<{ status: string }>())!.status;
    expect(await status(newest)).toBe("succeeded");
    expect(await status(second)).toBe("succeeded");
    expect(await status(third)).toBe("deleted");
    expect(await status(pinnedOld)).toBe("succeeded");
    expect(await status(manualOld)).toBe("deleted");
    expect(s.fake.objects.size).toBe(3);
  });

  it("hourly maintenance fails backups stuck far past their timeout", async () => {
    const s = await backupStage({ agent: false });
    const id = newId("backup");
    const longAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    await env.DB.prepare(
      `INSERT INTO backups (id, project_id, service_id, environment_id, trigger, method, status, object_key, upload_id, pinned, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'manual', 'snapshot', 'running', 'backups/x.rhbk.zst.age', 'upload-gone', 1, ?, ?, ?)`,
    )
      .bind(id, s.project.id, s.serviceId, s.envId, longAgo, longAgo, longAgo)
      .run();
    const report = await runBackupMaintenance(env);
    expect(report.stuck).toBe(1);
    const row = await env.DB.prepare("SELECT status, error FROM backups WHERE id = ?")
      .bind(id)
      .first<{ status: string; error: string }>();
    expect(row).toMatchObject({ status: "failed" });
    expect(row!.error).toMatch(/^timed_out/);
    expect(s.fake.seen.some((r) => r.op === "AbortMultipartUpload")).toBe(true);
  });

  it("scrubs URLs, signatures and identities from errors", () => {
    expect(
      scrubError(
        'Put "https://acc.r2.cloudflarestorage.com/b/k?partNumber=1&X-Amz-Signature=abc": EOF; key AGE-SECRET-KEY-1QQQQ',
      ),
    ).toBe('Put "<url>": EOF; key <redacted>');
    expect(scrubError("x".repeat(2000))).toHaveLength(500);
  });
});
