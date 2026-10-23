/**
 * One backup as a Cloudflare Workflow (ADR 0004, "Backups"); the instance
 * ID is the `bak_…` backup ID, so starting one twice is a no-op.
 *
 * Steps:
 * 1. `start`: claim the `queued` row, find the volume, its node and (for a
 *    dump) the running replica, make sure the project has an age recipient,
 *    and `CreateMultipartUpload` with `part_size_bytes` from the volume's
 *    usage (`backupPartSize`).
 * 2. `send-job`: presign the first 16 parts, seal them to the node and send
 *    a signed `backup_job` through the node's Durable Object. The Durable
 *    Object answers `backup_parts_request`s with more URLs and records
 *    `backup_progress` parts as they arrive.
 * 3. Wait for the `backup` event (the agent's `backup_result`, recorded in
 *    D1) up to `timeout_s` + 5 minutes.
 * 4. `complete`: check the reported parts, `CompleteMultipartUpload`, check
 *    the object's size with `HeadObject`, and mark the backup `succeeded`.
 * 5. `retention`: apply the policy; `notify`: wake a restore waiting on this
 *    (safety) backup.
 *
 * Any failure aborts the upload, marks the backup `failed` with a scrubbed
 * error and audits `backup.failed` as the system.
 *
 * SECURITY: step results are persisted by the platform, so no step returns
 * a presigned URL, a sealed box or a key; the steps that make them also
 * send them.
 *
 * @module
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { backupParts, backupPolicies, backups, createDb, type Db, nodes } from "@roundhouse/db";
import type { DatabaseEngine } from "@roundhouse/protocol";
import { backupPartSize } from "@roundhouse/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Env } from "../env";
import {
  applyBackupRetention,
  BACKUP_EVENT,
  BACKUP_TIMEOUT_S,
  BACKUP_WAIT_GRACE_S,
  BackupIntegrityError,
  backupWithOwners,
  completeUpload,
  FIRST_JOB_PARTS,
  failBackup,
  sealPartUrls,
} from "../lib/backups/backups";
import { ensureBackupRecipient } from "../lib/backups/keys";
import { wakeRestoresAwaiting } from "../lib/backups/restores";
import { loadBackupStorage } from "../lib/backups/storage";
import { DATA_TARGET_MESSAGES, findDataTarget } from "../lib/backups/target";
import { disposeRpc } from "../lib/deployments";
import { createMultipartUpload, headObject } from "../lib/s3";

/** Parameters of a backup workflow instance. */
export interface BackupParams {
  backupId: string;
}

/** How a backup workflow ended. */
export interface BackupOutput {
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

/** Wake-ups one wait tolerates before giving up; the agent sends one result. */
const MAX_WAKEUPS = 20;

/** Everything later steps need, captured once. Serialisable and secret-free. */
interface Plan {
  backupId: string;
  projectId: string;
  serviceId: string;
  environmentId: string;
  trigger: string;
  nodeId: string;
  volumeId: string;
  objectKey: string;
  uploadId: string;
  partSizeBytes: number;
  method: "dump" | "snapshot";
  engine: DatabaseEngine | null;
  workloadId: string | null;
  quiesce: "none" | "stop";
  databases: string[] | null;
  ageRecipient: string;
  timeoutS: number;
}

type Verdict<T = object> =
  | ({ kind: "ok" } & T)
  | { kind: "stop" }
  | { kind: "fail"; reason: string };

const fail = (reason: string) => ({ kind: "fail", reason }) as const;

/** Runs one backup. */
export class BackupWorkflow extends WorkflowEntrypoint<Env, BackupParams> {
  override async run(
    event: Readonly<WorkflowEvent<BackupParams>>,
    step: WorkflowStep,
  ): Promise<BackupOutput> {
    const { backupId } = event.payload;
    let outcome: Verdict;
    try {
      outcome = await this.pipeline(step, backupId);
    } catch (err) {
      outcome = fail(err instanceof Error ? err.message : String(err));
    }
    if (outcome.kind === "stop") return { status: "skipped" };
    if (outcome.kind === "fail") {
      const reason = outcome.reason;
      await step.do("fail", DB_STEP, async () => {
        const db = this.db();
        const storage = await loadBackupStorage(db, this.env).catch(() => null);
        await failBackup(db, storage ? storage : null, backupId, reason);
      });
      await step.do("notify-failed", DB_STEP, () =>
        wakeRestoresAwaiting(this.env, this.db(), backupId),
      );
      return { status: "failed" };
    }
    return { status: "succeeded" };
  }

