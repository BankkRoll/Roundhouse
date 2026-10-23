/**
 * Cloud provider routes: workspace integrations (write-only tokens), priced
 * offers, and one-click provisioning runs. Contracts live in
 * `../contracts/providers`; provider calls go through
 * `../lib/cloud-providers`.
 *
 * @module
 */
import type { z } from "@hono/zod-openapi";
import { nodeProvisions, nodes, providerCredentials } from "@roundhouse/db";
import {
  isAmbiguous,
  PROVIDER_IDS,
  PROVIDERS,
  ProviderApiError,
  type ProviderId,
  recommend,
} from "@roundhouse/providers";
import { newId } from "@roundhouse/shared";
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, or } from "drizzle-orm";
import {
  clientIp,
  createRouter,
  originOf,
  requireMasterKey,
  requireUser,
  requireWorkspace,
} from "../context";
import { policyOf } from "../contracts/policy";
import {
  connectIntegration,
  disconnectIntegration,
  getIntegration,
  getNodeProvision,
  listIntegrations,
  listNodeProvisions,
  listProviderOffers,
  provisionNode,
} from "../contracts/providers";
import { recordAudit } from "../lib/audit";
import {
  loadCredential,
  providerClient,
  providerFailure,
  providerTokenFingerprint,
  sealProviderToken,
  toApiIntegration,
  toApiOffer,
  unsealProviderToken,
} from "../lib/cloud-providers";
import { disposeRpc } from "../lib/deployments";
import { ApiError, isUniqueViolation, notFound } from "../lib/errors";
import { ACTIVE_PROVISION_STATUSES, attachJoinedNode, toApiProvision } from "../lib/provisioning";
import type { OffersSchema } from "../schemas/providers";

/** How long offers stay cached: prices and stock change rarely, and a stale pick fails cleanly. */
const OFFERS_TTL_S = 600;

const RECENT_PROVISIONS_MS = 24 * 60 * 60 * 1000;

function validationFailure(provider: ProviderId, err: unknown): ApiError {
  const name = PROVIDERS[provider].displayName;
  if (err instanceof TypeError) {
    return new ApiError(400, "provider_token_invalid", `That is not a ${name} API token`);
  }
  if (err instanceof ProviderApiError && err.code === "rate_limited") {
    return new ApiError(429, "rate_limited", `${name} is rate limiting requests; retry shortly`);
  }
  if (err instanceof ProviderApiError || isAmbiguous(err)) {
    return new ApiError(502, "upstream_error", `Could not reach ${name} to check the token`);
  }
  return new ApiError(502, "upstream_error", `Checking the token with ${name} failed`);
}

