/**
 * One-click provisioning around `@roundhouse/providers`:
 *
 * - {@link toApiProvision}: the `NodeProvision` wire shape.
 * - {@link attachJoinedNode}: once the server's agent has used its join
 *   token, marks the node as provider-managed and the run as joined. Called
 *   by the workflow while it waits and by reads, so the join route (which
 *   knows nothing about providers) needs no hook.
 * - {@link deprovisionNodeServer}: deletes a managed node's cloud server.
 * - {@link finishCancel}: ends a cancelled run, deleting any server it made.
 * - {@link nodeCostEstimates}: the catalogue price recorded for each
 *   provider-managed node, for display as an estimate.
 * - {@link reconcileProviders}: the hourly pass that retries failed
 *   cleanups, finishes cancels whose run stopped answering, and flags
 *   managed servers deleted behind Roundhouse's back.
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
  errorMessage,
  isNotFound,
  isProviderId,
  PROVIDERS,
  type Provider,
  type ProviderId,
  ProvisionError,
} from "@roundhouse/providers";
import { and, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { auditInsert, recordAudit } from "./audit";
import {
  connectedProvider,
  loadCredential,
  providerClient,
  providerFailure,
  unsealProviderToken,
} from "./cloud-providers";
import { ApiError } from "./errors";
import type { KeyEnv } from "./instance-secrets";
import { revokeJoinToken } from "./join-tokens";

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
    cancel_requested_at: row.cancelRequestedAt ? +row.cancelRequestedAt : null,
    estimated_monthly_cost: costOf(row),
    created_at: +row.createdAt,
    updated_at: +row.updatedAt,
    finished_at: row.finishedAt ? +row.finishedAt : null,
  };
}

/** A recorded catalogue price; see `CostEstimate` in the API schemas. */
export interface CostEstimate {
  monthly_cents: number;
  currency: string;
}

function costOf(row: Pick<ProvisionRow, "monthlyCents" | "currency">): CostEstimate | null {
  return row.monthlyCents !== null && row.currency
    ? { monthly_cents: row.monthlyCents, currency: row.currency }
    : null;
}

/**
 * The monthly price recorded for each provider-managed node in a workspace,
 * from the run that created it. One query per workspace, so lists stay
 * cheap whatever their size.
 *
 * @param db - Database.
 * @param workspaceId - Workspace.
 * @returns Estimates by node ID; nodes without one are absent.
 */
export async function nodeCostEstimates(
  db: Db,
  workspaceId: string,
): Promise<Map<string, CostEstimate>> {
  const rows = await db
    .select({
      nodeId: nodeProvisions.nodeId,
      monthlyCents: nodeProvisions.monthlyCents,
      currency: nodeProvisions.currency,
    })
    .from(nodeProvisions)
    .where(
      and(
        eq(nodeProvisions.workspaceId, workspaceId),
        eq(nodeProvisions.status, "joined"),
        isNotNull(nodeProvisions.nodeId),
        isNotNull(nodeProvisions.monthlyCents),
      ),
    );
  const out = new Map<string, CostEstimate>();
  for (const r of rows) {
    const cost = costOf(r);
    if (r.nodeId && cost) out.set(r.nodeId, cost);
  }
  return out;
}

/**
 * Adds `estimated_monthly_cost` to serialised nodes. Only provider-managed
 * nodes get one: a node removed from its provider (`keep_server`) or joined
 * by hand bills nothing Roundhouse knows about.
 *
 * @param nodes - Serialised nodes (`toApiNode`).
 * @param costs - From {@link nodeCostEstimates}.
 * @returns The nodes with the field set (`null` when unknown).
 */
