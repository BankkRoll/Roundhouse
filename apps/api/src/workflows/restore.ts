/**
 * One restore as a Cloudflare Workflow (ADR 0004, "Restore"); the instance
 * ID is the `rst_…` restore ID.
 *
 * Steps:
 * 1. `start`: check the backup is restorable, find the target volume, its
 *    node and (for a dump) the running replica, and mark the restore
 *    `running`. A `new_service` restore first waits, polling every
 *    {@link TARGET_POLL}, until the database the route added is deployed
 *    and healthy, for at most {@link NEW_SERVICE_READY_TIMEOUT_MS}; a
 *    failed deployment fails the restore.
 * 2. When the route took a safety backup (`trigger: pre_restore`), wait for
 *    it; its failure fails the restore before anything is touched.
 * 3. `send-job`: presign a one-hour `GET` of the object, unseal the
 *    project's age identity, seal both to the node (`restore` box bound to
 *    node and restore), record the node, and send a signed `restore_job`.
 * 4. Wait for the `restore` event (the agent's `restore_result`, recorded
 *    in D1 by the node's Durable Object) up to `timeout_s` + 5 minutes.
 * 5. `finish`: mark it `succeeded` and audit `restore.succeeded` as the
 *    system. Any failure marks it `failed` and audits `restore.failed`.
 *
 * A dump of a whole Postgres instance or MongoDB deployment carries its
 * principals' passwords; the agent puts the target's own back after
 * restoring it, so a new service keeps the fresh credentials it was created
 * with.
 *
 * SECURITY: the identity and URL exist in plaintext only inside the
 * `send-job` step; no step returns them.
 *
 * @module
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { backups, createDb, type Db, deployments, nodes, restores } from "@roundhouse/db";
import type { DatabaseEngine } from "@roundhouse/protocol";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Env } from "../env";
import { BACKUP_TIMEOUT_S, BACKUP_WAIT_GRACE_S } from "../lib/backups/backups";
import { loadBackupIdentity } from "../lib/backups/keys";
import {
  auditRestore,
  failRestore,
  RESTORE_EVENT,
  SAFETY_BACKUP_EVENT,
  sealRestoreSecrets,
} from "../lib/backups/restores";
import { loadBackupStorage } from "../lib/backups/storage";
import { DATA_TARGET_MESSAGES, findDataTarget } from "../lib/backups/target";
import { disposeRpc } from "../lib/deployments";

/** Parameters of a restore workflow instance. */
export interface RestoreParams {
  restoreId: string;
}

/** How a restore workflow ended. */
export interface RestoreOutput {
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

const MAX_WAKEUPS = 20;

/** How long a `new_service` restore waits for its database to run healthy. */
export const NEW_SERVICE_READY_TIMEOUT_MS = 15 * 60 * 1000;

/** Poll interval while waiting for that database, whose deployment sends no event. */
const TARGET_POLL = "2 seconds";

/** Everything later steps need. Serialisable and secret-free. */
interface Plan {
  restoreId: string;
  backupId: string;
  projectId: string;
  safetyBackupId: string | null;
  nodeId: string;
  volumeId: string;
  objectKey: string;
  sha256: string;
  sizeBytes: number;
  method: "dump" | "snapshot";
  engine: DatabaseEngine | null;
  workloadId: string | null;
  timeoutS: number;
}

type Verdict<T = object> =
  | ({ kind: "ok" } & T)
  | { kind: "stop" }
  | { kind: "fail"; reason: string };
type Check = Verdict | { kind: "pending" };

const fail = (reason: string) => ({ kind: "fail", reason }) as const;

/** Runs one restore. */
export class RestoreWorkflow extends WorkflowEntrypoint<Env, RestoreParams> {
  override async run(
    event: Readonly<WorkflowEvent<RestoreParams>>,
    step: WorkflowStep,
  ): Promise<RestoreOutput> {
    const { restoreId } = event.payload;
    let outcome: Verdict;
    try {
      outcome = await this.pipeline(step, restoreId);
    } catch (err) {
      outcome = fail(err instanceof Error ? err.message : String(err));
    }
    if (outcome.kind === "stop") return { status: "skipped" };
    if (outcome.kind === "fail") {
      const reason = outcome.reason;
      await step.do("fail", DB_STEP, () => failRestore(this.db(), restoreId, reason));
      return { status: "failed" };
    }
    return { status: "succeeded" };
  }

  private db(): Db {
    return createDb(this.env.DB);
  }

