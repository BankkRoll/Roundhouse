/**
 * The recovery follow-ups of ADR 0004: deleting the copy a recovery left on
 * a lost server once it is back (only with a ready replacement elsewhere
 * that a restore filled, audited, sent again until confirmed), and
 * automatic recovery (grace period, the enabler's access re-checked every
 * time, a target the scheduler accepts, audit and status).
 */
import { env, introspectWorkflow } from "cloudflare:test";
import type { ControlMessage, VolumeDelete } from "@roundhouse/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimAbandonedCleanups } from "../src/lib/abandoned-volumes";
import { claimRecoveries } from "../src/lib/backups/auto-recovery";
import { setS3Transport } from "../src/lib/s3";
import { auditRows, waitForBackup } from "./backups-helpers";
import { type DatabaseStage, databaseStage, type StageNode, waitForState } from "./data-stage";
import { addMember, eventually } from "./helpers";
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
  trigger: string;
  target_node_id: string | null;
  error: string | null;
}

interface CopyBody {
  volume_id: string;
  node_id: string;
  state: string;
  message: string | null;
  delete_after: number;
}

interface PolicyBody {
  enabled: boolean;
  grace_minutes: number;
  enabled_by: string | null;
  status: string;
  message: string | null;
  restore_id: string | null;
}

const other = (s: DatabaseStage): StageNode => s.nodes.find((n) => n !== s.home)!;

async function dumpBackup(s: DatabaseStage): Promise<string> {
  const res = await s.owner.json<{ id: string }>(`/v1/services/${s.serviceId}/backups`, {
    method: "POST",
    json: { environment_id: s.envId },
  });
  expect(res.status).toBe(202);
  return (await waitForBackup(s.owner, res.body.id)).id;
}

/** Makes a node look silent since `since`, as the heartbeat alarm would. */
async function goOffline(nodeId: string, since = Date.now() - 120_000) {
  await env.DB.prepare("UPDATE nodes SET status = 'offline', last_heartbeat_at = ? WHERE id = ?")
    .bind(since, nodeId)
    .run();
}

async function comeBack(nodeId: string) {
  await env.DB.prepare("UPDATE nodes SET status = 'online', last_heartbeat_at = ? WHERE id = ?")
    .bind(Date.now(), nodeId)
    .run();
}

const copies = async (s: DatabaseStage) =>
  (
    await s.owner.json<{ copies: CopyBody[] }>(
      `/v1/services/${s.serviceId}/volume/abandoned-copies?environment_id=${s.envId}`,
    )
  ).body.copies;

async function recoverOnto(s: DatabaseStage, backupId: string): Promise<RestoreBody> {
  const started = await s.owner.json<RestoreBody>(`/v1/backups/${backupId}/restore`, {
    method: "POST",
    json: { mode: "in_place", confirm: s.serviceSlug, target_node_id: other(s).joined.node_id },
  });
  expect(started.status).toBe(202);
  return waitForState(
    async () => (await s.owner.json<RestoreBody>(`/v1/restores/${started.body.id}`)).body,
    ["succeeded", "failed"],
    90_000,
  );
}