  private db(): Db {
    return createDb(this.env.DB);
  }

  private async pipeline(step: WorkflowStep, backupId: string): Promise<Verdict> {
    const started = await step.do("start", NETWORK_STEP, () => this.start(backupId));
    if (started.kind !== "ok") return started;
    const plan = started.plan;

    const sent = await step.do("send-job", NETWORK_STEP, () => this.sendJob(plan));
    if (sent.kind !== "ok") return sent;

    const deadline = await step.do(
      "deadline",
      async () => Date.now() + (plan.timeoutS + BACKUP_WAIT_GRACE_S) * 1000,
    );
    const answered = await this.waitForAgent(step, plan, deadline);
    if (answered.kind !== "ok") return answered;

    const completed = await step.do("complete", NETWORK_STEP, () => this.complete(plan));
    if (completed.kind !== "ok") return completed;

    await step.do("retention", NETWORK_STEP, () => this.retention(plan));
    await step.do("notify", DB_STEP, () => wakeRestoresAwaiting(this.env, this.db(), backupId));
    return { kind: "ok" };
  }

  /**
   * Alternates a D1 check with a wait for the Durable Object's wake-up until
   * the agent has answered or the deadline passes.
   */
  private async waitForAgent(step: WorkflowStep, plan: Plan, deadline: number): Promise<Verdict> {
    for (let i = 0; i < MAX_WAKEUPS; i++) {
      const verdict = await step.do(`check-${i}`, DB_STEP, () => this.check(plan));
      if (verdict.kind !== "pending") return verdict;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        await step.waitForEvent(`${BACKUP_EVENT}-${i}`, { type: BACKUP_EVENT, timeout: remaining });
      } catch {
        const last = await step.do(`check-final`, DB_STEP, () => this.check(plan));
        if (last.kind !== "pending") return last;
        break;
      }
    }
    return fail(
      `timed_out: the agent didn't finish within ${Math.round(plan.timeoutS / 60)} minutes`,
    );
  }

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  private async start(backupId: string): Promise<Verdict<{ plan: Plan }>> {
    const db = this.db();
    const owned = await backupWithOwners(db, backupId);
    if (!owned) return { kind: "stop" };
    const { backup, service, project } = owned;
    if (backup.status !== "queued" && backup.status !== "running") return { kind: "stop" };
    if (service.deletedAt || project.deletedAt) return fail("service_deleted");
    const storage = await loadBackupStorage(db, this.env);
    if (!storage) return fail("backup_storage_not_configured");

    const found = await findDataTarget(db, backup.serviceId, backup.environmentId, backup.method);
    if (!found.ok) return fail(DATA_TARGET_MESSAGES[found.reason]);
    const target = found.target;

    const [policy] = backup.policyId
      ? await db.select().from(backupPolicies).where(eq(backupPolicies.id, backup.policyId))
      : await db
          .select()
          .from(backupPolicies)
          .where(
            and(
              eq(backupPolicies.serviceId, backup.serviceId),
              eq(backupPolicies.environmentId, backup.environmentId),
            ),
          );
    const isDump = backup.method === "dump";
    const quiesce = !isDump && policy?.quiesce === "stop" && target.workloadId ? "stop" : "none";

    const ageRecipient = await ensureBackupRecipient(db, this.env, backup.projectId);
    const partSizeBytes = backup.partSizeBytes ?? backupPartSize(target.usedBytes);
    const uploadId = backup.uploadId ?? (await createMultipartUpload(storage, backup.objectKey));
    const now = new Date();
    const claimed = await db
      .update(backups)
      .set({
        status: "running",
        nodeId: target.nodeId,
        volumeId: target.volumeId,
        uploadId,
        partSizeBytes,
        startedAt: backup.startedAt ?? now,
        updatedAt: now,
      })
      .where(and(eq(backups.id, backupId), inArray(backups.status, ["queued", "running"])))
      .returning({ id: backups.id });
    if (!claimed.length) return { kind: "stop" };
    return {
      kind: "ok",
      plan: {
        backupId,
        projectId: backup.projectId,
        serviceId: backup.serviceId,
        environmentId: backup.environmentId,
        trigger: backup.trigger,
        nodeId: target.nodeId,
        volumeId: target.volumeId,
        objectKey: backup.objectKey,
        uploadId,
        partSizeBytes,
        method: backup.method,
        engine: backup.engine,
        workloadId: isDump || quiesce === "stop" ? target.workloadId : null,
        quiesce,
        databases: isDump && policy?.databases?.length ? policy.databases : null,
        ageRecipient,
        timeoutS: BACKUP_TIMEOUT_S,
      },
    };
  }