  private async pipeline(step: WorkflowStep, restoreId: string): Promise<Verdict> {
    const mode = await step.do("mode", DB_STEP, () => this.modeOf(restoreId));
    if (mode.kind !== "ok") return mode;
    if (mode.mode === "new_service") {
      const readyBy = await step.do(
        "target-deadline",
        async () => Date.now() + NEW_SERVICE_READY_TIMEOUT_MS,
      );
      for (let i = 0; ; i++) {
        const ready = await step.do(`check-target-${i}`, DB_STEP, () =>
          this.checkNewTarget(restoreId),
        );
        if (ready.kind === "ok") break;
        if (ready.kind !== "pending") return ready;
        if (Date.now() > readyBy) {
          return fail("target_not_ready: the new database didn't become healthy in time");
        }
        await step.sleep(`target-wait-${i}`, TARGET_POLL);
      }
    }
    const started = await step.do("start", DB_STEP, () => this.start(restoreId));
    if (started.kind !== "ok") return started;
    const plan = started.plan;
    const deadline = (label: string) =>
      step.do(
        `${label}-deadline`,
        async () => Date.now() + (plan.timeoutS + BACKUP_WAIT_GRACE_S) * 1000,
      );

    if (plan.safetyBackupId) {
      const safetyDeadline = await deadline("safety");
      const safe = await this.waitFor(step, SAFETY_BACKUP_EVENT, safetyDeadline, (i) =>
        step.do(`check-safety-${i}`, DB_STEP, () => this.checkSafety(plan)),
      );
      if (safe.kind !== "ok") return safe;
    }

    const sent = await step.do("send-job", NETWORK_STEP, () => this.sendJob(plan));
    if (sent.kind !== "ok") return sent;

    const restoreDeadline = await deadline("restore");
    const done = await this.waitFor(step, RESTORE_EVENT, restoreDeadline, (i) =>
      step.do(`check-restore-${i}`, DB_STEP, () => this.checkRestore(plan)),
    );
    if (done.kind !== "ok") return done;

    return step.do("finish", DB_STEP, () => this.finish(plan));
  }

  private async waitFor(
    step: WorkflowStep,
    type: string,
    deadline: number,
    check: (i: number) => Promise<Check>,
  ): Promise<Verdict> {
    for (let i = 0; i < MAX_WAKEUPS; i++) {
      const verdict = await check(i);
      if (verdict.kind !== "pending") return verdict;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        await step.waitForEvent(`${type}-${i}`, { type, timeout: remaining });
      } catch {
        const last = await check(MAX_WAKEUPS + i);
        if (last.kind !== "pending") return last;
        break;
      }
    }
    return fail(
      `timed_out: the ${type === RESTORE_EVENT ? "restore" : "safety backup"} didn't finish in time`,
    );
  }

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  private async modeOf(restoreId: string): Promise<Verdict<{ mode: "in_place" | "new_service" }>> {
    const [row] = await this.db()
      .select({ mode: restores.mode, status: restores.status })
      .from(restores)
      .where(eq(restores.id, restoreId))
      .limit(1);
    if (!row || (row.status !== "queued" && row.status !== "running")) return { kind: "stop" };
    return { kind: "ok", mode: row.mode };
  }

  /**
   * Whether the database a `new_service` restore added runs healthy: its
   * latest deployment in the environment is active and its volume is ready
   * on a node.
   */
  private async checkNewTarget(restoreId: string): Promise<Check> {
    const db = this.db();
    const [row] = await db
      .select({ restore: restores, method: backups.method })
      .from(restores)
      .innerJoin(backups, eq(backups.id, restores.backupId))
      .where(eq(restores.id, restoreId))
      .limit(1);
    if (!row) return { kind: "stop" };
    const { restore } = row;
    if (restore.status !== "queued" && restore.status !== "running") return { kind: "stop" };
    if (!restore.targetServiceId || !restore.targetEnvironmentId) {
      return fail("target_missing: the new service is gone");
    }
    const [deployment] = await db
      .select({ status: deployments.status, failure: deployments.failureReason })
      .from(deployments)
      .where(
        and(
          eq(deployments.serviceId, restore.targetServiceId),
          eq(deployments.environmentId, restore.targetEnvironmentId),
        ),
      )
      .orderBy(desc(deployments.id))
      .limit(1);
    if (!deployment) return fail("target_not_deployed: the new database has no deployment");
    if (["failed", "cancelled", "crashed"].includes(deployment.status)) {
      return fail(
        `target_failed: the new database's deployment is ${deployment.status}${deployment.failure ? `: ${deployment.failure}` : ""}`,
      );
    }
    if (deployment.status !== "active") return { kind: "pending" };
    const found = await findDataTarget(
      db,
      restore.targetServiceId,
      restore.targetEnvironmentId,
      row.method,
    );
    return found.ok ? { kind: "ok" } : { kind: "pending" };
  }

