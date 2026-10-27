/**
 * `DrainWorkflow` (ADR 0005, "Node lifecycle"): empties one node so it can
 * be rebooted. One instance per drain, instance ID `drain-<node>-<ts>`; its
 * progress lives in the `node_drains` row the route created.
 *
 * Steps:
 * 1. `plan`: list the node's replicas of settled deployments. Volume
 *    services can't move: without `force` the drain ends `blocked` with
 *    their list; with it their replicas are `parked` (left out of desired
 *    state, so the agent stops them) and their services marked `degraded`
 *    (`node_maintenance`). Stateless replicas are cut into batches of at
 *    most {@link MOVE_BATCH}, never two of one service in a batch, so a
 *    service never loses more than one replica at a time.
 * 2. Per batch: `start-<i>` schedules each replacement elsewhere (the node
 *    excluded, the environment span rule kept) and pushes it; `check-<i>-<j>`
 *    reads their states, woken by the node Durable Object when one turns
 *    healthy (`moved` event), until all settle or the rollout timeout passes;
 *    `finish-<i>` removes each old replica whose replacement is healthy and
 *    gives up on the others (their replacement is removed, the old one keeps
 *    serving here).
 * 3. `finish`: every move done → node `maintenance`, drain `completed`, audit
 *    `node.drained`; otherwise the drain ends `failed` and the node stays
 *    `draining`.
 *
 * A resume (`POST .../resume`) marks the drain `cancelled`; every step reads
 * the row first and stops quietly when it is no longer `running`.
 *
 * @module
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  createDb,
  type Db,
  type NodeDrainMove,
  nodeDrains,
  nodes,
  placements,
} from "@roundhouse/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Env } from "../env";
import { recordAudit } from "../lib/audit";
import { refreshNodes } from "../lib/desired-state";
import { degradeService, placeReplacement, replicasOnNode } from "../lib/moves";
import { drainBlockers } from "../lib/node-lifecycle";
import { rolloutTimeoutMs } from "./deploy";

/** Parameters of one drain. */
export interface DrainParams {
  drainId: string;
}

/** Replicas moved at once (ADR 0005). */
export const MOVE_BATCH = 4;

/** Most wake-ups one batch waits through before giving up on it. */
const MAX_CHECKS = 200;

/** Longest single wait between two looks at a batch. */
const CHECK_INTERVAL_MS = 15_000;

const STEP = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

type DrainRow = typeof nodeDrains.$inferSelect;

/**
 * Cuts moves into batches of at most {@link MOVE_BATCH}, never two moves of
 * one service in a batch, in the order given.
 *
 * @param moves - The stateless moves.
 * @returns Workload IDs per batch.
 */
export function batchMoves(moves: readonly Pick<NodeDrainMove, "workloadId" | "serviceId">[]) {
  const batches: string[][] = [];
  const left = [...moves];
  while (left.length) {
    const batch: string[] = [];
    const services = new Set<string>();
    for (let i = 0; i < left.length && batch.length < MOVE_BATCH; ) {
      const m = left[i]!;
      if (services.has(m.serviceId)) {
        i++;
        continue;
      }
      services.add(m.serviceId);
      batch.push(m.workloadId);
      left.splice(i, 1);
    }
    batches.push(batch);
  }
  return batches;
}

/** Drains one node. */
export class DrainWorkflow extends WorkflowEntrypoint<Env, DrainParams> {
  private db(): Db {
    return createDb(this.env.DB);
  }

