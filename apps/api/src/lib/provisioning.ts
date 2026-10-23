/**
 * One-click provisioning around `@roundhouse/providers`:
 *
 * - {@link toApiProvision}: the `NodeProvision` wire shape.
 * - {@link attachJoinedNode}: once the server's agent has used its join
 *   token, marks the node as provider-managed and the run as joined. Called
 *   by the workflow while it waits and by reads, so the join route (which
 *   knows nothing about providers) needs no hook.
 * - {@link deprovisionNodeServer}: deletes a managed node's cloud server.
 * - {@link reconcileProviders}: the hourly pass that retries failed
 *   cleanups and flags managed servers deleted behind Roundhouse's back.
 *
 * @module
 */
import {
  type Db,
  nodeJoinTokens,
  nodeProvisions,
  nodes,
  providerCredentials,
} from "@roundhouse/db";
import {
  isNotFound,
  isProviderId,
  PROVIDERS,
  type ProviderId,
  ProvisionError,
} from "@roundhouse/providers";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { auditInsert, recordAudit } from "./audit";
import {
  connectedProvider,
  providerClient,
  providerFailure,
  unsealProviderToken,
} from "./cloud-providers";
import { ApiError } from "./errors";
import type { KeyEnv } from "./instance-secrets";

type ProvisionRow = typeof nodeProvisions.$inferSelect;
type NodeRow = typeof nodes.$inferSelect;

/** Statuses of a run that has not settled yet. */
export const ACTIVE_PROVISION_STATUSES = ["queued", "creating", "booting"] as const;

/**
 * Serialises a provisioning run.
 *
 * @param row - Stored row.
 * @returns The wire shape (`NodeProvision`).
 */
export function toApiProvision(row: ProvisionRow) {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    plan: row.plan,
    region: row.region,
    builder: row.builder,
    status: row.status,
    step: row.step,
    failure_reason: row.failureReason,
    failure_message: row.failureMessage,
    server_id: row.serverId,
    ipv4: row.ipv4,
    ipv6: row.ipv6,
    node_id: row.nodeId,
    created_at: +row.createdAt,
    updated_at: +row.updatedAt,
    finished_at: row.finishedAt ? +row.finishedAt : null,
  };
}

/**
 * If the run's server has joined, records the node as provider-managed and
 * the run as `joined`. Only a `booting` run (server ID known) is attached,
 * and the status change is a compare-and-swap, so concurrent callers audit
 * once.
 *
 * @param db - Database.
 * @param provisionId - The run.
 * @returns The run after the check, or `undefined` when it doesn't exist.
 */
export async function attachJoinedNode(
  db: Db,
  provisionId: string,
): Promise<ProvisionRow | undefined> {
  const [row] = await db.select().from(nodeProvisions).where(eq(nodeProvisions.id, provisionId));
  if (row?.status !== "booting" || !row.joinTokenId || !row.serverId) return row;
  const [token] = await db
    .select({ nodeId: nodeJoinTokens.nodeId })
    .from(nodeJoinTokens)
    .where(eq(nodeJoinTokens.id, row.joinTokenId));
  if (!token?.nodeId) return row;
  const now = new Date();
  const [joined] = await db
    .update(nodeProvisions)
    .set({ status: "joined", step: "done", nodeId: token.nodeId, finishedAt: now })
    .where(and(eq(nodeProvisions.id, row.id), eq(nodeProvisions.status, "booting")))
    .returning();
  if (!joined) {
    const [current] = await db.select().from(nodeProvisions).where(eq(nodeProvisions.id, row.id));
    return current;
  }
  await db.batch([
    db
      .update(nodes)
      .set({
        provider: row.provider,
        providerServerId: row.serverId,
        region: row.region,
      })
      .where(and(eq(nodes.id, token.nodeId), eq(nodes.workspaceId, row.workspaceId))),
    auditInsert(db, {
      workspaceId: row.workspaceId,
      actorType: "system",
      actorId: null,
      action: "node.provisioned",
      targetType: "node",
      targetId: token.nodeId,
      metadata: {
        provision_id: row.id,
        provider: row.provider,
        server_id: row.serverId,
        plan: row.plan,
        region: row.region,
      },
    }),
  ]);
  return joined;
}

/**
 * The node name the server carries in its `roundhouse.node` label: the
 * provisioning run's name, which the agent also joined with.
 *
 * @param db - Database.
 * @param node - The node.
 * @returns The expected label value.
 */
async function expectedServerName(db: Db, node: NodeRow): Promise<string> {
  const [run] = await db
    .select({ name: nodeProvisions.name })
    .from(nodeProvisions)
    .where(eq(nodeProvisions.nodeId, node.id))
    .limit(1);
  return run?.name ?? node.name;
}

/** Result of {@link deprovisionNodeServer}. */
export interface NodeDeprovision {
  provider: ProviderId;
  serverId: string;
  /** `false` when the server was already gone. */
  deleted: boolean;
}

/**
 * Deletes the cloud server behind a provider-managed node. The adapter
 * refuses servers without the managed marker or with another node label.
 *
 * @param db - Database.
 * @param keys - The keyring bindings.
 * @param node - The node; nothing happens for hand-joined nodes.
 * @returns What was deleted, or `null` when the node has no managed server.
 * @throws {ApiError} 409 `provider_not_connected` / `conflict`, or a mapped provider error.
 */
