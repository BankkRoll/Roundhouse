/**
 * Moving a volume between nodes (ADR 0004, "Volume migration between
 * nodes"): eligibility and the downtime estimate, the move itself (the
 * service stops, a snapshot is copied out and in through sealed frames and
 * checked, the volume is repinned and the service redeployed on the
 * target), rollback on failure, the cleanup of the copy left behind, and
 * the route's confirmation, reauth, RBAC and audit without secrets.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import {
  type ControlMessage,
  type DesiredState,
  openBox,
  restoreSecretsAad,
  type VolumeCopyIn,
  type VolumeCopyOut,
  type VolumeDelete,
} from "@roundhouse/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setS3Transport } from "../src/lib/s3";
import { claimMigrationCleanups, targetIneligibility } from "../src/lib/volume-migrations";
import { allAuditText, auditRows } from "./backups-helpers";
import { type DatabaseStage, databaseStage, type StageNode, waitForState } from "./data-stage";
import { addMember, eventually, NODE_ENCRYPTION_PRIVATE_KEY } from "./helpers";
import { settleDeployments } from "./pipeline-helpers";

let introspectors: { dispose(): Promise<void> }[] = [];
beforeEach(async () => {
  introspectors = [
    await introspectWorkflow(env.DEPLOY_WORKFLOW),
    await introspectWorkflow(env.VOLUME_MIGRATION_WORKFLOW),
  ];
});
afterEach(async () => {
  await settleDeployments();
  for (const i of introspectors) await i.dispose();
  setS3Transport();
});

interface MigrationBody {
  id: string;
  status: string;
  phase: string;
  error: string | null;
  backup_id: string | null;
  deployment_id: string | null;
  source_node_id: string | null;
  target_node_id: string | null;
  cleanup_after: number | null;
}

interface TargetsBody {
  estimated_downtime_ms: number;
  targets: {
    node_id: string;
    eligible: boolean;
    reason: string | null;
    quota_mode: string | null;
  }[];
}

const other = (s: DatabaseStage): StageNode => s.nodes.find((n) => n !== s.home)!;

const migrate = (s: DatabaseStage, body: Record<string, unknown>) =>
  s.owner.json<MigrationBody & { error: { code: string; message: string } }>(
    `/v1/volumes/${s.volumeId}/migrate`,
    { method: "POST", json: { confirm: s.serviceSlug, ...body } },
  );

const finished = (s: DatabaseStage, id: string) =>
  waitForState(
    async () => (await s.owner.json<MigrationBody>(`/v1/volume-migrations/${id}`)).body,
    ["succeeded", "failed"],
    90_000,
  );

async function volume(id: string) {
  return env.DB.prepare("SELECT node_id, status FROM volumes WHERE id = ?")
    .bind(id)
    .first<{ node_id: string; status: string }>();
}

/** Whether the latest desired state sent to a node runs a workload of the service. */
function runsOn(node: StageNode, serviceId: string): boolean {
  const desired = [...node.agent.received]
    .reverse()
    .find((m): m is DesiredState => m.type === "desired_state");
  return desired?.workloads.some((w) => w.service_id === serviceId) ?? false;
}

