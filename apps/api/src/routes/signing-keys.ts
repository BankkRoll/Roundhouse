/**
 * Control-plane signing-key rollover (ADR 0014 §13): status, schedule,
 * complete and cancel, all instance admin only; the three changes also need
 * a fresh session. Each change tells every connected node's Durable Object
 * to reload the keys, and scheduling announces the successor to agents that
 * can follow it.
 *
 * @module
 */
import type { nodes } from "@roundhouse/db";
import { KEY_ROLLOVER_PROTOCOL_VERSION } from "@roundhouse/protocol";
import type { InstanceAction } from "@roundhouse/shared";
import type { z } from "zod";
import { type AppContext, clientIp, createRouter, requireInstanceAction } from "../context";
import {
  cancelSigningKeyRollover,
  completeSigningKeyRollover,
  getSigningKeyStatus,
  policyOf,
  scheduleSigningKeyRollover,
} from "../contracts";
import { recordAudit } from "../lib/audit";
import { ApiError, conflict, notFound } from "../lib/errors";
import { requireFreshSession } from "../lib/fresh-session";
import { effectiveStatus } from "../lib/nodes";
import {
  cancelSigningKeyRollover as cancelRollover,
  completeSigningKeyRollover as completeRollover,
  DEFAULT_ROLLOVER_DELAY_HOURS,
  type NodeSigningKeys,
  rolloverDue,
  type SigningKeyStatus,
  scheduleSigningKeyRollover as scheduleRollover,
  signingKeyStatus,
} from "../lib/signing-keys";
import type { NODE_KEY_STATES, SigningKeyStatusSchema } from "../schemas/keys";

type NodeKeyState = (typeof NODE_KEY_STATES)[number];

/** Nodes notified at once after a change, so a large fleet can't exhaust subrequests in a burst. */
const NOTIFY_CONCURRENCY = 25;

const isConnected = (n: typeof nodes.$inferSelect) => {
  const s = effectiveStatus(n);
  return s === "online" || s === "degraded";
};

/**
 * Where a node stands; see `NODE_KEY_STATES`.
 *
 * @param n - The node.
 * @param status - The stored keys.
 * @returns Its state.
 */
export function nodeKeyState(n: NodeSigningKeys, status: SigningKeyStatus): NodeKeyState {
  const pins = n.pinnedKids;
  if (status.next) {
    if (pins?.includes(status.next.kid)) return "ready";
    if (pins && !pins.includes(status.current.kid)) return "rejoin_required";
    if (n.lastSeenAt === null) return "unknown";
    if (n.protocolVersion < KEY_ROLLOVER_PROTOCOL_VERSION) return "upgrade_required";
    return "pending";
  }
  if (!pins) return "unknown";
  return pins.includes(status.current.kid) ? "ready" : "rejoin_required";
}

function toApi(status: SigningKeyStatus, now = Date.now()): z.infer<typeof SigningKeyStatusSchema> {
  const due = status.next ? rolloverDue(status.next, now) : false;
  return {
    current: { kid: status.current.kid, public_key: status.current.publicKey },
    signing_kid: status.next && due ? status.next.kid : status.current.kid,
    next: status.next && {
      kid: status.next.kid,
      public_key: status.next.publicKey,
      not_before: status.next.notBefore * 1000,
      scheduled_at: status.next.scheduledAt,
      due,
    },
    retired: status.retired && { kid: status.retired.kid, retired_at: status.retired.retiredAt },
    nodes: status.nodes.map((n) => ({
      id: n.id,
      name: n.name,
      workspace_id: n.workspaceId,
      protocol_version: n.protocolVersion,
      connected: n.connected,
      pinned_kids: n.pinnedKids,
      state: nodeKeyState(n, status),
    })),
  };
}

async function readStatus(c: AppContext): Promise<SigningKeyStatus> {
  try {
    return await signingKeyStatus(c.get("db"), isConnected);
  } catch (err) {
    throw new ApiError(503, "setup_incomplete", (err as Error).message);
  }
}

/**
 * Asks each connected node's Durable Object to reload the keys (and announce
 * a scheduled successor). A node that misses it still converges: Durable
 * Objects reload within `SIGNING_KEY_CACHE_TTL_MS`, and every welcome
 * carries the announcement.
 */
