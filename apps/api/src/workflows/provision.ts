/**
 * `ProvisionWorkflow`: one one-click provisioning run, from "create a
 * server" to "its agent joined". One instance per run; the instance ID is
 * the `prov_…` ID.
 *
 * Steps:
 * 1. `create-server` (retried on transient provider errors): mint a
 *    single-use join token, unseal the workspace's provider token, and call
 *    `Provider.provision`, which is idempotent by node name and deletes the
 *    server itself if anything fails after creating it. Refusals
 *    (`ProvisionError`) end the run as `failed` (or `cleanup_failed` when
 *    the server may still exist) and revoke the token.
 * 2. `record-price`: the chosen offer's catalogue price, for the node's
 *    cost estimate (best effort).
 * 3. `check-join-<n>` / `join-wait-<n>`: wait up to
 *    {@link JOIN_TIMEOUT_MS} for the agent to use the token, then attach the
 *    node (provider, server ID, region).
 * 4. `deprovision-unjoined`: on timeout, delete the server (it never joined,
 *    so nothing runs on it), revoke the token, and fail with `join_timeout`.
 *
 * Cancelling (`POST …/node-provisions/{id}/cancel`) sets
 * `cancel_requested_at`. A queued or booting run is finished by the route; a
 * run creating its server is finished here, once the provider call returns
 * and the server ID is known, by {@link finishCancel}. Every status write
 * compares the current status, so the route, this workflow and the reconcile
 * never both finish a run.
 *
 * SECURITY: Step results are persisted by the platform, so they carry only
 * IDs and statuses. The provider token is unsealed inside the step that uses
 * it, and the join token's plaintext exists only in that step's memory and
 * the server's user data (single-use, 15 minutes; see
 * `@roundhouse/providers`' security model).
 *
 * @module
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createDb, type Db, nodeProvisions } from "@roundhouse/db";
import {
  errorMessage,
  isProviderId,
  PROVIDERS,
  ProvisionError,
  type ProvisionStep,
} from "@roundhouse/providers";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Env } from "../env";
import { recordAudit } from "../lib/audit";
import { loadCredential, providerClient, unsealProviderToken } from "../lib/cloud-providers";
import { mintJoinToken, revokeJoinToken } from "../lib/join-tokens";
import {
  ACTIVE_PROVISION_STATUSES,
  attachJoinedNode,
  finishCancel,
  recordOfferPrice,
} from "../lib/provisioning";

/** Parameters of one run. */
export interface ProvisionParams {
  /** `prov_…`; also the workflow instance ID. */
  provisionId: string;
  /** Control plane origin the server's cloud-init joins. */
  origin: string;
}

/** How long a running server gets for its agent to join. */
export const JOIN_TIMEOUT_MS = 10 * 60 * 1000;

const JOIN_POLL_S = 10;

// Generous: creating and booting takes 30-90 s, plus the adapter's own
// polling and the cleanup it runs on failure.
const CREATE_TIMEOUT_MS = 9 * 60 * 1000;

const CREATE_STEP = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
  timeout: "12 minutes",
} as const;

const DB_STEP = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
  timeout: "1 minute",
} as const;

const PROVIDER_STEP = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} as const;

type Created = { kind: "ok" } | { kind: "stop" };

/** Runs one provisioning run. */
export class ProvisionWorkflow extends WorkflowEntrypoint<Env, ProvisionParams> {
  override async run(event: Readonly<WorkflowEvent<ProvisionParams>>, step: WorkflowStep) {
    const { provisionId, origin } = event.payload;
    let created: Created;
    try {
      created = await step.do("create-server", CREATE_STEP, () =>
        this.createServer(provisionId, origin),
      );
    } catch (err) {
      await step.do("record-failure", DB_STEP, () =>
        this.fail(provisionId, "failed", "provider_error", errorMessage(err)),
      );
      return { status: "failed" };
    }
    if (created.kind === "stop") return { status: "stopped" };
    await step.do("record-price", DB_STEP, () => this.recordPrice(provisionId));

    const deadline = await step.do("join-deadline", async () => Date.now() + this.joinTimeoutMs());
    for (let i = 0; ; i++) {
      const status = await step.do(`check-join-${i}`, DB_STEP, async () => {
        const row = await attachJoinedNode(this.db(), provisionId);
        return row?.status ?? "failed";
      });
      if (status !== "booting") return { status };
      if (Date.now() >= deadline) break;
      await step.sleep(`join-wait-${i}`, `${this.joinPollSeconds()} seconds`);
    }

    try {
      const outcome = await step.do("deprovision-unjoined", PROVIDER_STEP, () =>
        this.deprovisionUnjoined(provisionId),
      );
      return { status: outcome };
    } catch (err) {
      await step.do("record-cleanup-failure", DB_STEP, () =>
        this.fail(provisionId, "cleanup_failed", "join_timeout", errorMessage(err)),
      );
      return { status: "cleanup_failed" };
    }
  }