describe("migration targets", () => {
  it("offers the other nodes, explains the ineligible ones, and estimates the downtime", async () => {
    const s = await databaseStage({
      nodes: 3,
      hello: (i) => (i === 2 ? { volume_quota: "none" } : {}),
    });
    const res = await s.owner.json<TargetsBody>(`/v1/volumes/${s.volumeId}/migration-targets`);
    expect(res.status).toBe(200);
    expect(res.body.estimated_downtime_ms).toBeGreaterThanOrEqual(60_000);
    expect(res.body.targets.map((t) => t.node_id)).not.toContain(s.home.joined.node_id);
    const noQuota = s.nodes[2]!.joined.node_id;
    for (const t of res.body.targets) {
      if (t.node_id === noQuota && s.home.joined.node_id !== noQuota) {
        expect(t).toMatchObject({ eligible: false, quota_mode: "none" });
        expect(t.reason).toMatch(/doesn't enforce volume quotas/);
      } else if (t.quota_mode === "loop") {
        expect(t).toMatchObject({ eligible: true, reason: null });
      }
    }
  }, 60_000);

  it("refuses nodes that can't take the volume", () => {
    const now = Date.now();
    const node = {
      id: "node_b",
      deletedAt: null,
      status: "online",
      lastHeartbeatAt: new Date(now),
      protocolVersion: 5,
      encryptionPublicKey: "k",
      capabilities: { docker: true, gvisor: false, builder: false },
      labels: {},
      volumeQuota: "loop",
      diskTotal: 10 * 2 ** 30,
    } as unknown as Parameters<typeof targetIneligibility>[0];
    const ctx = {
      volume: { nodeId: "node_a", sizeMb: 5120 } as Parameters<
        typeof targetIneligibility
      >[1]["volume"],
      nodeSelector: {},
      sourceQuota: "loop",
      allocatedMb: new Map([["node_b", 8 * 1024]]),
      hasTcpProxy: false,
      cleaningUp: new Set<string>(),
      now,
    };
    expect(targetIneligibility(node, ctx)).toMatch(/unallocated/);
    expect(targetIneligibility(node, { ...ctx, allocatedMb: new Map() })).toBeNull();
    expect(
      targetIneligibility(node, { ...ctx, allocatedMb: new Map(), hasTcpProxy: true }),
    ).toMatch(/TCP proxy/);
    expect(
      targetIneligibility(
        { ...node, labels: {} },
        { ...ctx, allocatedMb: new Map(), nodeSelector: { zone: "a" } },
      ),
    ).toMatch(/zone=a/);
    expect(
      targetIneligibility(node, {
        ...ctx,
        allocatedMb: new Map(),
        cleaningUp: new Set(["node_b"]),
      }),
    ).toMatch(/still deleting/);
  });
});

describe("moving a volume", () => {
  it("stops the service, copies through sealed frames, repins and redeploys on the target", async () => {
    const s = await databaseStage({ nodes: 2 });
    const target = other(s);
    const started = await migrate(s, { target_node_id: target.joined.node_id });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({
      status: "queued",
      source_node_id: s.home.joined.node_id,
      target_node_id: target.joined.node_id,
    });
    const done = await finished(s, started.body.id);
    expect(done).toMatchObject({ status: "succeeded", phase: "done", error: null });
    expect(done.cleanup_after).toBeGreaterThan(Date.now() + 71 * 60 * 60 * 1000);

    expect(await volume(s.volumeId)).toMatchObject({
      node_id: target.joined.node_id,
      status: "ready",
    });
    const redeploy = await s.owner.json<{ status: string; trigger: string }>(
      `/v1/deployments/${done.deployment_id}`,
    );
    expect(redeploy.body).toMatchObject({ status: "active", trigger: "migration" });
    await eventually(async () => (runsOn(target, s.serviceId) ? true : undefined), 5000);
    expect(runsOn(s.home, s.serviceId)).toBe(false);

    const out = s.home.agent.received.find(
      (m): m is VolumeCopyOut => m.type === "volume_copy_out",
    )!;
    expect(out).toMatchObject({ migration_id: done.id, volume_id: s.volumeId });
    expect(out.workload_id).toBeTruthy();
    expect(out.exp - out.iat).toBeLessThanOrEqual(60_000);
    const copyIn = target.agent.received.find(
      (m): m is VolumeCopyIn => m.type === "volume_copy_in",
    )!;
    expect(copyIn).toMatchObject({ migration_id: done.id, volume_id: s.volumeId });
    expect(copyIn.sha256).toMatch(/^[0-9a-f]{64}$/);
    // SECURITY: the download URL and identity are sealed to the target and this migration.
    await expect(
      openBox(
        NODE_ENCRYPTION_PRIVATE_KEY,
        copyIn.secrets_sealed,
        "restore",
        restoreSecretsAad(s.home.joined.node_id, done.id),
      ),
    ).rejects.toThrow();
    expect(target.agent.rejected).toEqual([]);
    expect(JSON.stringify(target.agent.received)).not.toMatch(/AGE-SECRET-KEY|X-Amz-Signature/);

    const backup = await s.owner.json<{ trigger: string; method: string; status: string }>(
      `/v1/backups/${done.backup_id}`,
    );
    expect(backup.body).toMatchObject({
      trigger: "migration",
      method: "snapshot",
      status: "succeeded",
    });

    const [startedAudit] = await auditRows("volume.migration_started");
    expect(startedAudit).toMatchObject({ actor_type: "user", target_id: s.volumeId });
    const [migrated] = await auditRows("volume.migrated");
    expect(migrated).toMatchObject({ actor_type: "system" });
    expect(migrated!.metadata).toMatchObject({ migration_id: done.id });
    expect(await allAuditText()).not.toMatch(/X-Amz|https?:\/\/|AGE-SECRET-KEY/);
  }, 120_000);

  it("rolls back to the source when the copy-in fails, and deletes the target's copy later", async () => {
    const s = await databaseStage({ nodes: 2 });
    const target = other(s);
    target.agent.behaviour.restore = "fail";
    const started = await migrate(s, { target_node_id: target.joined.node_id });
    const done = await finished(s, started.body.id);
    expect(done).toMatchObject({ status: "failed", phase: "rolling_back" });
    expect(done.error).toMatch(/^copy_in_failed/);
    expect(await volume(s.volumeId)).toMatchObject({
      node_id: s.home.joined.node_id,
      status: "ready",
    });
    await eventually(async () => (runsOn(s.home, s.serviceId) ? true : undefined), 5000);
    const [failed] = await auditRows("volume.migration_failed");
    expect(failed!.metadata).toMatchObject({ rolled_back: true });

    const row = await env.DB.prepare(
      "SELECT cleanup_node_id, cleanup_after FROM volume_migrations WHERE id = ?",
    )
      .bind(done.id)
      .first<{ cleanup_node_id: string; cleanup_after: number }>();
    expect(row?.cleanup_node_id).toBe(target.joined.node_id);
    // Not before the grace period ends.
    expect(await claimMigrationCleanups(env, Date.now())).toBe(0);
    expect(await claimMigrationCleanups(env, row!.cleanup_after + 1)).toBe(1);
    const sent = await target.agent.waitFor(
      (m: ControlMessage): m is VolumeDelete => m.type === "volume_delete",
    );
    expect(sent.volume_id).toBe(s.volumeId);
    expect(s.home.agent.received.some((m) => m.type === "volume_delete")).toBe(false);
    target.agent.send({
      type: "volume_status",
      volumes: [
        { volume_id: s.volumeId, state: "deleted", size_bytes: 0, used_bytes: 0, quota: "loop" },
      ],
    });
    await eventually(async () => {
      const r = await env.DB.prepare("SELECT cleaned_at FROM volume_migrations WHERE id = ?")
        .bind(done.id)
        .first<{ cleaned_at: number | null }>();
      return r?.cleaned_at ? true : undefined;
    });
    // The live volume on the source was never touched.
    expect(await volume(s.volumeId)).toMatchObject({ status: "ready" });
  }, 120_000);

  it("deletes the source's copy after a move, never the live one", async () => {
    const s = await databaseStage({ nodes: 2 });
    const target = other(s);
    const started = await migrate(s, { target_node_id: target.joined.node_id });
    const done = await finished(s, started.body.id);
    expect(done.status).toBe("succeeded");
    expect(await claimMigrationCleanups(env, done.cleanup_after! + 1)).toBe(1);
    const sent = await s.home.agent.waitFor(
      (m: ControlMessage): m is VolumeDelete => m.type === "volume_delete",
    );
    expect(sent.volume_id).toBe(s.volumeId);
    expect(target.agent.received.some((m) => m.type === "volume_delete")).toBe(false);
    // The migration's snapshot goes with it.
    await eventually(async () => {
      const b = await env.DB.prepare("SELECT status FROM backups WHERE id = ?")
        .bind(done.backup_id)
        .first<{ status: string }>();
      return b?.status === "deleted" ? true : undefined;
    });
  }, 120_000);
});

describe("migration guards", () => {
  it("needs the typed slug, a fresh session and an eligible target, one move at a time", async () => {
    const s = await databaseStage({ nodes: 2 });
    const target = other(s).joined.node_id;
    const wrong = await migrate(s, { target_node_id: target, confirm: "nope" });
    expect(wrong.status).toBe(400);
    const same = await migrate(s, { target_node_id: s.home.joined.node_id });
    expect(same.status).toBe(422);
    expect(same.body.error.code).toBe("migration_target_ineligible");
    const unknown = await migrate(s, { target_node_id: "node_nope" });
    expect(unknown.status).toBe(404);

    other(s).agent.behaviour.restore = "silent";
    const first = await migrate(s, { target_node_id: target });
    expect(first.status).toBe(202);
    const second = await migrate(s, { target_node_id: target });
    expect(second.status).toBe(409);
    const resize = await s.owner.json(`/v1/volumes/${s.volumeId}`, {
      method: "PATCH",
      json: { size_mb: 6144 },
    });
    expect(resize.status).toBe(409);

    await env.DB.prepare("UPDATE sessions SET created_at = ?, reauthenticated_at = NULL")
      .bind(Date.now() - 24 * 60 * 60 * 1000)
      .run();
    const stale = await migrate(s, { target_node_id: target });
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe("reauth_required");
    expect(await auditRows("volume.migration_started")).toHaveLength(1);
  }, 120_000);

  it("refuses viewers, and members who can't redeploy", async () => {
    const s = await databaseStage({ nodes: 2 });
    const target = other(s).joined.node_id;
    const viewer = await addMember(s.owner, s.workspaceId, "view@example.com", "viewer");
    const res = await viewer.json(`/v1/volumes/${s.volumeId}/migrate`, {
      method: "POST",
      json: { target_node_id: target, confirm: s.serviceSlug },
    });
    expect(res.status).toBe(403);
    const read = await viewer.json<TargetsBody>(`/v1/volumes/${s.volumeId}/migration-targets`);
    expect(read.status).toBe(200);
    expect(await auditRows("volume.migration_started")).toEqual([]);
  }, 60_000);
});