async function notifyNodes(c: AppContext, status: SigningKeyStatus): Promise<void> {
  const ids = status.nodes.filter((n) => n.connected).map((n) => n.id);
  for (let i = 0; i < ids.length; i += NOTIFY_CONCURRENCY) {
    await Promise.allSettled(
      ids.slice(i, i + NOTIFY_CONCURRENCY).map((id) => {
        const stub = c.env.NODE_CONNECTION.get(c.env.NODE_CONNECTION.idFromName(id));
        return stub.refreshSigningKeys();
      }),
    );
  }
}

/** Signing-key rollover routes. */
export const signingKeyRoutes = createRouter()
  .openapi(getSigningKeyStatus, async (c) => {
    await requireInstanceAction(c, policyOf(getSigningKeyStatus).action as InstanceAction);
    return c.json(toApi(await readStatus(c)), 200);
  })
  .openapi(scheduleSigningKeyRollover, async (c) => {
    const user = await requireInstanceAction(
      c,
      policyOf(scheduleSigningKeyRollover).action as InstanceAction,
    );
    await requireFreshSession(c);
    const { delay_hours = DEFAULT_ROLLOVER_DELAY_HOURS } = c.req.valid("json");
    const db = c.get("db");
    const before = await readStatus(c);
    const now = Date.now();
    const notBefore = Math.ceil(now / 1000) + delay_hours * 3600;
    const scheduled = await scheduleRollover(db, c.env, {
      notBefore,
      scheduledBy: user.id,
      now,
    });
    if (!scheduled) throw conflict("A signing key rollover is already scheduled");
    await recordAudit(db, {
      workspaceId: null,
      actorType: "user",
      actorId: user.id,
      action: "key.rollover_scheduled",
      targetType: "signing_key",
      targetId: scheduled.kid,
      metadata: {
        kid: scheduled.kid,
        current_kid: before.current.kid,
        not_before: notBefore * 1000,
      },
      ip: clientIp(c),
    });
    const after = await readStatus(c);
    await notifyNodes(c, after);
    return c.json(toApi(after), 200);
  })
  .openapi(completeSigningKeyRollover, async (c) => {
    const user = await requireInstanceAction(
      c,
      policyOf(completeSigningKeyRollover).action as InstanceAction,
    );
    await requireFreshSession(c);
    const { force = false } = c.req.valid("json");
    const db = c.get("db");
    const before = await readStatus(c);
    if (!before.next) throw notFound("Scheduled signing key rollover");
    if (!rolloverDue(before.next)) {
      throw conflict(
        `The new signing key is used from ${new Date(before.next.notBefore * 1000).toISOString()}; complete the rollover after that`,
      );
    }
    const behind = before.nodes.filter((n) => nodeKeyState(n, before) !== "ready");
    if (behind.length && !force) {
      throw conflict(
        `${behind.length} node(s) don't pin the new signing key yet and would need a re-join; wait for them to reconnect, or complete with force`,
      );
    }
    const result = await completeRollover(db, c.env);
    if (!result.ok) {
      if (result.reason === "none") throw notFound("Scheduled signing key rollover");
      throw conflict("The signing keys changed while completing; retry");
    }
    await recordAudit(db, {
      workspaceId: null,
      actorType: "user",
      actorId: user.id,
      action: "key.rollover_completed",
      targetType: "signing_key",
      targetId: result.kid,
      metadata: {
        kid: result.kid,
        retired_kid: result.retiredKid,
        forced: force,
        nodes_behind: behind.map((n) => n.id).slice(0, 50),
      },
      ip: clientIp(c),
    });
    const after = await readStatus(c);
    await notifyNodes(c, after);
    return c.json(toApi(after), 200);
  })
  .openapi(cancelSigningKeyRollover, async (c) => {
    const user = await requireInstanceAction(
      c,
      policyOf(cancelSigningKeyRollover).action as InstanceAction,
    );
    await requireFreshSession(c);
    const db = c.get("db");
    const result = await cancelRollover(db);
    if (!result.ok) {
      if (result.reason === "none") throw notFound("Scheduled signing key rollover");
      if (result.reason === "already_due") {
        throw conflict(
          "The new signing key is already in use; complete the rollover instead of cancelling it",
        );
      }
      throw conflict("The signing keys changed while cancelling; retry");
    }
    await recordAudit(db, {
      workspaceId: null,
      actorType: "user",
      actorId: user.id,
      action: "key.rollover_cancelled",
      targetType: "signing_key",
      targetId: result.kid,
      metadata: { kid: result.kid },
      ip: clientIp(c),
    });
    const after = await readStatus(c);
    await notifyNodes(c, after);
    return c.json(toApi(after), 200);
  });