describe("abandoned volume copies", () => {
  it("deletes the lost server's copy only once it is back and the replacement is restored", async () => {
    const s = await databaseStage({ nodes: 2 });
    const backupId = await dumpBackup(s);
    await goOffline(s.home.joined.node_id);
    const done = await recoverOnto(s, backupId);
    expect(done.status).toBe("succeeded");

    const [copy] = await copies(s);
    expect(copy).toMatchObject({
      volume_id: s.volumeId,
      node_id: s.home.joined.node_id,
      state: "waiting_for_server",
    });
    expect(copy!.delete_after).toBeGreaterThan(Date.now() + 71 * 3600_000);
    // SECURITY: nothing is sent while the server is unreachable.
    expect(await claimAbandonedCleanups(env, copy!.delete_after + 1)).toBe(0);

    await comeBack(s.home.joined.node_id);
    expect((await copies(s))[0]!.state).toBe("scheduled");
    // Not before the grace period ends.
    expect(await claimAbandonedCleanups(env, Date.now())).toBe(0);
    // The grace period ends; the server's heartbeat stays current.
    await env.DB.prepare("UPDATE volumes SET delete_after = ? WHERE id = ?")
      .bind(Date.now() - 1000, s.volumeId)
      .run();
    const later = Date.now();

    // SECURITY: never while the service's live volume is on that server again.
    const [live] = (
      await env.DB.prepare(
        "SELECT id, node_id FROM volumes WHERE service_id = ? AND status = 'ready'",
      )
        .bind(s.serviceId)
        .all<{ id: string; node_id: string }>()
    ).results;
    await env.DB.prepare("UPDATE volumes SET node_id = ? WHERE id = ?")
      .bind(s.home.joined.node_id, live!.id)
      .run();
    expect(await claimAbandonedCleanups(env, later)).toBe(0);
    expect((await copies(s))[0]).toMatchObject({ state: "kept" });
    await env.DB.prepare("UPDATE volumes SET node_id = ? WHERE id = ?")
      .bind(live!.node_id, live!.id)
      .run();

    expect(await claimAbandonedCleanups(env, later)).toBe(1);
    const sent = await s.home.agent.waitFor(
      (m: ControlMessage): m is VolumeDelete => m.type === "volume_delete",
    );
    expect(sent.volume_id).toBe(s.volumeId);
    expect(other(s).agent.received.some((m) => m.type === "volume_delete")).toBe(false);
    expect((await copies(s))[0]!.state).toBe("deleting");
    // Sent once per resend interval, and audited once.
    expect(await claimAbandonedCleanups(env, later)).toBe(0);
    const [requested] = await auditRows("volume.copy_cleanup_requested");
    expect(requested!.metadata).toMatchObject({
      service_id: s.serviceId,
      node_id: s.home.joined.node_id,
    });

    s.home.agent.send({
      type: "volume_status",
      volumes: [
        { volume_id: s.volumeId, state: "deleted", size_bytes: 0, used_bytes: 0, quota: "loop" },
      ],
    });
    await eventually(async () => ((await copies(s))[0]?.state === "deleted" ? true : undefined));
    const [deleted] = await auditRows("volume.copy_deleted");
    expect(deleted!.metadata).toMatchObject({ reason: "confirmed" });
    expect(await claimAbandonedCleanups(env, Date.now() + 3600_000)).toBe(0);
  }, 180_000);

  it("keeps the copy when the recovery restore failed", async () => {
    const s = await databaseStage({ nodes: 2 });
    const backupId = await dumpBackup(s);
    await goOffline(s.home.joined.node_id);
    other(s).agent.behaviour.restore = "fail";
    const done = await recoverOnto(s, backupId);
    expect(done.status).toBe("failed");
    await comeBack(s.home.joined.node_id);
    const [copy] = await copies(s);
    expect(copy).toMatchObject({ state: "kept" });
    expect(copy!.message).toMatch(/only data/);
    await env.DB.prepare("UPDATE volumes SET delete_after = ? WHERE id = ?")
      .bind(Date.now() - 1000, s.volumeId)
      .run();
    expect(await claimAbandonedCleanups(env, Date.now())).toBe(0);
    expect(s.home.agent.received.some((m) => m.type === "volume_delete")).toBe(false);
  }, 180_000);
});

const policyUrl = (s: DatabaseStage) =>
  `/v1/services/${s.serviceId}/recovery-policy?environment_id=${s.envId}`;

async function enable(s: DatabaseStage, body: Record<string, unknown> = {}) {
  return s.owner.json<PolicyBody & { error?: { code: string } }>(
    `/v1/services/${s.serviceId}/recovery-policy`,
    { method: "PUT", json: { environment_id: s.envId, enabled: true, grace_minutes: 5, ...body } },
  );
}

const policy = async (s: DatabaseStage) => (await s.owner.json<PolicyBody>(policyUrl(s))).body;