export function withCostEstimates<N extends { id: string; provider_server_id: string | null }>(
  nodes: N[],
  costs: Map<string, CostEstimate>,
): (N & { estimated_monthly_cost: CostEstimate | null })[] {
  return nodes.map((n) => ({
    ...n,
    estimated_monthly_cost: n.provider_server_id ? (costs.get(n.id) ?? null) : null,
  }));
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
// Prices
// -----------------------------------------------------------------------------

/**
 * Records the run's plan price from the provider's live catalogue, for the
 * cost estimate shown on the node. Best effort: a failure leaves the estimate
 * unknown and never affects the run.
 *
 * @param db - Database.
 * @param client - Provider client for the run's workspace.
 * @param run - The run.
 * @returns Whether a price was recorded.
 */
export async function recordOfferPrice(
  db: Db,
  client: Provider,
  run: Pick<ProvisionRow, "id" | "plan" | "region" | "builder">,
): Promise<boolean> {
  try {
    const offers = await client.listOffers(
      { role: run.builder ? "builder" : "node", region: run.region, includeDeprecated: true },
      { timeoutMs: 20_000 },
    );
    const offer = offers.find((o) => o.plan === run.plan && o.region === run.region);
    if (!offer) return false;
    await db
      .update(nodeProvisions)
      .set({ monthlyCents: offer.price.monthlyCents, currency: offer.price.currency })
      .where(eq(nodeProvisions.id, run.id));
    return true;
  } catch (err) {
    logFailure("price", client.id, err);
    return false;
  }
}

// -----------------------------------------------------------------------------
// Cancel
// -----------------------------------------------------------------------------

/**
 * How long a requested cancel may wait for its run before the reconcile
 * finishes it. Longer than the workflow's create step can run with all its
 * retries (about 40 minutes), so a slow but live run finishes its own cancel.
 */
export const STALE_CANCEL_MS = 60 * 60 * 1000;

/** Options for {@link finishCancel}. */
export interface FinishCancelOptions {
  /** A server the caller knows the run created, when the row doesn't record it yet. */
  serverId?: string | null;
  /**
   * Look the server up by its managed labels when no ID is known: for runs
   * that may have created one without recording it (a create step that was
   * cut off).
   */
  lookup?: boolean;
}

/**
 * Ends a run whose cancel was requested: claims it as `cancelled`, revokes
 * its join token, and deletes its server (only one carrying this run's
 * managed node label). The run ends `cleanup_failed`, which the hourly
 * reconcile retries, when the delete fails.
 *
 * Every writer of a run compares its status first, so this and the workflow
 * can race safely: whichever claims the run first finishes it.
 *
 * @param db - Database.
 * @param keys - The keyring bindings.
 * @param provisionId - The run; it must have `cancel_requested_at` set.
 * @param options - A known server, or permission to look one up.
 * @returns The run afterwards, or `undefined` when it doesn't exist.
 */
export async function finishCancel(
  db: Db,
  keys: KeyEnv,
  provisionId: string,
  options: FinishCancelOptions = {},
): Promise<ProvisionRow | undefined> {
  const [claimed] = await db
    .update(nodeProvisions)
    .set({
      status: "cancelled",
      failureReason: "cancelled",
      failureMessage: "Cancelled before the server joined",
      ...(options.serverId ? { serverId: options.serverId } : {}),
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(nodeProvisions.id, provisionId),
        inArray(nodeProvisions.status, [...ACTIVE_PROVISION_STATUSES]),
        isNotNull(nodeProvisions.cancelRequestedAt),
      ),
    )
    .returning();
  if (!claimed) {
    const [current] = await db
      .select()
      .from(nodeProvisions)
      .where(eq(nodeProvisions.id, provisionId));
    return current;
  }
  if (claimed.joinTokenId) await revokeJoinToken(db, claimed.joinTokenId);

  const name = PROVIDERS[claimed.provider].displayName;
  const cred = await loadCredential(db, claimed.workspaceId, claimed.provider);
  let serverId = claimed.serverId;
  if (!serverId && !options.lookup) return claimed;
  if (!cred) {
    const what = serverId ? `server ${serverId}` : `a server named ${claimed.name}`;
    return cleanupFailed(
      db,
      claimed,
      serverId,
      `${name} was disconnected, so ${what} could not be deleted; check the ${name} console`,
    );
  }
  try {
    const client = providerClient(claimed.provider, await unsealProviderToken(keys, cred));
    if (!serverId) {
      const servers = await client.listManaged(
        { workspaceId: claimed.workspaceId },
        { timeoutMs: 20_000 },
      );
      serverId =
        servers.find(
          (s) => s.managed?.node === claimed.name && s.managed.workspaceId === claimed.workspaceId,
        )?.id ?? null;
      if (!serverId) return claimed;
    }
    await client.deprovision(
      { serverId, expectedName: claimed.name, wait: false },
      { timeoutMs: 20_000 },
    );
  } catch (err) {
    if (serverId && isNotFound(err)) return recordServer(db, claimed, serverId);
    const message = serverId
      ? `Deleting server ${serverId} failed: ${errorMessage(err)}`
      : `Could not check ${name} for a server to delete: ${errorMessage(err)}`;
    // NOTE: Without an ID there is nothing the reconcile can retry; the
    // message tells the operator to check the provider console.
    return cleanupFailed(db, claimed, serverId, message);
  }
  return recordServer(db, claimed, serverId);
}

async function recordServer(db: Db, run: ProvisionRow, serverId: string): Promise<ProvisionRow> {
  if (run.serverId === serverId) return run;
  const [row] = await db
    .update(nodeProvisions)
    .set({ serverId })
    .where(eq(nodeProvisions.id, run.id))
    .returning();
  return row ?? run;
}

async function cleanupFailed(
  db: Db,
  run: ProvisionRow,
  serverId: string | null,
  message: string,
): Promise<ProvisionRow> {
  const [row] = await db
    .update(nodeProvisions)
    .set({
      status: "cleanup_failed",
      failureMessage: message.slice(0, 500),
      ...(serverId ? { serverId } : {}),
    })
    .where(and(eq(nodeProvisions.id, run.id), eq(nodeProvisions.status, "cancelled")))
    .returning();
  return row ?? run;
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
  /** Requested cancels finished here because their run stopped answering. */
  cancelled: number;
}

/**
 * Finishes cancels requested more than {@link STALE_CANCEL_MS} ago whose run
 * never got to them (its workflow died mid-create), retries the delete of
 * servers a failed or cancelled run left behind (`cleanup_failed`), then
 * compares each workspace's managed servers with its nodes and flags
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
  const report: ReconcileReport = { cleanedUp: 0, missing: 0, errors: 0, cancelled: 0 };
  const stuck = await db
    .select({ id: nodeProvisions.id })
    .from(nodeProvisions)
    .where(
      and(
        inArray(nodeProvisions.status, [...ACTIVE_PROVISION_STATUSES]),
        lt(nodeProvisions.cancelRequestedAt, new Date(+now - STALE_CANCEL_MS)),
      ),
    );
  for (const run of stuck) {
    const done = await finishCancel(db, keys, run.id, { lookup: true });
    if (done?.status === "cancelled" || done?.status === "cleanup_failed") report.cancelled++;
  }

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
    .set({ status: run.failureReason === "cancelled" ? "cancelled" : "failed" })
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
