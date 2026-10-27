/**
 * Draining and resuming a server (ADR 0005, "Node lifecycle"), shared by
 * the REST routes (`routes/mesh.ts`) and the MCP tools (`mcp/node-tools.ts`)
 * so both refuse, write and audit exactly the same way. The caller checks
 * access first (`nodes:manage` through `requireWorkspace`); these functions
 * take the workspace from that check, so a server of another workspace is a
 * 404 like a missing one.
 *
 * - {@link startDrain}: marks the server `draining` and starts
 *   `DrainWorkflow`; audited as `node.drain_started`.
 * - {@link resumeDrainedNode}: back to `online`, a running drain cancelled,
 *   parked volume services restarted; audited as `node.resumed`.
 * - {@link drainBlockers}: the volume services that stop a drain without
 *   `force`, as the workflow's plan step finds them.
 *
 * @module
 */
import { type Db, nodeDrains, nodes, placements } from "@roundhouse/db";
import { newId } from "@roundhouse/shared";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Env } from "../env";
import { type AuditEntry, recordAudit } from "./audit";
import { disposeRpc } from "./deployments";
import { refreshNodes } from "./desired-state";
import { ApiError, notFound } from "./errors";
import { type MovableReplica, recoverNodeServices, replicasOnNode } from "./moves";

type NodeRow = typeof nodes.$inferSelect;
type DrainRow = typeof nodeDrains.$inferSelect;

/** What the lifecycle functions need from the request. */
export interface LifecycleDeps {
  db: Db;
  env: Pick<Env, "DRAIN_WORKFLOW" | "NODE_CONNECTION" | "PROJECT_ROOM">;
}

/** Who acts, for the audit entry. */
export interface LifecycleActor {
  actor: Pick<AuditEntry, "actorType" | "actorId">;
  ip: string | null;
  /** Merged into the audit metadata, e.g. `via: "mcp"` and the tool name. */
  metadata?: Record<string, unknown>;
}

/** A volume service that keeps a drain from finishing. */
export interface DrainBlocker {
  serviceId: string;
  environmentId: string;
  serviceName: string;
}

/**
 * A `node_drains` row on the wire (`NodeDrain`).
 *
 * @param d - The row.
 * @returns Its wire shape.
 */
export function toApiDrain(d: DrainRow) {
  return {
    id: d.id,
    node_id: d.nodeId,
    status: d.status,
    force: d.force,
    moves: d.moves.map((m) => ({
      workload_id: m.workloadId,
      deployment_id: m.deploymentId,
      service_id: m.serviceId,
      environment_id: m.environmentId,
      replica: m.replica,
      state: m.state,
      to_node_id: m.toNodeId,
      new_workload_id: m.newWorkloadId,
      error: m.error,
    })),
    blocked: d.blocked.map(toApiBlocker),
    error: d.error,
    started_by: d.startedBy,
    started_at: +d.createdAt,
    finished_at: d.finishedAt ? +d.finishedAt : null,
  };
}

/**
 * A {@link DrainBlocker} on the wire.
 *
 * @param b - The blocker.
 * @returns Its wire shape.
 */
export function toApiBlocker(b: DrainBlocker) {
  return {
    service_id: b.serviceId,
    environment_id: b.environmentId,
    service_name: b.serviceName,
  };
}

/**
 * The volume services among a server's replicas, one per service and
 * environment, in the order found.
 *
 * @param replicas - From `replicasOnNode`.
 * @returns What blocks a drain without `force`.
 */
export function drainBlockers(replicas: readonly MovableReplica[]): DrainBlocker[] {
  const out = new Map<string, DrainBlocker>();
  for (const r of replicas) {
    if (!r.stateful) continue;
    out.set(`${r.serviceId}:${r.environmentId}`, {
      serviceId: r.serviceId,
      environmentId: r.environmentId,
      serviceName: r.serviceName,
    });
  }
  return [...out.values()];
}

/**
 * Reads what blocks draining a server right now.
 *
 * @param db - Database client.
 * @param nodeId - The server.
 * @returns Its volume services.
 */
export async function currentDrainBlockers(db: Db, nodeId: string): Promise<DrainBlocker[]> {
  return drainBlockers(await replicasOnNode(db, nodeId));
}

const liveNode = (workspaceId: string, nodeId: string) =>
  and(eq(nodes.id, nodeId), eq(nodes.workspaceId, workspaceId), isNull(nodes.deletedAt));

/**
 * Loads a live server of a workspace.
 *
 * @param db - Database client.
 * @param workspaceId - The workspace the caller was checked against.
 * @param nodeId - The server.
 * @returns Its row.
 * @throws {ApiError} 404 when it is missing, deleted or in another workspace.
 */
export async function loadWorkspaceNode(
  db: Db,
  workspaceId: string,
  nodeId: string,
): Promise<NodeRow> {
  const [node] = await db.select().from(nodes).where(liveNode(workspaceId, nodeId));
  if (!node) throw notFound("Server");
  return node;
}

