/**
 * Restores end to end (ADR 0004, "Restore"): in place with and without the
 * `pre_restore` safety backup, the sealed download URL and age identity
 * (bound to node and restore), agent failure, the confirmation and fresh
 * session requirements, `new_service` (not served yet), and audit entries.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { openBox, restoreSecretsAad } from "@roundhouse/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ageRecipientOf } from "../src/lib/age";
import { setS3Transport } from "../src/lib/s3";
import {
  allAuditText,
  auditRows,
  type BackupStage,
  backupStage,
  waitForBackup,
} from "./backups-helpers";
import { addMember, NODE_ENCRYPTION_PRIVATE_KEY } from "./helpers";

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

interface RestoreBody {
  id: string;
  status: string;
  error: string | null;
  safety_backup_id: string | null;
  mode: string;
}

async function succeededBackup(s: BackupStage): Promise<string> {
  const res = await s.owner.json<{ id: string }>(`/v1/services/${s.serviceId}/backups`, {
    method: "POST",
    json: { environment_id: s.envId },
  });
  const done = await waitForBackup(s.owner, res.body.id);
  if (done.status !== "succeeded") throw new Error(`backup failed: ${done.error}`);
  return done.id;
}

async function waitForRestore(s: BackupStage, id: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await s.owner.json<RestoreBody>(`/v1/restores/${id}`);
    if (res.body.status === "succeeded" || res.body.status === "failed") return res.body;
    if (Date.now() > deadline) throw new Error(`restore stuck in ${res.body.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const restore = (s: BackupStage, backupId: string, body: Record<string, unknown>) =>
  s.owner.json<RestoreBody>(`/v1/backups/${backupId}/restore`, { method: "POST", json: body });

describe("in-place restore", () => {
  it("sends a sealed URL and identity, bound to node and restore, and succeeds", async () => {
    const s = await backupStage();
    const backupId = await succeededBackup(s);
    const started = await restore(s, backupId, {
      mode: "in_place",
      confirm: s.serviceSlug,
      skip_safety_backup: true,
    });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ mode: "in_place", safety_backup_id: null });
    const done = await waitForRestore(s, started.body.id);
    expect(done).toMatchObject({ status: "succeeded", error: null });

    const job = s.agent!.received.find((m) => m.type === "restore_job")!;
    expect(job).toMatchObject({ backup_id: backupId, volume_id: s.volumeId, method: "snapshot" });
    expect(job.exp - job.iat).toBeLessThanOrEqual(60_000);
    const secrets = s.agent!.restoreSecrets.get(started.body.id)!;
    const url = new URL(secrets.download_url);
    expect(url.pathname).toMatch(new RegExp(`/${backupId}\\.rhbk\\.zst\\.age$`));
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(3600);
    const recipient = s.agent!.received.find((m) => m.type === "backup_job")!.age_recipient;
    expect(await ageRecipientOf(secrets.age_identity)).toBe(recipient);

    const box = s.agent!.boxes.find((b) => b.frame === "restore_job")!.box;
    await expect(
      openBox(
        NODE_ENCRYPTION_PRIVATE_KEY,
        box,
        "restore",
        restoreSecretsAad("node_x", started.body.id),
      ),
    ).rejects.toThrow();
    await expect(
      openBox(
        NODE_ENCRYPTION_PRIVATE_KEY,
        box,
        "restore",
        restoreSecretsAad(s.joined.node_id, "rst_x"),
      ),
    ).rejects.toThrow();

    expect(await auditRows("restore.started")).toHaveLength(1);
    const [ok] = await auditRows("restore.succeeded");
    expect(ok).toMatchObject({ actor_type: "system", target_id: started.body.id });
    const text = await allAuditText();
    expect(text).not.toMatch(/X-Amz|https?:\/\/|AGE-SECRET-KEY/);
  });

  it("takes a pre_restore safety backup first", async () => {
    const s = await backupStage();
    const backupId = await succeededBackup(s);
    const started = await restore(s, backupId, { mode: "in_place", confirm: s.serviceSlug });
    expect(started.status).toBe(202);
    expect(started.body.safety_backup_id).toMatch(/^bak_/);
    const done = await waitForRestore(s, started.body.id);
    expect(done.status).toBe("succeeded");
    const safety = await waitForBackup(s.owner, started.body.safety_backup_id!);
    expect(safety).toMatchObject({ status: "succeeded", trigger: "pre_restore", pinned: false });
    const jobs = s.agent!.received.map((m) => m.type).filter((t) => t.endsWith("_job"));
    expect(jobs).toEqual(["backup_job", "backup_job", "restore_job"]);
  });

  it("fails without touching data when the safety backup fails", async () => {
    const s = await backupStage();
    const backupId = await succeededBackup(s);
    s.agent!.behaviour.backup = "fail";
    const started = await restore(s, backupId, { mode: "in_place", confirm: s.serviceSlug });
    const done = await waitForRestore(s, started.body.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/^safety_backup_failed/);
    expect(s.agent!.received.some((m) => m.type === "restore_job")).toBe(false);
    const [audit] = await auditRows("restore.failed");
    expect(audit).toMatchObject({ actor_type: "system" });
  });

  it("records the agent's failure", async () => {
    const s = await backupStage();
    const backupId = await succeededBackup(s);
    s.agent!.behaviour.restore = "fail";
    const started = await restore(s, backupId, {
      mode: "in_place",
      confirm: s.serviceSlug,
      skip_safety_backup: true,
    });
    const done = await waitForRestore(s, started.body.id);
    expect(done).toMatchObject({ status: "failed", error: "pg_restore: error: could not connect" });
  });
});

describe("restore guards", () => {
  it("needs the typed slug, a succeeded backup, and a fresh session", async () => {
    const s = await backupStage();
    const backupId = await succeededBackup(s);
    const wrong = await restore(s, backupId, { mode: "in_place", confirm: "not-the-slug" });
    expect(wrong.status).toBe(400);

    const unsupported = await restore(s, backupId, { mode: "new_service", confirm: s.serviceSlug });
    expect(unsupported.status).toBe(501);
    expect(unsupported.body).toMatchObject({ error: { code: "restore_mode_unsupported" } });

    await env.DB.prepare("UPDATE sessions SET created_at = ?, reauthenticated_at = NULL")
      .bind(Date.now() - 24 * 60 * 60 * 1000)
      .run();
    const stale = await restore(s, backupId, { mode: "in_place", confirm: s.serviceSlug });
    expect(stale.status).toBe(403);
    expect(stale.body).toMatchObject({ error: { code: "reauth_required" } });
    expect(await auditRows("restore.started")).toEqual([]);
  });

  it("refuses members (backups:restore is for owners and admins)", async () => {
    const s = await backupStage();
    const backupId = await succeededBackup(s);
    const member = await addMember(s.owner, s.workspaceId, "dev@example.com", "member");
    const res = await member.json(`/v1/backups/${backupId}/restore`, {
      method: "POST",
      json: { mode: "in_place", confirm: s.serviceSlug },
    });
    expect(res.status).toBe(403);
    const admin = await addMember(s.owner, s.workspaceId, "ada@example.com", "admin");
    const ok = await admin.json<RestoreBody>(`/v1/backups/${backupId}/restore`, {
      method: "POST",
      json: { mode: "in_place", confirm: s.serviceSlug, skip_safety_backup: true },
    });
    expect(ok.status).toBe(202);
    await waitForRestore(s, ok.body.id);
  });
});