describe("automatic recovery", () => {
  it("is off by default, and recovers after the grace period", async () => {
    const s = await databaseStage({ nodes: 2 });
    expect(await policy(s)).toMatchObject({ enabled: false, status: "idle", grace_minutes: 30 });
    const backupId = await dumpBackup(s);
    const saved = await enable(s);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ enabled: true, grace_minutes: 5, status: "idle" });
    expect(saved.body.enabled_by).toBe(s.installed.userId);
    expect(await auditRows("recovery.policy_updated")).toHaveLength(1);

    const since = Date.now() - 60_000;
    await goOffline(s.home.joined.node_id, since);
    expect(await claimRecoveries(env, Date.now())).toBe(0);
    expect(await policy(s)).toMatchObject({ status: "watching" });

    expect(await claimRecoveries(env, since + 6 * 60_000)).toBe(1);
    const p = await policy(s);
    expect(p.status).toBe("recovering");
    const done = await waitForState(
      async () => (await s.owner.json<RestoreBody>(`/v1/restores/${p.restore_id}`)).body,
      ["succeeded", "failed"],
      90_000,
    );
    expect(done).toMatchObject({
      status: "succeeded",
      trigger: "automatic",
      target_node_id: other(s).joined.node_id,
    });
    const restoreJob = other(s).agent.received.find(
      (m) => m.type === "restore_job" && m.restore_id === done.id,
    );
    expect(restoreJob).toMatchObject({ backup_id: backupId });

    await claimRecoveries(env, Date.now());
    expect(await policy(s)).toMatchObject({ status: "recovered" });
    const [triggered] = await auditRows("recovery.triggered");
    expect(triggered).toMatchObject({ actor_type: "system" });
    expect(triggered!.metadata).toMatchObject({
      enabled_by: s.installed.userId,
      lost_node_id: s.home.joined.node_id,
      target_node_id: other(s).joined.node_id,
      backup_id: backupId,
    });
    // The abandoned copy follows the usual cleanup.
    expect((await copies(s))[0]).toMatchObject({ state: "waiting_for_server" });
  }, 180_000);

  it("blocks when the enabler lost access, or there is nothing to restore", async () => {
    const s = await databaseStage({ nodes: 2 });
    const admin = await addMember(s.owner, s.workspaceId, "ops@example.com", "admin");
    const saved = await admin.json<PolicyBody>(`/v1/services/${s.serviceId}/recovery-policy`, {
      method: "PUT",
      json: { environment_id: s.envId, enabled: true, grace_minutes: 5 },
    });
    expect(saved.status).toBe(200);

    const since = Date.now() - 10 * 60_000;
    await goOffline(s.home.joined.node_id, since);
    expect(await claimRecoveries(env, Date.now())).toBe(0);
    expect(await policy(s)).toMatchObject({ status: "blocked" });
    expect((await policy(s)).message).toMatch(/no succeeded backup/);

    await dumpBackup(s).catch(() => undefined);
    await env.DB.prepare(
      "UPDATE workspace_members SET role = 'member' WHERE user_id = (SELECT id FROM users WHERE email = ?)",
    )
      .bind("ops@example.com")
      .run();
    expect(await claimRecoveries(env, Date.now())).toBe(0);
    const p = await policy(s);
    expect(p.status).toBe("blocked");
    expect(p.message).toMatch(/may no longer backups:restore/);
    const blocked = await auditRows("recovery.blocked");
    expect(blocked.length).toBeGreaterThanOrEqual(2);
    expect(other(s).agent.received.some((m) => m.type === "restore_job")).toBe(false);
  }, 180_000);

  it("never treats a server in maintenance as lost", async () => {
    const s = await databaseStage({ nodes: 2 });
    await dumpBackup(s);
    expect((await enable(s)).status).toBe(200);
    await env.DB.prepare("UPDATE nodes SET status = 'maintenance' WHERE id = ?")
      .bind(s.home.joined.node_id)
      .run();
    expect(await claimRecoveries(env, Date.now() + 24 * 3600_000)).toBe(0);
    expect(await policy(s)).toMatchObject({ status: "idle" });
  }, 120_000);

  it("needs what a manual recovery needs, and a fresh session", async () => {
    const s = await databaseStage({ nodes: 1 });
    const member = await addMember(s.owner, s.workspaceId, "dev@example.com", "member");
    const denied = await member.json(`/v1/services/${s.serviceId}/recovery-policy`, {
      method: "PUT",
      json: { environment_id: s.envId, enabled: true },
    });
    expect(denied.status).toBe(403);
    const short = await enable(s, { grace_minutes: 1 });
    expect(short.status).toBe(400);
    await env.DB.prepare(
      "UPDATE sessions SET created_at = ?, reauthenticated_at = NULL WHERE user_id = ?",
    )
      .bind(Date.now() - 3600_000, s.installed.userId)
      .run();
    const stale = await enable(s);
    expect(stale.status).toBe(403);
    expect(stale.body.error?.code).toBe("reauth_required");
  }, 120_000);
});
