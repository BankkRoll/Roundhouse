/**
 * Restoring a database backup into a new service (ADR 0004, "Restore"): the
 * route adds a database of the backup's engine and version, with fresh
 * credentials and its own volume, through a change set; the workflow waits
 * for it to run healthy and restores into it. RBAC, reauth and the refusal
 * of snapshots are checked too.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { createDb } from "@roundhouse/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restoreServiceSlug } from "../src/lib/backups/restores";
import { setS3Transport } from "../src/lib/s3";
import { openVariable, projectKey } from "../src/lib/variables";
import { allAuditText, auditRows, waitForBackup } from "./backups-helpers";
import { type DatabaseStage, databaseStage, waitForState } from "./data-stage";
import { addMember } from "./helpers";
import { settleDeployments } from "./pipeline-helpers";

let introspectors: { dispose(): Promise<void> }[] = [];
beforeEach(async () => {
  introspectors = [
    await introspectWorkflow(env.DEPLOY_WORKFLOW),
    await introspectWorkflow(env.BACKUP_WORKFLOW),
    await introspectWorkflow(env.RESTORE_WORKFLOW),
  ];
});
afterEach(async () => {
  await settleDeployments();
  for (const i of introspectors) await i.dispose();
  setS3Transport();
});

interface RestoreBody {
  id: string;
  status: string;
  mode: string;
  error: string | null;
  target_service_id: string | null;
  target_environment_id: string | null;
}

async function dumpBackup(s: DatabaseStage): Promise<string> {
  const res = await s.owner.json<{ id: string; method: string }>(
    `/v1/services/${s.serviceId}/backups`,
    { method: "POST", json: { environment_id: s.envId } },
  );
  expect(res.status).toBe(202);
  const done = await waitForBackup(s.owner, res.body.id);
  expect(done).toMatchObject({ status: "succeeded", method: "dump" });
  return done.id;
}

const restore = (s: DatabaseStage, backupId: string, body: Record<string, unknown>) =>
  s.owner.json<RestoreBody & { error: { code: string } }>(`/v1/backups/${backupId}/restore`, {
    method: "POST",
    json: body,
  });

async function secretOf(s: DatabaseStage, serviceId: string, key: string) {
  const db = createDb(env.DB);
  const row = await env.DB.prepare(
    "SELECT * FROM variables WHERE service_id = ? AND environment_id = ? AND key = ?",
  )
    .bind(serviceId, s.envId, key)
    .first<Record<string, unknown>>();
  if (!row) return undefined;
  const dek = await projectKey(db, env, s.project.id);
  return openVariable(dek, {
    id: row.id as string,
    projectId: row.project_id as string,
    environmentId: row.environment_id as string,
    scope: row.scope as "service",
    serviceId: row.service_id as string,
    key: row.key as string,
    version: row.version as number,
    valueSealed: JSON.parse(row.value_sealed as string),
  });
}

describe("restore into a new service", () => {
  it("adds a database with fresh credentials, waits for it, and restores into it", async () => {
    const s = await databaseStage();
    const backupId = await dumpBackup(s);
    const started = await restore(s, backupId, { mode: "new_service", confirm: s.serviceSlug });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ mode: "new_service", target_environment_id: s.envId });
    const newId = started.body.target_service_id!;
    expect(newId).toMatch(/^svc_/);
    expect(newId).not.toBe(s.serviceId);

    const done = await waitForState(
      async () => (await s.owner.json<RestoreBody>(`/v1/restores/${started.body.id}`)).body,
      ["succeeded", "failed"],
    );
    expect(done).toMatchObject({ status: "succeeded", error: null });

    const svc = await s.owner.json<{ slug: string; kind: string }>(`/v1/services/${newId}`);
    expect(svc.body.slug).toBe(restoreServiceSlug(s.serviceSlug, Date.now()));
    expect(svc.body.kind).toBe("database");
    const vol = await s.owner.json<{ id: string; status: string }>(
      `/v1/services/${newId}/volume?environment_id=${s.envId}`,
    );
    expect(vol.body.status).toBe("ready");
    expect(vol.body.id).not.toBe(s.volumeId);

    const job = s.nodes
      .flatMap((n) => n.agent.received)
      .find((m) => m.type === "restore_job" && m.restore_id === started.body.id);
    expect(job).toMatchObject({ backup_id: backupId, volume_id: vol.body.id, method: "dump" });
    expect(job && "workload_id" in job && job.workload_id).toBeTruthy();

    // Fresh write-only credentials, not the source's.
    const before = await secretOf(s, s.serviceId, "POSTGRES_PASSWORD");
    const after = await secretOf(s, newId, "POSTGRES_PASSWORD");
    expect(after).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(after).not.toBe(before);
    const tier = await env.DB.prepare(
      "SELECT tier FROM variables WHERE service_id = ? AND key = 'POSTGRES_PASSWORD'",
    )
      .bind(newId)
      .first<{ tier: string }>();
    expect(tier?.tier).toBe("secret");

    const [audit] = await auditRows("restore.started");
    expect(audit!.metadata).toMatchObject({
      mode: "new_service",
      source_service_id: s.serviceId,
      service_id: newId,
    });
    expect(await auditRows("restore.succeeded")).toHaveLength(1);
    const text = await allAuditText();
    expect(text).not.toMatch(/X-Amz|AGE-SECRET-KEY/);
    expect(text).not.toContain(after!);
  }, 90_000);

  it("takes the slug and environment it is given, and checks every permission there", async () => {
    const s = await databaseStage();
    const backupId = await dumpBackup(s);
    const member = await addMember(s.owner, s.workspaceId, "dev@example.com", "member");
    const refused = await member.json<{ error: { code: string } }>(
      `/v1/backups/${backupId}/restore`,
      { method: "POST", json: { mode: "new_service", confirm: s.serviceSlug } },
    );
    expect(refused.status).toBe(403);

    const wrong = await restore(s, backupId, { mode: "new_service", confirm: "nope" });
    expect(wrong.status).toBe(400);

    await env.DB.prepare("UPDATE sessions SET created_at = ?, reauthenticated_at = NULL")
      .bind(Date.now() - 24 * 60 * 60 * 1000)
      .run();
    const stale = await restore(s, backupId, { mode: "new_service", confirm: s.serviceSlug });
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe("reauth_required");
    expect(await auditRows("restore.started")).toEqual([]);
    const services = await env.DB.prepare("SELECT COUNT(*) AS n FROM services").first<{
      n: number;
    }>();
    expect(services?.n).toBe(1);
  }, 60_000);

  it("refuses a snapshot, which carries the source's passwords", async () => {
    const s = await databaseStage();
    const backupId = await dumpBackup(s);
    // A database's snapshots come from volume migrations.
    await env.DB.prepare(
      "UPDATE backups SET method = 'snapshot', trigger = 'migration' WHERE id = ?",
    )
      .bind(backupId)
      .run();
    const refused = await restore(s, backupId, { mode: "new_service", confirm: s.serviceSlug });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe("restore_mode_unsupported");
  }, 60_000);
});