/**
 * The server's latest drain, if it was ever drained.
 *
 * @param db - Database client.
 * @param nodeId - The server.
 * @returns The newest `node_drains` row, or `null`.
 */
export async function latestDrain(db: Db, nodeId: string): Promise<DrainRow | null> {
  const [drain] = await db
    .select()
    .from(nodeDrains)
    .where(eq(nodeDrains.nodeId, nodeId))
    .orderBy(desc(nodeDrains.id))
    .limit(1);
  return drain ?? null;
}

/**
 * Starts draining a server.
 *
 * @param deps - Database and bindings.
 * @param input - The workspace, server, `force`, and the user who starts it.
 * @param by - Audit actor, IP and extra metadata.
 * @returns The server as it was before, and the new drain (`running`).
 * @throws {ApiError} 404 for an unknown server; 409 `node_not_drainable`
 *   (still pending) or `drain_in_progress`.
 */
export async function startDrain(
  { db, env }: LifecycleDeps,
  input: { workspaceId: string; nodeId: string; force: boolean; startedBy: string },
  by: LifecycleActor,
): Promise<{ node: NodeRow; drain: DrainRow }> {
  const { workspaceId, nodeId, force } = input;
  const node = await loadWorkspaceNode(db, workspaceId, nodeId);
  if (node.status === "pending") {
    throw new ApiError(409, "node_not_drainable", "This server hasn't connected yet.");
  }
  const [running] = await db
    .select({ id: nodeDrains.id })
    .from(nodeDrains)
    .where(and(eq(nodeDrains.nodeId, nodeId), eq(nodeDrains.status, "running")))
    .limit(1);
  if (running) {
    throw new ApiError(409, "drain_in_progress", "This server is already being drained.");
  }
  const id = newId("nodeDrain");
  const instanceId = `drain-${nodeId}-${Date.now()}`;
  // Draining first, so the scheduler stops placing here before anything moves.
  const [, [row]] = await db.batch([
    db.update(nodes).set({ status: "draining" }).where(liveNode(workspaceId, nodeId)),
    db
      .insert(nodeDrains)
      .values({
        id,
        workspaceId,
        nodeId,
        force,
        workflowInstanceId: instanceId,
        startedBy: input.startedBy,
      })
      .returning(),
  ]);
  try {
    disposeRpc(await env.DRAIN_WORKFLOW.create({ id: instanceId, params: { drainId: id } }));
  } catch (err) {
    await db
      .update(nodeDrains)
      .set({ status: "failed", error: "Could not start the drain", finishedAt: new Date() })
      .where(eq(nodeDrains.id, id));
    throw err;
  }
  await recordAudit(db, {
    workspaceId,
    ...by.actor,
    action: "node.drain_started",
    targetType: "node",
    targetId: nodeId,
    metadata: { name: node.name, drain_id: id, force, ...by.metadata },
    ip: by.ip,
  });
  return { node, drain: row! };
}

/**
 * Takes a `draining` or `maintenance` server back into service.
 *
 * @param deps - Database and bindings.
 * @param input - The workspace and server.
 * @param by - Audit actor, IP and extra metadata.
 * @returns The server as it now is, and how many parked replicas restart.
 * @throws {ApiError} 404 for an unknown server; 409 `node_not_draining`.
 */
export async function resumeDrainedNode(
  { db, env }: LifecycleDeps,
  input: { workspaceId: string; nodeId: string },
  by: LifecycleActor,
): Promise<{ node: NodeRow; restarted: number }> {
  const { workspaceId, nodeId } = input;
  const [resumed] = await db
    .update(nodes)
    .set({ status: "online" })
    .where(and(liveNode(workspaceId, nodeId), inArray(nodes.status, ["draining", "maintenance"])))
    .returning();
  if (!resumed) {
    await loadWorkspaceNode(db, workspaceId, nodeId);
    throw new ApiError(409, "node_not_draining", "This server isn't draining or in maintenance.");
  }
  const now = new Date();
  await db
    .update(nodeDrains)
    .set({ status: "cancelled", finishedAt: now, updatedAt: now })
    .where(and(eq(nodeDrains.nodeId, nodeId), eq(nodeDrains.status, "running")));
  // Volume services a forced drain stopped start again where their data is.
  const unparked = await db
    .update(placements)
    .set({ state: "pending", lastStatusAt: null, updatedAt: now })
    .where(and(eq(placements.nodeId, nodeId), eq(placements.state, "parked")))
    .returning({ id: placements.id });
  await recoverNodeServices(env, db, nodeId, ["node_maintenance"]);
  await refreshNodes(env, db, [nodeId]);
  await recordAudit(db, {
    workspaceId,
    ...by.actor,
    action: "node.resumed",
    targetType: "node",
    targetId: nodeId,
    metadata: { name: resumed.name, restarted: unparked.length, ...by.metadata },
    ip: by.ip,
  });
  return { node: resumed, restarted: unparked.length };
}