  private async start(restoreId: string): Promise<Verdict<{ plan: Plan }>> {
    const db = this.db();
    const [row] = await db
      .select({ restore: restores, backup: backups })
      .from(restores)
      .innerJoin(backups, eq(backups.id, restores.backupId))
      .where(eq(restores.id, restoreId))
      .limit(1);
    if (!row) return { kind: "stop" };
    const { restore, backup } = row;
    if (restore.status !== "queued" && restore.status !== "running") return { kind: "stop" };
    if (backup.status !== "succeeded" || !backup.sha256 || !backup.bytesStored) {
      return fail("backup_not_restorable: the backup hasn't succeeded");
    }
    if (!restore.targetServiceId || !restore.targetEnvironmentId) {
      return fail("target_missing: the target service is gone");
    }
    const found = await findDataTarget(
      db,
      restore.targetServiceId,
      restore.targetEnvironmentId,
      backup.method,
    );
    if (!found.ok) return fail(DATA_TARGET_MESSAGES[found.reason]);
    const now = new Date();
    const claimed = await db
      .update(restores)
      .set({ status: "running", startedAt: restore.startedAt ?? now, updatedAt: now })
      .where(and(eq(restores.id, restoreId), inArray(restores.status, ["queued", "running"])))
      .returning({ id: restores.id });
    if (!claimed.length) return { kind: "stop" };
    return {
      kind: "ok",
      plan: {
        restoreId,
        backupId: backup.id,
        projectId: backup.projectId,
        safetyBackupId: restore.safetyBackupId,
        nodeId: found.target.nodeId,
        volumeId: found.target.volumeId,
        objectKey: backup.objectKey,
        sha256: backup.sha256,
        sizeBytes: backup.bytesStored,
        method: backup.method,
        engine: backup.engine,
        workloadId: found.target.workloadId,
        timeoutS: BACKUP_TIMEOUT_S,
      },
    };
  }

  private async checkSafety(plan: Plan): Promise<Check> {
    const [row] = await this.db()
      .select({ status: backups.status, error: backups.error })
      .from(backups)
      .where(eq(backups.id, plan.safetyBackupId!))
      .limit(1);
    if (!row) return fail("safety_backup_failed: the safety backup is gone");
    if (row.status === "succeeded") return { kind: "ok" };
    if (row.status === "failed" || row.status === "deleted") {
      return fail(`safety_backup_failed: ${row.error ?? "the safety backup failed"}`);
    }
    return { kind: "pending" };
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
    const identity = await loadBackupIdentity(db, this.env, plan.projectId);
    if (!identity) return fail("backup_key_missing: the project has no backup key");
    const sealed = await sealRestoreSecrets(
      storage,
      plan.objectKey,
      identity,
      { id: plan.nodeId, publicKey: node.key },
      plan.restoreId,
    );
    // Recorded before sending, so the node's answer is accepted however fast it comes.
    await db
      .update(restores)
      .set({ nodeId: plan.nodeId, updatedAt: new Date() })
      .where(and(eq(restores.id, plan.restoreId), eq(restores.status, "running")));
    const stub = this.env.NODE_CONNECTION.get(this.env.NODE_CONNECTION.idFromName(plan.nodeId));
    const result = await stub.sendBackupJob({
      type: "restore_job",
      restore_id: plan.restoreId,
      backup_id: plan.backupId,
      method: plan.method,
      ...(plan.engine ? { engine: plan.engine } : {}),
      ...(plan.workloadId ? { workload_id: plan.workloadId } : {}),
      volume_id: plan.volumeId,
      sha256: plan.sha256,
      size_bytes: plan.sizeBytes,
      secrets_sealed: sealed,
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

  private async checkRestore(plan: Plan): Promise<Check> {
    const [row] = await this.db()
      .select({ status: restores.status, error: restores.error, finishedAt: restores.finishedAt })
      .from(restores)
      .where(eq(restores.id, plan.restoreId))
      .limit(1);
    if (row?.status !== "running") return { kind: "stop" };
    if (!row.finishedAt) return { kind: "pending" };
    return row.error ? fail(row.error) : { kind: "ok" };
  }

  private async finish(plan: Plan): Promise<Verdict> {
    const db = this.db();
    const now = new Date();
    const [row] = await db
      .update(restores)
      .set({ status: "succeeded", finishedAt: now, updatedAt: now })
      .where(and(eq(restores.id, plan.restoreId), eq(restores.status, "running")))
      .returning();
    if (row) await auditRestore(db, row, "restore.succeeded");
    return { kind: "ok" };
  }
}
