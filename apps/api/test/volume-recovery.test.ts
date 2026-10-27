/**
 * Recovering a volume whose node is lost (ADR 0004, `target_node_id` on an
 * `in_place` restore): the old volume is abandoned, an empty one is created
 * on the chosen node, the service is redeployed there, and the backup is
 * restored into it once it runs. Refusals cover an online node, an
 * ineligible or unknown target, the wrong mode, RBAC and reauth; the audit
 * entry records the recovery without secrets.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { REAUTH_WINDOW_MS } from "@roundhouse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setS3Transport } from "../src/lib/s3";
import { allAuditText, auditRows, waitForBackup } from "./backups-helpers";
import { type DatabaseStage, databaseStage, type StageNode, waitForState } from "./data-stage";
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
  safety_backup_id: string | null;
  target_node_id: string | null;
}

type Refusal = { error: { code: string; message: string } };

const other = (s: DatabaseStage): StageNode => s.nodes.find((n) => n !== s.home)!;

async function dumpBackup(s: DatabaseStage): Promise<string> {
  const res = await s.owner.json<{ id: string }>(`/v1/services/${s.serviceId}/backups`, {
    method: "POST",
    json: { environment_id: s.envId },
  });
  expect(res.status).toBe(202);
  return (await waitForBackup(s.owner, res.body.id)).id;
}

const recover = (s: DatabaseStage, backupId: string, body: Record<string, unknown> = {}) =>
  s.owner.json<RestoreBody & Refusal>(`/v1/backups/${backupId}/restore`, {
    method: "POST",
    json: {
      mode: "in_place",
      confirm: s.serviceSlug,
      target_node_id: other(s).joined.node_id,
      ...body,
    },
  });

/** Removes the volume's node, as an operator does once a server is gone for good. */
async function loseHome(s: DatabaseStage) {
  const res = await s.owner.request(
    `/v1/workspaces/${s.workspaceId}/nodes/${s.home.joined.node_id}?keep_server=true`,
    { method: "DELETE" },
  );
  expect(res.status).toBe(204);
}

async function volumes(serviceId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, node_id, status FROM volumes WHERE service_id = ? ORDER BY id",
  )
    .bind(serviceId)
    .all<{ id: string; node_id: string | null; status: string }>();
  return results;
}

describe("recovering a volume onto another node", () => {
  it("abandons the lost volume, redeploys on the target, and restores the backup there", async () => {
    const s = await databaseStage({ nodes: 2 });
    const backupId = await dumpBackup(s);
    await loseHome(s);
    const target = other(s).joined.node_id;

    const started = await recover(s, backupId, { skip_safety_backup: false });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({
      mode: "in_place",
      target_node_id: target,
      safety_backup_id: null,
    });

    const done = await waitForState(
      async () => (await s.owner.json<RestoreBody>(`/v1/restores/${started.body.id}`)).body,
      ["succeeded", "failed"],
      90_000,
    );
    expect(done).toMatchObject({ status: "succeeded", error: null, target_node_id: target });

    const rows = await volumes(s.serviceId);
    expect(rows).toHaveLength(2);
    expect(rows.find((v) => v.id === s.volumeId)).toMatchObject({ status: "abandoned" });
    const fresh = rows.find((v) => v.id !== s.volumeId)!;
    expect(fresh).toMatchObject({ node_id: target, status: "ready" });

    const job = other(s).agent.received.find(
      (m) => m.type === "restore_job" && m.restore_id === started.body.id,
    );
    expect(job).toMatchObject({ backup_id: backupId, volume_id: fresh.id, method: "dump" });
    expect(s.home.agent.received.some((m) => m.type === "restore_job")).toBe(false);

    const redeploy = await env.DB.prepare(
      "SELECT status FROM deployments WHERE service_id = ? AND trigger = 'recovery'",
    )
      .bind(s.serviceId)
      .first<{ status: string }>();
    expect(redeploy?.status).toBe("active");

    const [audit] = await auditRows("restore.started");
    expect(audit!.metadata).toMatchObject({
      mode: "in_place",
      backup_id: backupId,
      safety_backup_id: null,
      recovery: {
        lost_node_id: s.home.joined.node_id,
        target_node_id: target,
        abandoned_volume_id: s.volumeId,
        volume_id: fresh.id,
      },
    });
    expect(await auditRows("restore.succeeded")).toHaveLength(1);
    expect(await allAuditText()).not.toMatch(/X-Amz|AGE-SECRET-KEY/);
  }, 120_000);

  it("refuses while the volume's node is online, and for the wrong mode or target", async () => {
    const s = await databaseStage({ nodes: 2 });
    const backupId = await dumpBackup(s);

    const online = await recover(s, backupId);
    expect(online.status).toBe(409);
    expect(online.body.error.message).toMatch(/Move the volume instead/);

    const wrongMode = await recover(s, backupId, { mode: "new_service" });
    expect(wrongMode.status).toBe(400);

    await loseHome(s);
    expect((await recover(s, backupId, { target_node_id: "node_nope" })).status).toBe(404);
    expect((await recover(s, backupId, { target_node_id: s.home.joined.node_id })).status).toBe(
      404,
    );

    await env.DB.prepare("UPDATE nodes SET status = 'offline' WHERE id = ?")
      .bind(other(s).joined.node_id)
      .run();
    const offline = await recover(s, backupId);
    expect(offline.status).toBe(422);
    expect(offline.body.error.code).toBe("migration_target_ineligible");
    expect(offline.body.error.message).toMatch(/isn't online/);

    expect(await volumes(s.serviceId)).toEqual([
      { id: s.volumeId, node_id: s.home.joined.node_id, status: "ready" },
    ]);
    expect(await auditRows("restore.started")).toHaveLength(0);
  }, 90_000);

  it("needs backups:restore, a confirmation and a fresh session", async () => {
    const s = await databaseStage({ nodes: 2 });
    const backupId = await dumpBackup(s);
    await loseHome(s);

    const member = await addMember(s.owner, s.workspaceId, "dev@example.com", "member");
    const developer = await member.json<Refusal>(`/v1/backups/${backupId}/restore`, {
      method: "POST",
      json: {
        mode: "in_place",
        confirm: s.serviceSlug,
        target_node_id: other(s).joined.node_id,
      },
    });
    expect(developer.status).toBe(403);

    expect((await recover(s, backupId, { confirm: "nope" })).status).toBe(400);

    await env.DB.prepare(
      "UPDATE sessions SET created_at = ?, reauthenticated_at = NULL WHERE user_id = ?",
    )
      .bind(Date.now() - REAUTH_WINDOW_MS - 60_000, s.installed.userId)
      .run();
    const stale = await recover(s, backupId);
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe("reauth_required");

    expect((await volumes(s.serviceId)).map((v) => v.status)).toEqual(["ready"]);
  }, 90_000);
});
