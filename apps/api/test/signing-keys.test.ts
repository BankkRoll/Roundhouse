/**
 * Control-plane signing-key rollover (ADR 0014 §13): scheduling announces the
 * successor to agents that can follow it, frames switch to it at
 * `not_before` for agents that pin it, completing retires the old key, and
 * the routes are instance admin only with fresh sessions.
 */
import { env } from "cloudflare:test";
import { createDb } from "@roundhouse/db";
import type { JoinResponse } from "@roundhouse/protocol";
import {
  type Envelope,
  EnvelopeSchema,
  KEY_ROLLOVER_PROTOCOL_VERSION,
  MIN_PROTOCOL_VERSION,
  verifyEnvelope,
} from "@roundhouse/protocol";
import { describe, expect, it } from "vitest";
import {
  activeSigningKey,
  announcementsFor,
  invalidateSigningKeys,
  loadSigningKeys,
  type NextSigningKey,
  type SigningKey,
  type SigningKeySet,
  signingKeyFor,
} from "../src/lib/signing-keys";
import { rewrapInstanceBatch } from "../src/workflows/key-rotation";
import {
  addMember,
  type Client,
  connectAgent,
  eventually,
  type FakeAgent,
  hello,
  install,
  joinNode,
} from "./helpers";

interface Status {
  current: { kid: string; public_key: string };
  signing_kid: string;
  next: {
    kid: string;
    public_key: string;
    not_before: number;
    scheduled_at: number;
    due: boolean;
  } | null;
  retired: { kid: string; retired_at: number } | null;
  nodes: { id: string; pinned_kids: string[] | null; state: string; connected: boolean }[];
}

const nodeStub = (nodeId: string) =>
  env.NODE_CONNECTION.get(env.NODE_CONNECTION.idFromName(nodeId));

async function frame(agent: FakeAgent): Promise<Envelope> {
  return EnvelopeSchema.parse(JSON.parse(await agent.next()));
}

/** Verifies a frame as an agent pinning `publicKey` would. */
async function verified(env: Envelope, publicKey: string, nodeId: string) {
  const result = await verifyEnvelope(env, publicKey, nodeId);
  if (!result.ok) throw new Error(`frame rejected: ${result.reason}`);
  return result.message;
}

/** Connects a rollover-capable agent and consumes welcome and desired state. */
async function connect(joined: JoinResponse, pinned?: string[]) {
  const agent = await connectAgent(joined);
  agent.send(
    hello(joined.node_id, {
      protocol_version: KEY_ROLLOVER_PROTOCOL_VERSION,
      ...(pinned ? { pinned_kids: pinned } : {}),
    }),
  );
  const welcome = await frame(agent);
  const desired = await frame(agent);
  return { agent, welcome, desired };
}

/** Moves the scheduled successor's `not_before` into the past. */
async function makeDue() {
  await env.DB.prepare(
    "UPDATE instance_settings SET value = json_set(value, '$.not_before', ?) WHERE key = 'signing_key_next'",
  )
    .bind(Math.floor(Date.now() / 1000) - 1)
    .run();
}

async function status(owner: Client) {
  const res = await owner.json<Status>("/v1/instance/signing-keys");
  expect(res.status).toBe(200);
  return res.body;
}

async function auditActions(prefix: string) {
  const { results } = await env.DB.prepare(
    "SELECT action, workspace_id, metadata FROM audit_logs WHERE action LIKE ? ORDER BY created_at",
  )
    .bind(`${prefix}%`)
    .all<{ action: string; workspace_id: string | null; metadata: string }>();
  return results;
}