export async function deprovisionNodeServer(
  db: Db,
  keys: KeyEnv,
  node: NodeRow,
): Promise<NodeDeprovision | null> {
  if (!node.providerServerId || !isProviderId(node.provider)) return null;
  const provider = node.provider;
  const { client } = await connectedProvider(db, keys, node.workspaceId, provider);
  try {
    const result = await client.deprovision(
      {
        serverId: node.providerServerId,
        expectedName: await expectedServerName(db, node),
        wait: false,
      },
      { timeoutMs: 20_000 },
    );
    return { provider, serverId: node.providerServerId, deleted: result.deleted };
  } catch (err) {
    if (err instanceof ProvisionError && err.reason === "not_managed") {
      throw new ApiError(
        409,
        "conflict",
        `${PROVIDERS[provider].displayName} server ${node.providerServerId} is not this node's managed server; remove the node with keep_server=true and delete the server yourself`,
      );
    }
    throw providerFailure(provider, err);
  }
}

// -----------------------------------------------------------------------------
// Reconcile
// -----------------------------------------------------------------------------

/** What one {@link reconcileProviders} pass did. */
export interface ReconcileReport {
  /** Failed cleanups whose server is now deleted. */
  cleanedUp: number;
  /** Managed nodes newly flagged as missing at the provider. */
  missing: number;
  /** Credentials the pass could not use (rejected token, API down). */
  errors: number;
}

/**
 * Retries the delete of servers a failed run left behind (`cleanup_failed`),
 * then compares each workspace's managed servers with its nodes and flags
 * nodes whose server is gone (or clears the flag when it is back). One
 * listing per credential, so the cost is bounded by connected providers.
 *
 * @param db - Database.
 * @param keys - The keyring bindings.
 * @param now - Current time.
 * @returns Counts, for the cron log.
 */
export async function reconcileProviders(
  db: Db,
  keys: KeyEnv,
  now = new Date(),
): Promise<ReconcileReport> {
  const report: ReconcileReport = { cleanedUp: 0, missing: 0, errors: 0 };
  const credentials = await db.select().from(providerCredentials);
  const byWorkspace = new Map(credentials.map((c) => [`${c.workspaceId}:${c.provider}`, c]));

  const leftovers = await db
    .select()
    .from(nodeProvisions)
    .where(and(eq(nodeProvisions.status, "cleanup_failed"), isNotNull(nodeProvisions.serverId)));
  for (const run of leftovers) {
    const cred = byWorkspace.get(`${run.workspaceId}:${run.provider}`);
    if (!cred) continue;
    try {
      const client = providerClient(run.provider, await unsealProviderToken(keys, cred));
      await client.deprovision({ serverId: run.serverId!, expectedName: run.name, wait: false });
      await markCleanedUp(db, run);
      report.cleanedUp++;
    } catch (err) {
      if (isNotFound(err)) {
        await markCleanedUp(db, run);
        report.cleanedUp++;
      } else {
        report.errors++;
        logFailure("cleanup", run.provider, err);
      }
    }
  }

  for (const cred of credentials) {
    const managedNodes = await db
      .select({
        id: nodes.id,
        serverId: nodes.providerServerId,
        missingAt: nodes.providerServerMissingAt,
      })
      .from(nodes)
      .where(
        and(
          eq(nodes.workspaceId, cred.workspaceId),
          eq(nodes.provider, cred.provider),
          isNotNull(nodes.providerServerId),
          isNull(nodes.deletedAt),
        ),
      );
    if (managedNodes.length === 0) continue;
    let present: Set<string>;
    try {
      const client = providerClient(cred.provider, await unsealProviderToken(keys, cred));
      const servers = await client.listManaged({ workspaceId: cred.workspaceId });
      present = new Set(servers.map((s) => s.id));
    } catch (err) {
      report.errors++;
      logFailure("list", cred.provider, err);
      continue;
    }
    const gone = managedNodes.filter((n) => !present.has(n.serverId!) && !n.missingAt);
    const back = managedNodes.filter((n) => present.has(n.serverId!) && n.missingAt);
    if (gone.length) {
      await db
        .update(nodes)
        .set({ providerServerMissingAt: now })
        .where(
          inArray(
            nodes.id,
            gone.map((n) => n.id),
          ),
        );
      report.missing += gone.length;
    }
    if (back.length) {
      await db
        .update(nodes)
        .set({ providerServerMissingAt: null })
        .where(
          inArray(
            nodes.id,
            back.map((n) => n.id),
          ),
        );
    }
  }
  return report;
}

async function markCleanedUp(db: Db, run: ProvisionRow): Promise<void> {
  await db
    .update(nodeProvisions)
    .set({ status: "failed" })
    .where(and(eq(nodeProvisions.id, run.id), eq(nodeProvisions.status, "cleanup_failed")));
  await recordAudit(db, {
    workspaceId: run.workspaceId,
    actorType: "system",
    actorId: null,
    action: "node.deprovisioned",
    targetType: "node_provision",
    targetId: run.id,
    metadata: { provider: run.provider, server_id: run.serverId, reason: "cleanup_retry" },
  });
}

// SECURITY: Only the provider and error class are logged; provider error
// messages can echo request details, never worth the risk in Workers logs.
function logFailure(what: string, provider: string, err: unknown): void {
  const kind = err instanceof Error ? err.name : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  console.warn("provider reconcile", what, provider, kind, typeof code === "string" ? code : "");
}
