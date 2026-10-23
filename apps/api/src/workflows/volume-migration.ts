/**
 * One move of a volume to another node as a Cloudflare Workflow (ADR 0004,
 * "Volume migration between nodes"); the instance ID is the `mig_…` ID.
 *
 * Steps:
 * 1. `start`: claim the migration, re-check the target, and list the volume
 *    on the target (`desired_state.volumes`), while the service keeps
 *    running on the source.
 * 2. Wait until the target reports the volume `ready`.
 * 3. `stop`: mark the volume `migrating`; the source's desired state drops
 *    the service's replica, so the container stops (its stop grace, then
 *    SIGKILL) and nothing writes to the data any more.
 * 4. `copy-out`: a snapshot backup (`trigger: migration`) through a
 *    `volume_copy_out` whose part URLs are sealed to the source; the
 *    agent holds the replica stopped for the archive. Wait for its result,
 *    complete the upload and check the object's size.
 * 5. `copy-in`: a `volume_copy_in` to the target with the download URL and
 *    the project's age identity sealed to it; the agent checks the SHA-256
 *    before it decrypts or writes anything.
 * 6. `repin`: the volume's node becomes the target, the source's copy is
 *    scheduled for deletion after the grace period, and the service's
 *    active deployment is deployed again (same image and config) there.
 * 7. Wait until that deployment is active; `finish` audits `volume.migrated`.
 *
 * Any failure before `repin` rolls back: the volume returns to its prior
 * status on the source, so the service starts there again, and the
 * target's partial copy is scheduled for deletion. A failure after it
 * leaves the volume on the target (the data is there) and reports why.
 *
 * SECURITY: step results are persisted by the platform, so no step returns
 * a presigned URL, a sealed box or a key; the steps that make them also send
 * them.
 *
 * @module
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  backupParts,
  backups,
  createDb,
  type Db,
  deployments,
  nodes,
  services,
  volumeMigrations,
  volumes,
} from "@roundhouse/db";
import {
  backupObjectKey,
  backupPartSize,
  newId,
  VOLUME_MIGRATION_KEEP_MS,
  type VolumeMigrationPhase,
} from "@roundhouse/shared";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Env } from "../env";
import {
  BACKUP_TIMEOUT_S,
  BACKUP_WAIT_GRACE_S,
  BackupIntegrityError,
  completeUpload,
  FIRST_JOB_PARTS,
  failBackup,
  scrubError,
  sealPartUrls,
} from "../lib/backups/backups";
import { ensureBackupRecipient, loadBackupIdentity } from "../lib/backups/keys";
import { sealRestoreSecrets } from "../lib/backups/restores";
import { loadBackupStorage } from "../lib/backups/storage";
import { createDeployment, disposeRpc } from "../lib/deployments";
import { refreshNodes } from "../lib/desired-state";
import { ApiError } from "../lib/errors";
import { createMultipartUpload, headObject } from "../lib/s3";
import {
  auditMigration,
  cancelCleanupOn,
  eligibilityContext,
  MIGRATABLE_VOLUME_STATUSES,
  MIGRATION_EVENT,
  type MigrationRow,
  replicaOn,
  targetIneligibility,
  type VolumeMigrationParams,
} from "../lib/volume-migrations";

/** How a migration workflow ended. */
export interface VolumeMigrationOutput {
  status: "succeeded" | "failed" | "skipped";
}

const DB_STEP = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