  private async sendJob(plan: Plan): Promise<Verdict> {
    const db = this.db();
    const storage = await loadBackupStorage(db, this.env);
    if (!storage) return fail("backup_storage_not_configured");
    const [node] = await db
      .select({ key: nodes.encryptionPublicKey })
      .from(nodes)
      .where(and(eq(nodes.id, plan.nodeId), isNull(nodes.deletedAt)))
      .limit(1);
    if (!node?.key) return fail(DATA_TARGET_MESSAGES.node_unavailable);
    const sealed = await sealPartUrls(
      storage,
      { id: plan.backupId, objectKey: plan.objectKey, uploadId: plan.uploadId },
      { id: plan.nodeId, publicKey: node.key },
      1,
      FIRST_JOB_PARTS,
    );
    const stub = this.env.NODE_CONNECTION.get(this.env.NODE_CONNECTION.idFromName(plan.nodeId));
    const result = await stub.sendBackupJob({
      type: "backup_job",
      backup_id: plan.backupId,
      method: plan.method,
      ...(plan.engine ? { engine: plan.engine } : {}),
      ...(plan.workloadId ? { workload_id: plan.workloadId } : {}),
      volume_id: plan.volumeId,
      quiesce: plan.quiesce,
      databases: plan.databases,
      age_recipient: plan.ageRecipient,
      part_size_bytes: plan.partSizeBytes,
      parts_sealed: sealed!,
      timeout_s: plan.timeoutS,
    });
    const verdict: Verdict = result.sent
      ? { kind: "ok" }
      : fail(
          result.reason === "not_connected"
            ? "node_offline: the volume's node is not connected"
            : DATA_TARGET_MESSAGES.agent_outdated,
        );
    disposeRpc(result);
    return verdict;
  }

  private async check(plan: Plan): Promise<Verdict | { kind: "pending" }> {
    const [row] = await this.db()
      .select({ status: backups.status, error: backups.error, sha256: backups.sha256 })
      .from(backups)
      .where(eq(backups.id, plan.backupId))
      .limit(1);
    if (row?.status !== "running") return { kind: "stop" };
    if (row.error) return fail(row.error);
    if (row.sha256) return { kind: "ok" };
    return { kind: "pending" };
  }

  private async complete(plan: Plan): Promise<Verdict> {
    const db = this.db();
    const storage = await loadBackupStorage(db, this.env);
    if (!storage) return fail("backup_storage_not_configured");
    const s3 = storage;
    const [row] = await db.select().from(backups).where(eq(backups.id, plan.backupId)).limit(1);
    if (row?.status !== "running") return { kind: "stop" };
    // A retry after a completed upload finds the object already there.
    const existing = await headObject(s3, row.objectKey);
    if (!existing || existing.size !== row.bytesStored) {
      try {
        await completeUpload(db, s3, row);
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
        .where(and(eq(backups.id, plan.backupId), eq(backups.status, "running"))),
      db.delete(backupParts).where(eq(backupParts.backupId, plan.backupId)),
    ]);
    return { kind: "ok" };
  }

  private async retention(plan: Plan): Promise<number> {
    const db = this.db();
    try {
      const storage = await loadBackupStorage(db, this.env);
      if (!storage) return 0;
      return await applyBackupRetention(db, storage, plan.serviceId, plan.environmentId);
    } catch (err) {
      // NOTE: retention also runs hourly; a failure here never fails the backup.
      console.warn("backup retention failed", err instanceof Error ? err.message : "error");
      return 0;
    }
  }
}