describe("signing key rollover", () => {
  it("announces, switches at not_before, and retires the old key", async () => {
    const { owner, workspaceId } = await install();
    const initial = await status(owner);
    expect(initial).toMatchObject({ next: null, retired: null });
    expect(initial.signing_kid).toBe(initial.current.kid);
    const oldKid = initial.current.kid;
    const oldKey = initial.current.public_key;

    const joined = await joinNode(owner, workspaceId);
    expect(joined.control_public_key).toBe(oldKey);
    const first = await connect(joined, [oldKid]);
    expect(first.welcome.kid).toBe(oldKid);
    const welcome = await verified(first.welcome, oldKey, joined.node_id);
    expect(welcome).not.toHaveProperty("next_keys");

    // A node from before rollover, which never learns the successor.
    const legacyJoined = await joinNode(owner, workspaceId, { name: "hel-2", hostname: "hel-2" });
    const legacy = await connectAgent(legacyJoined);
    legacy.send(hello(legacyJoined.node_id, { protocol_version: MIN_PROTOCOL_VERSION }));
    expect((await frame(legacy)).kid).toBe(oldKid);
    await frame(legacy);

    // Schedule: the connected agent gets a key_announce under the old key.
    const scheduled = await owner.json<Status>("/v1/instance/signing-keys/rotate", {
      method: "POST",
      json: {},
    });
    expect(scheduled.status).toBe(200);
    const next = scheduled.body.next;
    expect(next).not.toBeNull();
    if (!next) return;
    expect(next.kid).not.toBe(oldKid);
    expect(next.due).toBe(false);
    expect(next.not_before - Date.now()).toBeGreaterThan(23.9 * 3600_000);
    expect(scheduled.body.signing_kid).toBe(oldKid);

    const announce = await frame(first.agent);
    expect(announce.kid).toBe(oldKid);
    const announced = await verified(announce, oldKey, joined.node_id);
    expect(announced).toMatchObject({
      type: "key_announce",
      keys: [{ kid: next.kid, public_key: next.public_key, not_before: next.not_before / 1000 }],
    });

    const afterSchedule = await status(owner);
    const byId = new Map(afterSchedule.nodes.map((n) => [n.id, n]));
    expect(byId.get(joined.node_id)).toMatchObject({
      pinned_kids: [oldKid, next.kid],
      state: "ready",
    });
    expect(byId.get(legacyJoined.node_id)).toMatchObject({
      pinned_kids: [oldKid],
      state: "upgrade_required",
    });

    const again = await owner.request("/v1/instance/signing-keys/rotate", {
      method: "POST",
      json: {},
    });
    expect(again.status).toBe(409);
    const early = await owner.request("/v1/instance/signing-keys/complete", {
      method: "POST",
      json: {},
    });
    expect(early.status).toBe(409);

    // A reconnect before not_before: still the old key, with next_keys.
    const second = await connect(joined, [oldKid, next.kid]);
    expect(second.welcome.kid).toBe(oldKid);
    expect(await verified(second.welcome, oldKey, joined.node_id)).toMatchObject({
      next_keys: [{ kid: next.kid }],
    });

    // not_before passes: frames to the agent that pins it switch to it.
    await makeDue();
    expect(await nodeStub(joined.node_id).refreshSigningKeys()).toBe(false);
    expect(await nodeStub(joined.node_id).pushDesiredState()).toBe(true);
    const switched = await frame(second.agent);
    expect(switched.kid).toBe(next.kid);
    await verified(switched, next.public_key, joined.node_id);
    expect((await verifyEnvelope(switched, oldKey, joined.node_id)).ok).toBe(false);

    // The legacy agent pins only the old key and keeps getting it.
    expect(await nodeStub(legacyJoined.node_id).pushDesiredState()).toBe(true);
    expect((await frame(legacy)).kid).toBe(oldKid);

    // An agent that missed the announcement catches up: welcome under the
    // old key announcing the successor, then the successor.
    const lateJoined = await joinNode(owner, workspaceId, { name: "hel-3", hostname: "hel-3" });
    const lateAgent = await connectAgent(lateJoined);
    lateAgent.send(
      hello(lateJoined.node_id, {
        protocol_version: KEY_ROLLOVER_PROTOCOL_VERSION,
        pinned_kids: [oldKid],
      }),
    );
    const lateWelcome = await frame(lateAgent);
    expect(lateWelcome.kid).toBe(oldKid);
    expect(await verified(lateWelcome, oldKey, lateJoined.node_id)).toMatchObject({
      next_keys: [{ kid: next.kid }],
    });
    expect((await frame(lateAgent)).kid).toBe(next.kid);

    // Completing needs force while the legacy node doesn't pin the successor.
    const blocked = await owner.json<{ error: { code: string } }>(
      "/v1/instance/signing-keys/complete",
      { method: "POST", json: {} },
    );
    expect(blocked.status).toBe(409);
    const done = await owner.json<Status>("/v1/instance/signing-keys/complete", {
      method: "POST",
      json: { force: true },
    });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({
      current: { kid: next.kid, public_key: next.public_key },
      signing_kid: next.kid,
      next: null,
      retired: { kid: oldKid },
    });
    const final = new Map(done.body.nodes.map((n) => [n.id, n.state]));
    expect(final.get(joined.node_id)).toBe("ready");
    expect(final.get(legacyJoined.node_id)).toBe("rejoin_required");

    // The old private key is gone; only its public half is kept.
    const { results } = await env.DB.prepare(
      "SELECT key, value FROM instance_settings WHERE key LIKE 'signing_key%'",
    ).all<{ key: string; value: string }>();
    const stored = Object.fromEntries(results.map((r) => [r.key, JSON.parse(r.value)]));
    expect(Object.keys(stored).sort()).toEqual(["signing_key", "signing_key_retired"]);
    expect(stored.signing_key.kid).toBe(next.kid);
    expect(stored.signing_key_retired).not.toHaveProperty("private_key");

    // From now on no frame is signed with the old kid, whatever an agent pins.
    const third = await connect(joined, [oldKid]);
    expect(third.welcome.kid).toBe(next.kid);
    expect((await verifyEnvelope(third.welcome, oldKey, joined.node_id)).ok).toBe(false);
    const fresh = await joinNode(owner, workspaceId, { name: "hel-4", hostname: "hel-4" });
    expect(fresh.control_public_key).toBe(next.public_key);

    const audits = await auditActions("key.rollover_");
    expect(audits.map((a) => a.action)).toEqual([
      "key.rollover_scheduled",
      "key.rollover_completed",
    ]);
    expect(audits.every((a) => a.workspace_id === null)).toBe(true);
    expect(JSON.parse(audits[1]!.metadata)).toMatchObject({
      kid: next.kid,
      retired_kid: oldKid,
      forced: true,
      nodes_behind: [legacyJoined.node_id],
    });
  });

  it("cancels a rollover that isn't due, and withdraws it from agents", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const { current } = await status(owner);

    const res = await owner.json<Status>("/v1/instance/signing-keys/rotate", {
      method: "POST",
      json: { delay_hours: 2 },
    });
    expect(res.status).toBe(200);
    expect((res.body.next?.not_before ?? 0) - Date.now()).toBeLessThan(2 * 3600_000 + 2000);
    const first = await connect(joined, [current.kid]);
    expect(await verified(first.welcome, current.public_key, joined.node_id)).toHaveProperty(
      "next_keys",
    );

    const cancelled = await owner.json<Status>("/v1/instance/signing-keys/next", {
      method: "DELETE",
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.next).toBeNull();
    expect(
      (await owner.request("/v1/instance/signing-keys/next", { method: "DELETE" })).status,
    ).toBe(404);

    const second = await connect(joined, [current.kid, res.body.next?.kid ?? ""]);
    expect(second.welcome.kid).toBe(current.kid);
    expect(await verified(second.welcome, current.public_key, joined.node_id)).not.toHaveProperty(
      "next_keys",
    );

    // Once due it can't be cancelled: agents may already have switched.
    await owner.request("/v1/instance/signing-keys/rotate", { method: "POST", json: {} });
    await makeDue();
    const late = await owner.request("/v1/instance/signing-keys/next", { method: "DELETE" });
    expect(late.status).toBe(409);
    expect((await auditActions("key.rollover_")).map((a) => a.action)).toEqual([
      "key.rollover_scheduled",
      "key.rollover_cancelled",
      "key.rollover_scheduled",
    ]);
  });

  it("validates the delay and needs an instance admin with a fresh session", async () => {
    const { owner, workspaceId } = await install();
    for (const delay of [0, 721, 1.5]) {
      const res = await owner.request("/v1/instance/signing-keys/rotate", {
        method: "POST",
        json: { delay_hours: delay },
      });
      expect(res.status, String(delay)).toBe(400);
    }

    const admin = await addMember(owner, workspaceId, "ade@example.com", "admin");
    expect((await admin.request("/v1/instance/signing-keys")).status).toBe(403);
    expect(
      (await admin.request("/v1/instance/signing-keys/rotate", { method: "POST", json: {} }))
        .status,
    ).toBe(403);

    await env.DB.prepare("UPDATE sessions SET created_at = 1, reauthenticated_at = NULL").run();
    const stale = await owner.json<{ error: { code: string } }>(
      "/v1/instance/signing-keys/rotate",
      { method: "POST", json: {} },
    );
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe("reauth_required");
    expect((await status(owner)).next).toBeNull();
  });

  it("re-wraps a scheduled key when the master key rotates", async () => {
    const { owner } = await install();
    await owner.request("/v1/instance/signing-keys/rotate", { method: "POST", json: {} });
    const kekKid = () =>
      env.DB.prepare(
        "SELECT json_extract(value, '$.private_key.kid') AS kid FROM instance_settings WHERE key = 'signing_key_next'",
      ).first<{ kid: string }>();
    const before = await kekKid();
    const scheduledKid = (await status(owner)).next?.kid;
    const oldMaster = env.MASTER_KEY;
    env.MASTER_KEY = btoa("n".repeat(32));
    env.MASTER_KEYS_PREVIOUS = oldMaster;
    try {
      const db = createDb(env.DB);
      expect(await rewrapInstanceBatch(db, env)).toBeGreaterThanOrEqual(2);
      expect((await kekKid())?.kid).not.toBe(before?.kid);
      invalidateSigningKeys();
      const set = await loadSigningKeys(db, env);
      // The session is signed out by the new master key, so compare with the
      // kid read before the swap.
      expect(set.next?.kid).toBe(scheduledKid);
      // Only the new master key is needed from now on.
      env.MASTER_KEYS_PREVIOUS = undefined;
      invalidateSigningKeys();
      expect((await loadSigningKeys(db, env)).next).not.toBeNull();
    } finally {
      env.MASTER_KEY = oldMaster;
      env.MASTER_KEYS_PREVIOUS = undefined;
      invalidateSigningKeys();
    }
  });
});