const NETWORK_STEP = {
  retries: { limit: 4, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

/** How long the target gets to create the volume. */
export const TARGET_READY_TIMEOUT_MS = 15 * 60 * 1000;

/** How long the redeploy on the target gets to become active. */
export const REDEPLOY_TIMEOUT_MS = 30 * 60 * 1000;

/** Poll interval while waiting for the redeploy, which sends no event. */
const REDEPLOY_POLL = "10 seconds";

const MAX_WAKEUPS = 20;

/** Everything later steps need. Serialisable and secret-free. */
interface Plan {
  migrationId: string;
  volumeId: string;
  projectId: string;
  serviceId: string;
  environmentId: string;
  sourceNodeId: string;
  targetNodeId: string;
}

type Verdict<T = object> =
  | ({ kind: "ok" } & T)
  | { kind: "stop" }
  | { kind: "fail"; reason: string };
type Check = Verdict | { kind: "pending" };

const fail = (reason: string) => ({ kind: "fail", reason }) as const;

/** Runs one volume migration. */
export class VolumeMigrationWorkflow extends WorkflowEntrypoint<Env, VolumeMigrationParams> {
  override async run(
    event: Readonly<WorkflowEvent<VolumeMigrationParams>>,
    step: WorkflowStep,
  ): Promise<VolumeMigrationOutput> {
    const { migrationId, origin } = event.payload;
    let outcome: Verdict;
    try {
      outcome = await this.pipeline(step, migrationId, origin);
    } catch (err) {
      outcome = fail(err instanceof Error ? err.message : String(err));
    }
    if (outcome.kind === "stop") return { status: "skipped" };
    if (outcome.kind === "fail") {
      const reason = outcome.reason;
      await step.do("fail", NETWORK_STEP, () => this.failOrRollBack(migrationId, reason));
      return { status: "failed" };
    }
    return { status: "succeeded" };
  }

  private db(): Db {
    return createDb(this.env.DB);
  }

  private async pipeline(step: WorkflowStep, migrationId: string, origin: string): Promise<Verdict> {
    const started = await step.do("start", NETWORK_STEP, () => this.start(migrationId));
    if (started.kind !== "ok") return started;
    const plan = started.plan;

    const readyBy = await step.do("target-deadline", async () => Date.now() + TARGET_READY_TIMEOUT_MS);
    const ready = await this.waitFor(step, "target", readyBy, (i) =>
      step.do(`check-target-${i}`, DB_STEP, () => this.checkTarget(plan)),
    );
    if (ready.kind !== "ok") return ready;

    const stopped = await step.do("stop", NETWORK_STEP, () => this.stop(plan));
    if (stopped.kind !== "ok") return stopped;

    const out = await step.do("copy-out", NETWORK_STEP, () => this.copyOut(plan, stopped.workloadId));
    if (out.kind !== "ok") return out;
    const copyBy = await step.do(
      "copy-out-deadline",
      async () => Date.now() + (BACKUP_TIMEOUT_S + BACKUP_WAIT_GRACE_S) * 1000,
    );
    const answered = await this.waitFor(step, "copy-out", copyBy, (i) =>
      step.do(`check-copy-out-${i}`, DB_STEP, () => this.checkCopyOut(out.backupId)),
    );
    if (answered.kind !== "ok") return answered;
    const completed = await step.do("complete-copy-out", NETWORK_STEP, () =>
      this.completeCopyOut(out.backupId),
    );
    if (completed.kind !== "ok") return completed;

    const sent = await step.do("copy-in", NETWORK_STEP, () => this.copyIn(plan, out.backupId));
    if (sent.kind !== "ok") return sent;
    const inBy = await step.do(
      "copy-in-deadline",
      async () => Date.now() + (BACKUP_TIMEOUT_S + BACKUP_WAIT_GRACE_S) * 1000,
    );
    const copied = await this.waitFor(step, "copy-in", inBy, (i) =>
      step.do(`check-copy-in-${i}`, DB_STEP, () => this.checkCopyIn(plan)),
    );
    if (copied.kind !== "ok") return copied;

    const repinned = await step.do("repin", NETWORK_STEP, () => this.repin(plan, origin));
    if (repinned.kind !== "ok") return repinned;

    if (repinned.deploymentId) {
      const deployBy = await step.do("deploy-deadline", async () => Date.now() + REDEPLOY_TIMEOUT_MS);
      for (let i = 0; ; i++) {
        const verdict = await step.do(`check-deploy-${i}`, DB_STEP, () =>
          this.checkDeployment(repinned.deploymentId!),
        );
        if (verdict.kind !== "pending") {
          if (verdict.kind !== "ok") return verdict;
          break;
        }
        if (Date.now() > deployBy) {
          return fail("redeploy_timed_out: the service didn't become active on the target in time");
        }
        await step.sleep(`deploy-wait-${i}`, REDEPLOY_POLL);
      }
    }
    return step.do("finish", DB_STEP, () => this.finish(plan));
  }

  /** Alternates a D1 check with a wait for the Durable Object's wake-up. */
  private async waitFor(
    step: WorkflowStep,
    label: string,
    deadline: number,
    check: (i: number) => Promise<Check>,
  ): Promise<Verdict> {
    for (let i = 0; i < MAX_WAKEUPS; i++) {
      const verdict = await check(i);
      if (verdict.kind !== "pending") return verdict;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        await step.waitForEvent(`${label}-${i}`, { type: MIGRATION_EVENT, timeout: remaining });
      } catch {
        const last = await check(MAX_WAKEUPS + i);
        if (last.kind !== "pending") return last;
        break;
      }
    }
    return fail(`timed_out: the ${label.replace("-", " ")} didn't finish in time`);
  }

  private async setPhase(db: Db, migrationId: string, phase: VolumeMigrationPhase) {
    await db
      .update(volumeMigrations)
      .set({ phase, updatedAt: new Date() })
      .where(and(eq(volumeMigrations.id, migrationId), eq(volumeMigrations.status, "running")));
  }

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  private async start(migrationId: string): Promise<Verdict<{ plan: Plan }>> {
    const db = this.db();
    const [row] = await db
      .select({ migration: volumeMigrations, volume: volumes })
      .from(volumeMigrations)
      .innerJoin(volumes, eq(volumes.id, volumeMigrations.volumeId))
      .where(eq(volumeMigrations.id, migrationId))
      .limit(1);
    if (!row) return { kind: "stop" };
    const { migration: m, volume } = row;
    if (m.status !== "queued" && m.status !== "running") return { kind: "stop" };
    if (!m.sourceNodeId || !m.targetNodeId) return fail("node_gone: a node of the move was removed");
    const plan: Plan = {
      migrationId,
      volumeId: volume.id,
      projectId: volume.projectId,
      serviceId: volume.serviceId,
      environmentId: volume.environmentId,
      sourceNodeId: m.sourceNodeId,
      targetNodeId: m.targetNodeId,
    };
    // A retried start after the claim finds the migration running and goes on.
    if (m.status === "running") return { kind: "ok", plan };
    if (volume.nodeId !== m.sourceNodeId) return fail("volume_moved: the volume changed nodes");
    if (!(MIGRATABLE_VOLUME_STATUSES as readonly string[]).includes(volume.status)) {
      return fail(`volume_not_ready: the volume is ${volume.status.replace(/_/g, " ")}`);
    }
    const [target] = await db.select().from(nodes).where(eq(nodes.id, m.targetNodeId)).limit(1);
    if (!target) return fail("node_gone: the target node was removed");
    const reason = targetIneligibility(target, await eligibilityContext(db, volume));
    if (reason) return fail(`target_ineligible: ${reason}`);
    const now = new Date();
    const claimed = await db
      .update(volumeMigrations)
      .set({ status: "running", phase: "preparing_target", startedAt: now, updatedAt: now })
      .where(and(eq(volumeMigrations.id, migrationId), eq(volumeMigrations.status, "queued")))
      .returning({ id: volumeMigrations.id });
    if (!claimed.length) return { kind: "stop" };
    await cancelCleanupOn(db, volume.id, m.targetNodeId);
    await refreshNodes(this.env, db, [m.targetNodeId]);
    return { kind: "ok", plan };
  }

  private async load(plan: Plan): Promise<MigrationRow | undefined> {
    const [row] = await this.db()
      .select()
      .from(volumeMigrations)
      .where(eq(volumeMigrations.id, plan.migrationId))
      .limit(1);
    return row;
  }

  private async checkTarget(plan: Plan): Promise<Check> {
    const m = await this.load(plan);
    if (m?.status !== "running") return { kind: "stop" };
    if (m.targetState === "ready") return { kind: "ok" };
    if (m.targetState === "error" || m.targetState === "deleted") {
      return fail("target_volume_error: the target node couldn't create the volume");
    }
    return { kind: "pending" };
  }

  private async stop(plan: Plan): Promise<Verdict<{ workloadId: string | null }>> {
    const db = this.db();
    const m = await this.load(plan);
    if (m?.status !== "running") return { kind: "stop" };
    const now = new Date();
    const [held] = await db
      .update(volumes)
      .set({ status: "migrating", updatedAt: now })
      .where(
        and(
          eq(volumes.id, plan.volumeId),
          eq(volumes.nodeId, plan.sourceNodeId),
          inArray(volumes.status, [...MIGRATABLE_VOLUME_STATUSES, "migrating"]),
        ),
      )
      .returning({ id: volumes.id });
    if (!held) return fail("volume_changed: the volume was deleted or moved meanwhile");
    await this.setPhase(db, plan.migrationId, "stopping");
    await refreshNodes(this.env, db, [plan.sourceNodeId]);
    return { kind: "ok", workloadId: await replicaOn(db, plan, plan.sourceNodeId) };
  }

  private async copyOut(
    plan: Plan,
    workloadId: string | null,
  ): Promise<Verdict<{ backupId: string }>> {
    const db = this.db();
    const storage = await loadBackupStorage(db, this.env);
    if (!storage) return fail("backup_storage_not_configured");
    const m = await this.load(plan);
    if (m?.status !== "running") return { kind: "stop" };
    const [source] = await db
      .select({ key: nodes.encryptionPublicKey })
      .from(nodes)
      .where(and(eq(nodes.id, plan.sourceNodeId), isNull(nodes.deletedAt)))
      .limit(1);
    if (!source?.key) return fail("node_offline: the source node is gone or has no encryption key");

    let backup = m.backupId
      ? (await db.select().from(backups).where(eq(backups.id, m.backupId)).limit(1))[0]
      : undefined;
    if (!backup) {
      const [volume] = await db.select().from(volumes).where(eq(volumes.id, plan.volumeId)).limit(1);
      const [service] = await db
        .select({ engine: services.databaseEngine, version: services.databaseVersion })
        .from(services)
        .where(eq(services.id, plan.serviceId))
        .limit(1);
      const id = newId("backup");
      const objectKey = backupObjectKey({
        projectId: plan.projectId,
        serviceId: plan.serviceId,
        environmentId: plan.environmentId,
        id,
      });
      const uploadId = await createMultipartUpload(storage, objectKey);
      const now = new Date();
      // One batch, so a retried step never leaves an orphan backup row.
      const [[row]] = await db.batch([
        db
          .insert(backups)
          .values({
            id,
            projectId: plan.projectId,
            serviceId: plan.serviceId,
            environmentId: plan.environmentId,
            volumeId: plan.volumeId,
            trigger: "migration",
            method: "snapshot",
            engine: service?.engine ?? null,
            engineVersion: service?.version ?? null,
            status: "running",
            nodeId: plan.sourceNodeId,
            objectKey,
            uploadId,
            partSizeBytes: backupPartSize(volume?.usedBytes ?? 0),
            pinned: false,
            requestedBy: m.requestedBy,
            startedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning(),
        db
          .update(volumeMigrations)
          .set({ backupId: id, phase: "copying_out", updatedAt: now })
          .where(and(eq(volumeMigrations.id, plan.migrationId), isNull(volumeMigrations.backupId))),
      ]);
      backup = row!;
    }
    const recipient = await ensureBackupRecipient(db, this.env, plan.projectId);
    const sealed = await sealPartUrls(
      storage,
      { id: backup.id, objectKey: backup.objectKey, uploadId: backup.uploadId! },
      { id: plan.sourceNodeId, publicKey: source.key },
      1,
      FIRST_JOB_PARTS,
    );
    const stub = this.env.NODE_CONNECTION.get(this.env.NODE_CONNECTION.idFromName(plan.sourceNodeId));
    const result = await stub.sendBackupJob({
      type: "volume_copy_out",
      migration_id: plan.migrationId,
      backup_id: backup.id,
      volume_id: plan.volumeId,
      ...(workloadId ? { workload_id: workloadId } : {}),
      age_recipient: recipient,
      part_size_bytes: backup.partSizeBytes!,
      parts_sealed: sealed!,
      timeout_s: BACKUP_TIMEOUT_S,
    });
    const verdict: Verdict<{ backupId: string }> = result.sent
      ? { kind: "ok", backupId: backup.id }
      : fail(
          result.reason === "not_connected"
            ? "node_offline: the source node is not connected"
            : "agent_outdated: the source node's agent can't copy volumes",
        );
    disposeRpc(result);
    return verdict;
  }

  private async checkCopyOut(backupId: string): Promise<Check> {
    const [row] = await this.db()
      .select({ status: backups.status, error: backups.error, sha256: backups.sha256 })
      .from(backups)
      .where(eq(backups.id, backupId))
      .limit(1);
    if (!row || row.status !== "running") return fail("copy_out_failed: the snapshot backup is gone");
    if (row.error) return fail(`copy_out_failed: ${row.error}`);
    if (row.sha256) return { kind: "ok" };
    return { kind: "pending" };
  }

  private async completeCopyOut(backupId: string): Promise<Verdict> {
    const db = this.db();
    const storage = await loadBackupStorage(db, this.env);
    if (!storage) return fail("backup_storage_not_configured");
    const [row] = await db.select().from(backups).where(eq(backups.id, backupId)).limit(1);
    if (row?.status === "succeeded") return { kind: "ok" };
    if (row?.status !== "running") return fail("copy_out_failed: the snapshot backup is gone");
    const existing = await headObject(storage, row.objectKey);
    if (!existing || existing.size !== row.bytesStored) {
      try {
        await completeUpload(db, storage, row);
      } catch (err) {
        if (err instanceof BackupIntegrityError) return fail(`integrity: ${err.message}`);
        throw err;
      }
    }
    const now = new Date();
    await db.batch([
      db
        .update(backups)
        .set({ status: "succeeded", finishedAt: now, updatedAt: now })
        .where(and(eq(backups.id, backupId), eq(backups.status, "running"))),
      db.delete(backupParts).where(eq(backupParts.backupId, backupId)),
    ]);
    return { kind: "ok" };
  }

  private async copyIn(plan: Plan, backupId: string): Promise<Verdict> {
    const db = this.db();
    const storage = await loadBackupStorage(db, this.env);
    if (!storage) return fail("backup_storage_not_configured");
    const [backup] = await db.select().from(backups).where(eq(backups.id, backupId)).limit(1);
    if (backup?.status !== "succeeded" || !backup.sha256 || !backup.bytesStored) {
      return fail("copy_out_failed: the snapshot backup didn't succeed");
    }
    const [target] = await db
      .select({ key: nodes.encryptionPublicKey })
      .from(nodes)
      .where(and(eq(nodes.id, plan.targetNodeId), isNull(nodes.deletedAt)))
      .limit(1);
    if (!target?.key) return fail("node_offline: the target node is gone or has no encryption key");
    const identity = await loadBackupIdentity(db, this.env, plan.projectId);
    if (!identity) return fail("backup_key_missing: the project has no backup key");
    const sealed = await sealRestoreSecrets(
      storage,
      backup.objectKey,
      identity,
      { id: plan.targetNodeId, publicKey: target.key },
      plan.migrationId,
    );
    // Recorded before sending, so the node's answer is accepted however fast it comes.
    await db
      .update(volumeMigrations)
      .set({ phase: "copying_in", copyFinishedAt: null, copyError: null, updatedAt: new Date() })
      .where(and(eq(volumeMigrations.id, plan.migrationId), eq(volumeMigrations.status, "running")));
    const stub = this.env.NODE_CONNECTION.get(this.env.NODE_CONNECTION.idFromName(plan.targetNodeId));
    const result = await stub.sendBackupJob({
      type: "volume_copy_in",
      migration_id: plan.migrationId,
      volume_id: plan.volumeId,
      backup_id: backup.id,
      sha256: backup.sha256,
      size_bytes: backup.bytesStored,
      secrets_sealed: sealed,
      timeout_s: BACKUP_TIMEOUT_S,
    });
    const verdict: Verdict = result.sent
      ? { kind: "ok" }
      : fail(
          result.reason === "not_connected"
            ? "node_offline: the target node is not connected"
            : "agent_outdated: the target node's agent can't copy volumes",
        );
    disposeRpc(result);
    return verdict;
  }

  private async checkCopyIn(plan: Plan): Promise<Check> {
    const m = await this.load(plan);
    if (m?.status !== "running") return { kind: "stop" };
    if (!m.copyFinishedAt) return { kind: "pending" };
    return m.copyError ? fail(`copy_in_failed: ${m.copyError}`) : { kind: "ok" };
  }

  private async repin(
    plan: Plan,
    origin: string,
  ): Promise<Verdict<{ deploymentId: string | null }>> {
    const db = this.db();
    const m = await this.load(plan);
    if (m?.status !== "running") return { kind: "stop" };
    if (m.phase === "starting") return { kind: "ok", deploymentId: m.deploymentId };
    const now = new Date();
    const [[moved]] = await db.batch([
      db
        .update(volumes)
        .set({
          nodeId: plan.targetNodeId,
          status: m.priorStatus === "degraded" ? "degraded" : "ready",
          updatedAt: now,
        })
        .where(
          and(
            eq(volumes.id, plan.volumeId),
            eq(volumes.nodeId, plan.sourceNodeId),
            eq(volumes.status, "migrating"),
          ),
        )
        .returning({ id: volumes.id }),
      db
        .update(volumeMigrations)
        .set({
          phase: "starting",
          cleanupNodeId: plan.sourceNodeId,
          cleanupAfter: new Date(+now + VOLUME_MIGRATION_KEEP_MS),
          updatedAt: now,
        })
        .where(and(eq(volumeMigrations.id, plan.migrationId), eq(volumeMigrations.status, "running"))),
    ]);
    if (!moved) return fail("volume_changed: the volume was deleted or moved meanwhile");
    let deploymentId: string | null = null;
    const [active] = await db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.serviceId, plan.serviceId),
          eq(deployments.environmentId, plan.environmentId),
          inArray(deployments.status, ["active", "crashed"]),
        ),
      )
      .orderBy(desc(deployments.id))
      .limit(1);
    if (active) {
      try {
        const row = await createDeployment(
          { db, env: this.env },
          {
            projectId: plan.projectId,
            serviceId: plan.serviceId,
            environmentId: plan.environmentId,
            trigger: "migration",
            triggeredBy: m.requestedBy,
            origin,
            rollbackOf: active,
          },
        );
        deploymentId = row.id;
      } catch (err) {
        // A service scaled to zero has nothing to start; the move is still done.
        if (!(err instanceof ApiError)) throw err;
      }
    }
    await db
      .update(volumeMigrations)
      .set({ deploymentId, updatedAt: new Date() })
      .where(eq(volumeMigrations.id, plan.migrationId));
    await refreshNodes(this.env, db, [plan.sourceNodeId, plan.targetNodeId]);
    return { kind: "ok", deploymentId };
  }

  private async checkDeployment(deploymentId: string): Promise<Check> {
    const [row] = await this.db()
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.id, deploymentId))
      .limit(1);
    if (!row) return fail("redeploy_failed: the redeploy is gone");
    if (row.status === "active") return { kind: "ok" };
    if (row.status === "failed" || row.status === "cancelled" || row.status === "crashed") {
      return fail(`redeploy_failed: the redeploy on the target is ${row.status}`);
    }
    return { kind: "pending" };
  }

  private async finish(plan: Plan): Promise<Verdict> {
    const db = this.db();
    const now = new Date();
    const [row] = await db
      .update(volumeMigrations)
      .set({ status: "succeeded", phase: "done", finishedAt: now, updatedAt: now })
      .where(and(eq(volumeMigrations.id, plan.migrationId), eq(volumeMigrations.status, "running")))
      .returning();
    if (row) {
      await auditMigration(db, row, "volume.migrated", {
        backup_id: row.backupId,
        deployment_id: row.deploymentId,
        copied_bytes: row.copiedBytes,
      });
    }
    return { kind: "ok" };
  }

  /**
   * Ends a failed migration. Before the volume was pinned to the target,
   * everything goes back: the volume returns to its prior status on the
   * source, whose desired state brings the service back, and the target's
   * copy is scheduled for deletion. After, the volume stays on the target.
   */
  private async failOrRollBack(migrationId: string, reason: string): Promise<void> {
    const db = this.db();
    const [m] = await db
      .select()
      .from(volumeMigrations)
      .where(eq(volumeMigrations.id, migrationId))
      .limit(1);
    if (!m || (m.status !== "queued" && m.status !== "running")) return;
    const message = scrubError(reason);
    const now = new Date();
    const repinned = m.phase === "starting" || m.phase === "done";
    if (!repinned && m.sourceNodeId) {
      await db
        .update(volumes)
        .set({ status: m.priorStatus === "degraded" ? "degraded" : "ready", updatedAt: now })
        .where(
          and(
            eq(volumes.id, m.volumeId),
            eq(volumes.nodeId, m.sourceNodeId),
            eq(volumes.status, "migrating"),
          ),
        );
    }
    const touchedTarget = !repinned && m.phase !== "queued" && m.targetNodeId !== null;
    const [row] = await db
      .update(volumeMigrations)
      .set({
        status: "failed",
        phase: repinned ? m.phase : "rolling_back",
        error: message,
        finishedAt: now,
        updatedAt: now,
        ...(touchedTarget
          ? {
              cleanupNodeId: m.targetNodeId,
              cleanupAfter: new Date(+now + VOLUME_MIGRATION_KEEP_MS),
            }
          : {}),
      })
      .where(and(eq(volumeMigrations.id, migrationId), inArray(volumeMigrations.status, ["queued", "running"])))
      .returning();
    if (!row) return;
    if (m.backupId) {
      const storage = await loadBackupStorage(db, this.env).catch(() => null);
      await failBackup(db, storage, m.backupId, `migration failed: ${message}`);
    }
    const touched = [m.sourceNodeId, m.targetNodeId].filter((n): n is string => n !== null);
    await refreshNodes(this.env, db, touched);
    await auditMigration(db, row, "volume.migration_failed", {
      error: message,
      rolled_back: !repinned,
    });
  }
}