  private db(): Db {
    return createDb(this.env.DB);
  }

  private joinTimeoutMs(): number {
    const s = Number(this.env.PROVISION_JOIN_TIMEOUT_S);
    return Number.isFinite(s) && s > 0 ? s * 1000 : JOIN_TIMEOUT_MS;
  }

  private joinPollSeconds(): number {
    const s = Number(this.env.PROVISION_JOIN_POLL_S);
    return Number.isFinite(s) && s > 0 ? s : JOIN_POLL_S;
  }

  /**
   * Step 1. Re-runs after a lost result must not orphan a server or a
   * token: the adapter finds a server it already created by its labels, and
   * whichever token is in that server's user data is the one kept.
   */
  private async createServer(provisionId: string, origin: string): Promise<Created> {
    const db = this.db();
    const [row] = await db.select().from(nodeProvisions).where(eq(nodeProvisions.id, provisionId));
    if (!row) return { kind: "stop" };
    if (row.status === "booting" && row.serverId) return { kind: "ok" };
    if (row.status !== "queued" && row.status !== "creating") return { kind: "stop" };
    if (row.cancelRequestedAt) {
      // A creating run may have made a server in an attempt whose result was lost.
      await finishCancel(db, this.env, provisionId, { lookup: row.status === "creating" });
      return { kind: "stop" };
    }

    const cred = await loadCredential(db, row.workspaceId, row.provider);
    if (!cred) {
      await this.fail(
        provisionId,
        "failed",
        "provider_not_connected",
        `${PROVIDERS[row.provider].displayName} was disconnected before the server was created`,
      );
      return { kind: "stop" };
    }
    const client = providerClient(row.provider, await unsealProviderToken(this.env, cred));

    const previousTokenId = row.joinTokenId;
    const minted = await mintJoinToken(db, {
      workspaceId: row.workspaceId,
      createdBy: row.createdBy,
    });
    const [started] = await db
      .update(nodeProvisions)
      .set({
        status: "creating",
        joinTokenId: minted.id,
        failureReason: null,
        failureMessage: null,
      })
      .where(
        and(
          eq(nodeProvisions.id, provisionId),
          inArray(nodeProvisions.status, ["queued", "creating"]),
          isNull(nodeProvisions.cancelRequestedAt),
        ),
      )
      .returning({ id: nodeProvisions.id });
    if (!started) {
      await revokeJoinToken(db, minted.id);
      await finishCancel(db, this.env, provisionId, { lookup: row.status === "creating" });
      return { kind: "stop" };
    }

    let progress = Promise.resolve();
    const onStep = (s: ProvisionStep) => {
      progress = progress
        .then(async () => {
          await db
            .update(nodeProvisions)
            .set({ step: s })
            .where(eq(nodeProvisions.id, provisionId));
        })
        .catch(() => {});
    };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), CREATE_TIMEOUT_MS);
    try {
      const result = await client.provision(
        {
          name: row.name,
          plan: row.plan,
          region: row.region,
          controlPlaneUrl: origin,
          joinToken: minted.token,
          builder: row.builder,
          workspaceId: row.workspaceId,
          allowLoopbackHttp: this.env.ROUNDHOUSE_DEV === "1",
        },
        { onStep, signal: abort.signal, readyTimeoutMs: CREATE_TIMEOUT_MS - 60_000 },
      );
      await progress;

      if (!result.created && result.server.managed?.workspaceId !== row.workspaceId) {
        // NOTE: A managed server with this name that this workspace didn't
        // create (another install or workspace on the same provider
        // project). Never adopt it, and never delete it on timeout.
        await revokeJoinToken(db, minted.id);
        await this.fail(
          provisionId,
          "failed",
          "name_taken",
          `A server named ${row.name} already exists at ${PROVIDERS[row.provider].displayName}`,
        );
        return { kind: "stop" };
      }
      // A reused server booted with the previous attempt's token.
      const keep = result.created || !previousTokenId ? minted.id : previousTokenId;
      const drop = keep === minted.id ? previousTokenId : minted.id;
      if (drop) await revokeJoinToken(db, drop);
      const [booting] = await db
        .update(nodeProvisions)
        .set({
          status: "booting",
          step: "done",
          serverId: result.server.id,
          ipv4: result.server.ipv4,
          ipv6: result.server.ipv6,
          joinTokenId: keep,
        })
        .where(
          and(
            eq(nodeProvisions.id, provisionId),
            eq(nodeProvisions.status, "creating"),
            isNull(nodeProvisions.cancelRequestedAt),
          ),
        )
        .returning({ id: nodeProvisions.id });
      if (!booting) {
        await revokeJoinToken(db, keep);
        await this.cancelCreated(provisionId, result.server.id);
        return { kind: "stop" };
      }
      return { kind: "ok" };
    } catch (err) {
      await progress;
      await revokeJoinToken(db, minted.id);
      if (err instanceof ProvisionError) {
        const leftover = err.reason === "failed_cleanup_failed";
        await this.fail(
          provisionId,
          leftover ? "cleanup_failed" : "failed",
          err.reason,
          err.message,
          leftover ? err.serverId : null,
        );
        return { kind: "stop" };
      }
      // Transient (rate limit, outage, timeout before the server existed):
      // let the step retry with a fresh token.
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The run was cancelled while its server was being created: finish the
   * cancel with the new server's ID. If something else already finished the
   * run without knowing the server (the reconcile, after a long stall), delete
   * it here, since nothing else will.
   */
  private async cancelCreated(provisionId: string, serverId: string): Promise<void> {
    const db = this.db();
    const row = await finishCancel(db, this.env, provisionId, { serverId });
    if (!row || row.serverId === serverId) return;
    const cred = await loadCredential(db, row.workspaceId, row.provider);
    try {
      if (!cred) throw new Error(`${PROVIDERS[row.provider].displayName} is not connected`);
      const client = providerClient(row.provider, await unsealProviderToken(this.env, cred));
      await client.deprovision({ serverId, expectedName: row.name, wait: false });
    } catch (err) {
      await db
        .update(nodeProvisions)
        .set({
          status: "cleanup_failed",
          serverId,
          failureMessage: `Deleting server ${serverId} failed: ${errorMessage(err)}`.slice(0, 500),
        })
        .where(and(eq(nodeProvisions.id, provisionId), eq(nodeProvisions.status, "cancelled")));
    }
  }

  /** Step 2: best effort, so a catalogue hiccup never fails the run. */
  private async recordPrice(provisionId: string): Promise<{ recorded: boolean }> {
    const db = this.db();
    const [row] = await db.select().from(nodeProvisions).where(eq(nodeProvisions.id, provisionId));
    if (!row || row.monthlyCents !== null) return { recorded: row?.monthlyCents != null };
    const cred = await loadCredential(db, row.workspaceId, row.provider);
    if (!cred) return { recorded: false };
    const client = providerClient(row.provider, await unsealProviderToken(this.env, cred));
    return { recorded: await recordOfferPrice(db, client, row) };
  }

  /** Step 4: the server runs but its agent never joined. */
  private async deprovisionUnjoined(provisionId: string): Promise<string> {
    const db = this.db();
    const row = await attachJoinedNode(db, provisionId);
    if (row?.status !== "booting") return row?.status ?? "failed";
    if (row.joinTokenId) await revokeJoinToken(db, row.joinTokenId);
    const message = `The server's agent did not join within ${Math.max(1, Math.round(this.joinTimeoutMs() / 60_000))} minutes, so the server was deleted`;
    const cred = isProviderId(row.provider)
      ? await loadCredential(db, row.workspaceId, row.provider)
      : undefined;
    if (!cred || !row.serverId) {
      await this.fail(provisionId, "cleanup_failed", "join_timeout", message, row.serverId);
      return "cleanup_failed";
    }
    try {
      const client = providerClient(row.provider, await unsealProviderToken(this.env, cred));
      await client.deprovision({ serverId: row.serverId, expectedName: row.name, wait: false });
    } catch (err) {
      if (err instanceof ProvisionError) {
        await this.fail(provisionId, "cleanup_failed", "join_timeout", err.message, row.serverId);
        return "cleanup_failed";
      }
      throw err;
    }
    await this.fail(provisionId, "failed", "join_timeout", message, row.serverId);
    return "failed";
  }

  /**
   * Ends a run unless it already settled, and audits it once. A run whose
   * cancel was requested ends `cancelled` rather than `failed` when nothing
   * is left running.
   */
  private async fail(
    provisionId: string,
    status: "failed" | "cleanup_failed",
    reason: string,
    message: string,
    serverId: string | null = null,
  ): Promise<void> {
    const db = this.db();
    const [current] = await db
      .select({ cancelRequestedAt: nodeProvisions.cancelRequestedAt })
      .from(nodeProvisions)
      .where(eq(nodeProvisions.id, provisionId));
    const final = status === "failed" && current?.cancelRequestedAt ? "cancelled" : status;
    const [row] = await db
      .update(nodeProvisions)
      .set({
        status: final,
        failureReason: reason,
        failureMessage: message.slice(0, 500),
        ...(serverId ? { serverId } : {}),
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(nodeProvisions.id, provisionId),
          inArray(nodeProvisions.status, [...ACTIVE_PROVISION_STATUSES]),
        ),
      )
      .returning();
    if (!row) return;
    await recordAudit(db, {
      workspaceId: row.workspaceId,
      actorType: "system",
      actorId: null,
      action: "node.provision_failed",
      targetType: "node_provision",
      targetId: row.id,
      metadata: { provider: row.provider, name: row.name, reason, server_id: row.serverId },
    });
  }
}