  override async run(event: Readonly<WorkflowEvent<DrainParams>>, step: WorkflowStep) {
    const { drainId } = event.payload;
    const plan = await step.do("plan", STEP, () => this.plan(drainId));
    if (plan.kind === "stop") return { status: plan.status };
    for (const [i, batch] of plan.batches.entries()) {
      const started = await step.do(`start-${i}`, STEP, () => this.start(drainId, batch));
      if (!started) return { status: "cancelled" };
      const deadline = await step.do(
        `deadline-${i}`,
        async () => Date.now() + rolloutTimeoutMs(this.env),
      );
      for (let j = 0; j < MAX_CHECKS; j++) {
        const pending = await step.do(`check-${i}-${j}`, STEP, () => this.pending(drainId, batch));
        if (!pending) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        try {
          await step.waitForEvent(`moved-${i}-${j}`, {
            type: "moved",
            timeout: Math.min(remaining, CHECK_INTERVAL_MS),
          });
        } catch {
          // Timed out; the next check looks again.
        }
      }
      const finished = await step.do(`finish-${i}`, STEP, () => this.finishBatch(drainId, batch));
      if (!finished) return { status: "cancelled" };
    }
    const status = await step.do("finish", STEP, () => this.finish(drainId));
    return { status };
  }

  private async load(drainId: string): Promise<DrainRow | null> {
    const [row] = await this.db()
      .select()
      .from(nodeDrains)
      .where(eq(nodeDrains.id, drainId))
      .limit(1);
    return row ?? null;
  }