/** Cloud provider routes. */
export const providerRoutes = createRouter()
  .openapi(listIntegrations, async (c) => {
    const { workspaceId } = c.req.valid("param");
    await requireWorkspace(c, workspaceId, policyOf(listIntegrations).action!);
    const rows = await c
      .get("db")
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.workspaceId, workspaceId));
    const byProvider = new Map(rows.map((r) => [r.provider, r]));
    return c.json(
      { integrations: PROVIDER_IDS.map((p) => toApiIntegration(p, byProvider.get(p))) },
      200,
    );
  })
  .openapi(getIntegration, async (c) => {
    const { workspaceId, provider } = c.req.valid("param");
    await requireWorkspace(c, workspaceId, policyOf(getIntegration).action!);
    const row = await loadCredential(c.get("db"), workspaceId, provider);
    return c.json(toApiIntegration(provider, row), 200);
  })
  .openapi(connectIntegration, async (c) => {
    const { workspaceId, provider } = c.req.valid("param");
    await requireUser(c);
    const m = await requireWorkspace(c, workspaceId, policyOf(connectIntegration).action!);
    const masterKey = requireMasterKey(c);
    const { token } = c.req.valid("json");
    const name = PROVIDERS[provider].displayName;

    let check: Awaited<ReturnType<ReturnType<typeof providerClient>["validateToken"]>>;
    try {
      check = await providerClient(provider, token).validateToken({ timeoutMs: 15_000 });
    } catch (err) {
      throw validationFailure(provider, err);
    }
    if (!check.valid) {
      throw new ApiError(400, "provider_token_invalid", `${name} rejected this token`);
    }
    if (!check.canWrite) {
      const missing = check.missing?.length ? ` (missing: ${check.missing.join(", ")})` : "";
      throw new ApiError(
        409,
        "provider_read_only",
        `This ${name} token can't create servers${missing}; create one with ${PROVIDERS[provider].requiredScopes.join(", ")}`,
      );
    }

    const db = c.get("db");
    const existing = await loadCredential(db, workspaceId, provider);
    const id = existing?.id ?? newId("providerCredential");
    const now = new Date();
    const values = {
      tokenSealed: await sealProviderToken(c.env, token, { workspaceId, provider, rowId: id }),
      fingerprint: await providerTokenFingerprint(masterKey, workspaceId, token),
      tokenLast4: token.slice(-4),
      accountLabel: (check.account?.name || check.account?.email || null)?.slice(0, 200) ?? null,
      validatedAt: now,
      updatedAt: now,
    };
    let row: typeof providerCredentials.$inferSelect | undefined;
    if (existing) {
      [row] = await db
        .update(providerCredentials)
        .set(values)
        .where(eq(providerCredentials.id, id))
        .returning();
    } else {
      try {
        [row] = await db
          .insert(providerCredentials)
          .values({ id, workspaceId, provider, createdBy: m.user.id, ...values })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, "provider_credentials")) {
          throw new ApiError(409, "conflict", `${name} was connected at the same time; retry`);
        }
        throw err;
      }
    }
    await recordAudit(db, {
      workspaceId,
      ...m.actor,
      action: "provider.connected",
      targetType: "provider_credential",
      targetId: id,
      metadata: { provider, fingerprint: values.fingerprint, replaced: existing !== undefined },
      ip: clientIp(c),
    });
    return c.json(toApiIntegration(provider, row), 200);
  })
  .openapi(disconnectIntegration, async (c) => {
    const { workspaceId, provider } = c.req.valid("param");
    const { force } = c.req.valid("query");
    await requireUser(c);
    const m = await requireWorkspace(c, workspaceId, policyOf(disconnectIntegration).action!);
    const db = c.get("db");
    const row = await loadCredential(db, workspaceId, provider);
    if (!row) throw notFound("Integration");
    if (!force) {
      const [managed] = await db
        .select({ n: count() })
        .from(nodes)
        .where(
          and(
            eq(nodes.workspaceId, workspaceId),
            eq(nodes.provider, provider),
            isNotNull(nodes.providerServerId),
            isNull(nodes.deletedAt),
          ),
        );
      const [running] = await db
        .select({ n: count() })
        .from(nodeProvisions)
        .where(
          and(
            eq(nodeProvisions.workspaceId, workspaceId),
            eq(nodeProvisions.provider, provider),
            inArray(nodeProvisions.status, [...ACTIVE_PROVISION_STATUSES, "cleanup_failed"]),
          ),
        );
      const busy = (managed?.n ?? 0) + (running?.n ?? 0);
      if (busy > 0) {
        throw new ApiError(
          409,
          "conflict",
          `${busy} server(s) were created with this ${PROVIDERS[provider].displayName} token; deleting them needs it. Remove them first, or pass force=true to leave them running at the provider.`,
        );
      }
    }
    await db.delete(providerCredentials).where(eq(providerCredentials.id, row.id));
    await recordAudit(db, {
      workspaceId,
      ...m.actor,
      action: "provider.disconnected",
      targetType: "provider_credential",
      targetId: row.id,
      metadata: { provider, fingerprint: row.fingerprint, forced: force },
      ip: clientIp(c),
    });
    return c.body(null, 204);
  })
  .openapi(listProviderOffers, async (c) => {
    const { workspaceId, provider } = c.req.valid("param");
    const { role, region } = c.req.valid("query");
    await requireWorkspace(c, workspaceId, policyOf(listProviderOffers).action!);
    const db = c.get("db");
    const row = await loadCredential(db, workspaceId, provider);
    if (!row) {
      throw new ApiError(
        409,
        "provider_not_connected",
        `Connect ${PROVIDERS[provider].displayName} to this workspace first`,
      );
    }
    // The credential ID and version are in the key, so replacing the token
    // (another account, other prices) never serves the old catalogue.
    const cacheKey = `https://offers.roundhouse.invalid/${row.id}/${+row.updatedAt}/${role}/${region ?? "-"}`;
    const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
    const hit = await cache?.match(cacheKey).catch(() => undefined);
    if (hit) return c.json((await hit.json()) as z.infer<typeof OffersSchema>, 200);

    const client = providerClient(provider, await unsealProviderToken(c.env, row));
    let offers: Awaited<ReturnType<typeof client.listOffers>>;
    try {
      offers = await client.listOffers({ role, region }, { timeoutMs: 20_000 });
    } catch (err) {
      throw providerFailure(provider, err);
    }
    const body = {
      provider,
      role,
      offers: offers.map(toApiOffer),
      recommendations: recommend(offers, { role, regions: region ? [region] : undefined }).map(
        (r) => ({ offer_id: r.offer.id, reason: r.reason }),
      ),
      fetched_at: Date.now(),
    };
    await cache
      ?.put(
        cacheKey,
        new Response(JSON.stringify(body), {
          headers: {
            "content-type": "application/json",
            "cache-control": `max-age=${OFFERS_TTL_S}`,
          },
        }),
      )
      .catch(() => {});
    return c.json(body, 200);
  })
  .openapi(provisionNode, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const m = await requireWorkspace(c, workspaceId, policyOf(provisionNode).action!);
    const input = c.req.valid("json");
    const db = c.get("db");
    const origin = originOf(c);
    if (!origin.startsWith("https://") && c.env.ROUNDHOUSE_DEV !== "1") {
      throw new ApiError(
        503,
        "setup_incomplete",
        "Cloud servers join over HTTPS; serve the control plane on an https:// origin first",
      );
    }
    const cred = await loadCredential(db, workspaceId, input.provider);
    if (!cred) {
      throw new ApiError(
        409,
        "provider_not_connected",
        `Connect ${PROVIDERS[input.provider].displayName} to this workspace first`,
      );
    }
    const [nodeTaken] = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.workspaceId, workspaceId),
          eq(nodes.name, input.name),
          isNull(nodes.deletedAt),
        ),
      )
      .limit(1);
    const [runTaken] = await db
      .select({ id: nodeProvisions.id })
      .from(nodeProvisions)
      .where(
        and(
          eq(nodeProvisions.workspaceId, workspaceId),
          eq(nodeProvisions.name, input.name),
          inArray(nodeProvisions.status, [...ACTIVE_PROVISION_STATUSES, "cleanup_failed"]),
        ),
      )
      .limit(1);
    if (nodeTaken || runTaken) {
      throw new ApiError(409, "conflict", `A server named ${input.name} already exists`);
    }

    const id = newId("nodeProvision");
    const [row] = await db
      .insert(nodeProvisions)
      .values({
        id,
        workspaceId,
        provider: input.provider,
        name: input.name,
        plan: input.plan,
        region: input.region,
        builder: input.builder,
        createdBy: m.user.id,
      })
      .returning();
    try {
      disposeRpc(
        await c.env.PROVISION_WORKFLOW.create({ id, params: { provisionId: id, origin } }),
      );
    } catch (err) {
      await db
        .update(nodeProvisions)
        .set({
          status: "failed",
          failureReason: "provider_error",
          failureMessage: "Could not start provisioning",
          finishedAt: new Date(),
        })
        .where(eq(nodeProvisions.id, id));
      throw err;
    }
    await recordAudit(db, {
      workspaceId,
      ...m.actor,
      action: "node.provision_requested",
      targetType: "node_provision",
      targetId: id,
      metadata: {
        provider: input.provider,
        name: input.name,
        plan: input.plan,
        region: input.region,
        builder: input.builder,
      },
      ip: clientIp(c),
    });
    return c.json(toApiProvision(row!), 202);
  })
  .openapi(listNodeProvisions, async (c) => {
    const { workspaceId } = c.req.valid("param");
    await requireWorkspace(c, workspaceId, policyOf(listNodeProvisions).action!);
    const db = c.get("db");
    const rows = await db
      .select()
      .from(nodeProvisions)
      .where(
        and(
          eq(nodeProvisions.workspaceId, workspaceId),
          or(
            inArray(nodeProvisions.status, [...ACTIVE_PROVISION_STATUSES, "cleanup_failed"]),
            gt(nodeProvisions.createdAt, new Date(Date.now() - RECENT_PROVISIONS_MS)),
          ),
        ),
      )
      .orderBy(desc(nodeProvisions.id))
      .limit(50);
    const settled = await Promise.all(
      rows.map(async (r) =>
        r.status === "booting" ? ((await attachJoinedNode(db, r.id)) ?? r) : r,
      ),
    );
    return c.json({ provisions: settled.map(toApiProvision) }, 200);
  })
  .openapi(getNodeProvision, async (c) => {
    const { workspaceId, provisionId } = c.req.valid("param");
    await requireWorkspace(c, workspaceId, policyOf(getNodeProvision).action!);
    const db = c.get("db");
    const [row] = await db
      .select()
      .from(nodeProvisions)
      .where(and(eq(nodeProvisions.id, provisionId), eq(nodeProvisions.workspaceId, workspaceId)));
    if (!row) throw notFound("Provisioning run");
    const current = row.status === "booting" ? ((await attachJoinedNode(db, row.id)) ?? row) : row;
    return c.json(toApiProvision(current), 200);
  });
