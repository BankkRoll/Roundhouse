/**
 * Master key status and rotation (ADR 0014 "Rotation"): `KEY_ROUTES` in
 * `../contracts/keys`. Both are instance admin only; starting a rotation
 * also needs a fresh session.
 *
 * @module
 */
import { instanceSettings } from "@roundhouse/db";
import type { InstanceAction } from "@roundhouse/shared";
import { newId } from "@roundhouse/shared";
import { sql } from "drizzle-orm";
import { type AppContext, clientIp, createRouter, requireInstanceAction } from "../context";
import { getKeyStatus, policyOf, rotateKeys } from "../contracts";
import { recordAudit } from "../lib/audit";
import { ApiError, conflict } from "../lib/errors";
import { requireFreshSession } from "../lib/fresh-session";
import { keyringOf } from "../lib/keyring";
import { getSetting } from "../lib/settings";
import { KEY_ROTATION_SETTING, type KeyRotationState, keyStatus } from "../workflows/key-rotation";

// Workflow statuses in which a run may still write; anything else (errored,
// terminated, complete) left the stored state behind.
const LIVE_STATUSES = new Set(["queued", "running", "paused", "waiting", "waitingForPause"]);

async function requireKeyring(c: AppContext) {
  try {
    return await keyringOf(c.env);
  } catch {
    throw new ApiError(
      503,
      "master_key_missing",
      "MASTER_KEY or MASTER_KEYS_PREVIOUS is missing or invalid; fix them with `wrangler secret put`",
    );
  }
}

async function stillRunning(c: AppContext, id: string): Promise<boolean> {
  try {
    const instance = await c.env.KEY_ROTATION_WORKFLOW.get(id);
    return LIVE_STATUSES.has((await instance.status()).status);
  } catch {
    return false;
  }
}

/** Key status and rotation routes. */
export const keyRoutes = createRouter()
  .openapi(getKeyStatus, async (c) => {
    await requireInstanceAction(c, policyOf(getKeyStatus).action as InstanceAction);
    await requireKeyring(c);
    return c.json(await keyStatus(c.get("db"), c.env), 200);
  })
  .openapi(rotateKeys, async (c) => {
    const user = await requireInstanceAction(c, policyOf(rotateKeys).action as InstanceAction);
    await requireFreshSession(c);
    const ring = await requireKeyring(c);
    const db = c.get("db");
    const prior = await getSetting<KeyRotationState>(db, KEY_ROTATION_SETTING);
    if (prior?.state === "running" && (await stillRunning(c, prior.id))) {
      throw conflict(`Key rotation ${prior.id} is still running`);
    }
    const id = newId("keyRotation");
    const value: KeyRotationState = {
      id,
      state: "running",
      started_at: Date.now(),
      finished_at: null,
      error: null,
    };
    // Compare-and-swap on the run read above, so two concurrent requests
    // can't both start one.
    const claimed = await db
      .insert(instanceSettings)
      .values({ key: KEY_ROTATION_SETTING, value })
      .onConflictDoUpdate({
        target: instanceSettings.key,
        set: { value, updatedAt: new Date() },
        setWhere: prior
          ? sql`json_extract(${instanceSettings.value}, '$.id') = ${prior.id}`
          : sql`0`,
      })
      .returning({ key: instanceSettings.key });
    if (!claimed.length) throw conflict("Another key rotation started at the same time");
    await c.env.KEY_ROTATION_WORKFLOW.create({
      id,
      params: { rotationId: id, startedBy: user.id },
    });
    await recordAudit(db, {
      workspaceId: null,
      actorType: "user",
      actorId: user.id,
      action: "instance.key_rotation_started",
      targetType: "key_rotation",
      targetId: id,
      metadata: {
        current_kid: ring.current.kid,
        previous_kids: ring.previous.map((k) => k.kid),
      },
      ip: clientIp(c),
    });
    return c.json({ rotation_id: id }, 202);
  });