  private async save(drainId: string, patch: Partial<DrainRow>): Promise<boolean> {
    const [row] = await this.db()
      .update(nodeDrains)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(nodeDrains.id, drainId), eq(nodeDrains.status, "running")))
      .returning({ id: nodeDrains.id });
    return !!row;
  }

  private async plan(
    drainId: string,
  ): Promise<{ kind: "stop"; status: string } | { kind: "ok"; batches: string[][] }> {
    const drain = await this.load(drainId);
    if (drain?.status !== "running") {
      return { kind: "stop", status: drain?.status ?? "cancelled" };
    }
    // A replayed step finds the moves it planned.
    if (drain.moves.length) {
      return { kind: "ok", batches: batchMoves(drain.moves.filter((m) => m.state !== "stopped")) };
    }
    const db = this.db();
    const replicas = await replicasOnNode(db, drain.nodeId);
    const stateful = replicas.filter((r) => r.stateful);
    if (stateful.length && !drain.force) {
      const blocked = drainBlockers(stateful);
      await this.db()
        .update(nodeDrains)
        .set({ status: "blocked", blocked, finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(nodeDrains.id, drainId), eq(nodeDrains.status, "running")));
      return { kind: "stop", status: "blocked" };
    }
    const moves: NodeDrainMove[] = replicas.map((r) => ({
      workloadId: r.placement.workloadId,
      deploymentId: r.placement.deploymentId,
      serviceId: r.serviceId,
      environmentId: r.environmentId,
      replica: r.placement.replica,
      state: r.stateful ? "stopped" : "pending",
      toNodeId: null,
      newWorkloadId: null,
      error: null,
    }));
    for (const r of stateful) {
      await db
        .update(placements)
        .set({ state: "parked", updatedAt: new Date() })
        .where(eq(placements.id, r.placement.id));
      await degradeService(this.env, db, r, "node_maintenance", drain.nodeId);
    }
    if (!(await this.save(drainId, { moves }))) return { kind: "stop", status: "cancelled" };
    if (stateful.length) await refreshNodes(this.env, db, [drain.nodeId]);
    return { kind: "ok", batches: batchMoves(moves.filter((m) => m.state === "pending")) };
  }

  /** Starts the batch's replacements; `false` when the drain stopped. */
  private async start(drainId: string, batch: readonly string[]): Promise<boolean> {
    const drain = await this.load(drainId);
    if (drain?.status !== "running") return false;
    const db = this.db();
    const moves = drain.moves.map((m) => ({ ...m }));
    const targets = new Set<string>();
    for (const m of moves) {
      if (!batch.includes(m.workloadId) || m.state !== "pending") continue;
      const [old] = await db
        .select()
        .from(placements)
        .where(eq(placements.workloadId, m.workloadId))
        .limit(1);
      if (!old) {
        m.state = "done";
        continue;
      }
      const placed = await placeReplacement(db, old, drain.nodeId);
      if (placed.ok) {
        m.state = "moving";
        m.toNodeId = placed.nodeId;
        m.newWorkloadId = placed.workloadId;
        targets.add(placed.nodeId);
      } else {
        m.state = "failed";
        m.error = `No other server can take it: ${placed.reason.replace(/_/g, " ")}`;
      }
    }
    if (!(await this.save(drainId, { moves }))) return false;
    if (targets.size) await refreshNodes(this.env, db, [...targets]);
    return true;
  }

  /** Whether a replacement of the batch hasn't settled yet. */
  private async pending(drainId: string, batch: readonly string[]): Promise<boolean> {
    const drain = await this.load(drainId);
    if (drain?.status !== "running") return false;
    const ids = drain.moves
      .filter((m) => batch.includes(m.workloadId) && m.state === "moving" && m.newWorkloadId)
      .map((m) => m.newWorkloadId!);
    if (!ids.length) return false;
    const rows = await this.db()
      .select({ state: placements.state })
      .from(placements)
      .where(inArray(placements.workloadId, ids));
    return rows.length < ids.length || rows.some((r) => r.state !== "healthy");
  }

  /** Settles the batch's moves; `false` when the drain stopped. */
  private async finishBatch(drainId: string, batch: readonly string[]): Promise<boolean> {
    const drain = await this.load(drainId);
    if (drain?.status !== "running") return false;
    const db = this.db();
    const moves = drain.moves.map((m) => ({ ...m }));
    const touched = new Set<string>([drain.nodeId]);
    for (const m of moves) {
      if (!batch.includes(m.workloadId) || m.state !== "moving" || !m.newWorkloadId) continue;
      const [fresh] = await db
        .select({ state: placements.state, nodeId: placements.nodeId })
        .from(placements)
        .where(eq(placements.workloadId, m.newWorkloadId))
        .limit(1);
      if (fresh?.state === "healthy") {
        await db.delete(placements).where(eq(placements.workloadId, m.workloadId));
        m.state = "done";
      } else {
        // The old replica keeps serving; its stand-in is pulled again.
        await db.delete(placements).where(eq(placements.workloadId, m.newWorkloadId));
        if (fresh) touched.add(fresh.nodeId);
        m.state = "failed";
        m.error = `The replacement did not become healthy (last ${fresh?.state ?? "unknown"})`;
      }
    }
    if (!(await this.save(drainId, { moves }))) return false;
    await refreshNodes(this.env, db, [...touched]);
    return true;
  }

  private async finish(drainId: string): Promise<string> {
    const drain = await this.load(drainId);
    if (drain?.status !== "running") return drain?.status ?? "cancelled";
    const db = this.db();
    const failed = drain.moves.filter((m) => m.state === "failed");
    const now = new Date();
    if (failed.length) {
      await db
        .update(nodeDrains)
        .set({
          status: "failed",
          error: `${failed.length} replica(s) could not be moved; they keep running on this server.`,
          finishedAt: now,
          updatedAt: now,
        })
        .where(and(eq(nodeDrains.id, drainId), eq(nodeDrains.status, "running")));
      return "failed";
    }
    const [done] = await db
      .update(nodeDrains)
      .set({ status: "completed", finishedAt: now, updatedAt: now })
      .where(and(eq(nodeDrains.id, drainId), eq(nodeDrains.status, "running")))
      .returning({ id: nodeDrains.id });
    if (!done) return "cancelled";
    await db
      .update(nodes)
      .set({ status: "maintenance" })
      .where(and(eq(nodes.id, drain.nodeId), eq(nodes.status, "draining")));
    await recordAudit(db, {
      workspaceId: drain.workspaceId,
      actorType: "system",
      actorId: null,
      action: "node.drained",
      targetType: "node",
      targetId: drain.nodeId,
      metadata: {
        drain_id: drain.id,
        moved: drain.moves.filter((m) => m.state === "done").length,
        stopped: drain.moves.filter((m) => m.state === "stopped").length,
      },
    });
    return "completed";
  }
}