describe("signing key choice", () => {
  const key = (kid: string): SigningKey => ({
    kid,
    publicKey: `${kid}-pub`,
    privateKey: {} as CryptoKey,
  });
  const now = 1_800_000_000_000;
  const next = (notBefore: number): NextSigningKey => ({
    ...key("k2"),
    notBefore,
    scheduledAt: now - 1000,
    scheduledBy: null,
  });
  const before: SigningKeySet = { current: key("k1"), next: next(now / 1000 + 60) };
  const due: SigningKeySet = { current: key("k1"), next: next(now / 1000 - 60) };

  it("signs with the current key until not_before", () => {
    expect(activeSigningKey(before, now).kid).toBe("k1");
    expect(signingKeyFor(before, ["k1", "k2"], now).kid).toBe("k1");
    expect(announcementsFor(before, "k1")).toEqual([
      { kid: "k2", public_key: "k2-pub", not_before: now / 1000 + 60 },
    ]);
  });

  it("switches agents that pin the successor once it is due", () => {
    expect(activeSigningKey(due, now).kid).toBe("k2");
    expect(signingKeyFor(due, ["k1", "k2"], now).kid).toBe("k2");
    expect(signingKeyFor(due, ["k2"], now).kid).toBe("k2");
    expect(announcementsFor(due, "k2")).toEqual([]);
  });

  it("keeps the old key for agents that don't pin the successor yet", () => {
    expect(signingKeyFor(due, ["k1"], now).kid).toBe("k1");
    expect(signingKeyFor(due, null, now).kid).toBe("k1");
    expect(signingKeyFor(due, ["k0"], now).kid).toBe("k2");
    expect(signingKeyFor({ current: key("k2"), next: null }, ["k1"], now).kid).toBe("k2");
  });
});

describe("nodes connecting during a rollover", () => {
  it("learn the successor from welcome and are recorded as pinning it", async () => {
    const { owner, workspaceId } = await install();
    await owner.request("/v1/instance/signing-keys/rotate", { method: "POST", json: {} });
    const { next, current } = await status(owner);
    const joined = await joinNode(owner, workspaceId);
    const { welcome } = await connect(joined);
    expect(await verified(welcome, current.public_key, joined.node_id)).toMatchObject({
      next_keys: [{ kid: next?.kid }],
    });
    const row = await eventually(async () => {
      const r = await env.DB.prepare("SELECT pinned_signing_kids AS p FROM nodes WHERE id = ?")
        .bind(joined.node_id)
        .first<{ p: string }>();
      return r?.p.includes(next?.kid ?? "?") ? r : undefined;
    });
    expect(JSON.parse(row.p)).toEqual([current.kid, next?.kid]);
  });
});
