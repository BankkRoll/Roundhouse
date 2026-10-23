/**
 * The control-plane Ed25519 signing key that agents pin, and its rollover
 * (ADR 0014 §13).
 *
 * Responsibilities:
 * - create the first key at setup and load the key set for signing, cached
 *   per isolate for {@link SIGNING_KEY_CACHE_TTL_MS};
 * - schedule a successor (`signing_key_next`, private half sealed under the
 *   KEK like the current one, so `KeyRotationWorkflow` re-wraps both),
 *   switch signing to it at `not_before`, and complete (promote it, retire
 *   the old key) or cancel the rollover;
 * - pick the key each connection's frames are signed with from the kids its
 *   agent pins, and the announcements (`welcome.next_keys`,
 *   `key_announce`) it must receive.
 *
 * Overlap: until the rollover is completed both private keys exist. Before
 * `not_before` everything is signed by the current key. From `not_before`
 * frames to agents that pin the successor are signed by it (their first
 * such frame retires the old kid on the agent); an agent that doesn't pin
 * it yet keeps getting frames from the old key, together with the
 * announcement, so it can catch up. Completing deletes the old private key:
 * agents that never pinned the successor then need a re-join.
 *
 * SECURITY: rollover only moves trust forward from a key agents already pin.
 * A suspected compromise of the current key is not a rollover (an attacker
 * holding it could announce their own successor): every node must re-join.
 *
 * @module
 */
import { type Db, instanceSettings, nodes } from "@roundhouse/db";
import {
  generateSigningKey,
  importSigningKey,
  type SigningKeyAnnouncement,
} from "@roundhouse/protocol";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type KeyEnv,
  SealedSchema,
  sealInstanceSecret,
  unsealInstanceSecret,
} from "./instance-secrets";
import { getSetting, putSetting, SettingKey } from "./settings";

/** How long an isolate reuses the key set before reading it again. */
export const SIGNING_KEY_CACHE_TTL_MS = 60_000;

/** Default time from scheduling a rollover to its `not_before`. */
export const DEFAULT_ROLLOVER_DELAY_HOURS = 24;

/**
 * Shortest allowed delay: agents must have a chance to reconnect and pin the
 * successor before frames are signed with it.
 */
export const MIN_ROLLOVER_DELAY_HOURS = 1;

/** Longest allowed delay (30 days). */
export const MAX_ROLLOVER_DELAY_HOURS = 720;

const StoredSigningKeySchema = z.object({
  kid: z.string(),
  public_key: z.string(),
  private_key: SealedSchema,
});

const StoredNextSigningKeySchema = StoredSigningKeySchema.extend({
  /** Unix seconds, as on the wire. */
  not_before: z.number().int().positive(),
  /** Unix ms. */
  scheduled_at: z.number().int(),
  scheduled_by: z.string().nullable(),
});

const StoredRetiredSigningKeySchema = z.object({
  kid: z.string(),
  public_key: z.string(),
  /** Unix ms. */
  retired_at: z.number().int(),
});

type StoredSigningKey = z.infer<typeof StoredSigningKeySchema>;
type StoredNextSigningKey = z.infer<typeof StoredNextSigningKeySchema>;

/** A signing key ready for use. */
export interface SigningKey {
  kid: string;
  /** Raw 32-byte Ed25519 public key, base64. */
  publicKey: string;
  privateKey: CryptoKey;
}

/** A scheduled successor. */
export interface NextSigningKey extends SigningKey {
  /** Unix seconds from which frames may be signed with it. */
  notBefore: number;
  /** Unix ms. */
  scheduledAt: number;
  scheduledBy: string | null;
}

/** Every key the control plane may sign with right now. */
export interface SigningKeySet {
  current: SigningKey;
  next: NextSigningKey | null;
}

// -----------------------------------------------------------------------------
// Loading
// -----------------------------------------------------------------------------

// PERF: every join and every signed control frame needs the keys. Caching
// skips a D1 read, an AES-GCM unseal and a key import on each. The TTL
// bounds how long another isolate's schedule, completion or cancellation
// goes unseen; the switch at `not_before` needs no reload, since it is
// decided by the clock.
let cached: { at: number; set: Promise<SigningKeySet> } | undefined;

/** Drops this isolate's cached key set, so the next load reads D1. */
export function invalidateSigningKeys(): void {
  cached = undefined;
}

async function importStored(
  keys: KeyEnv,
  stored: StoredSigningKey,
  settingKey: string,
): Promise<SigningKey> {
  const pkcs8 = await unsealInstanceSecret(keys, stored.private_key, settingKey);
  return {
    kid: stored.kid,
    publicKey: stored.public_key,
    privateKey: await importSigningKey(pkcs8),
  };
}

/**
 * Loads the current key and any scheduled successor.
 *
 * @param db - Database client.
 * @param keys - The master keyring bindings (`env`).
 * @param now - Current time, unix ms.
 * @returns The key set.
 * @throws When setup hasn't created a key yet or a stored key is corrupt.
 */
export function loadSigningKeys(db: Db, keys: KeyEnv, now = Date.now()): Promise<SigningKeySet> {
  if (cached && now - cached.at < SIGNING_KEY_CACHE_TTL_MS) return cached.set;
  const entry = {
    at: now,
    set: (async (): Promise<SigningKeySet> => {
      const [rawCurrent, rawNext] = await Promise.all([
        getSetting<unknown>(db, SettingKey.signingKey),
        getSetting<unknown>(db, SettingKey.signingKeyNext),
      ]);
      if (rawCurrent === undefined) throw new Error("signing key not initialised; run setup first");
      const current = await importStored(
        keys,
        StoredSigningKeySchema.parse(rawCurrent),
        SettingKey.signingKey,
      );
      if (rawNext === undefined) return { current, next: null };
      const stored = StoredNextSigningKeySchema.parse(rawNext);
      return {
        current,
        next: {
          ...(await importStored(keys, stored, SettingKey.signingKeyNext)),
          notBefore: stored.not_before,
          scheduledAt: stored.scheduled_at,
          scheduledBy: stored.scheduled_by,
        },
      };
    })(),
  };
  entry.set.catch(() => {
    if (cached === entry) cached = undefined;
  });
  cached = entry;
  return entry.set;
}

/**
 * Whether a successor's `not_before` has passed.
 *
 * @param next - The successor.
 * @param now - Current time, unix ms.
 */
export function rolloverDue(next: { notBefore: number }, now = Date.now()): boolean {
  return now >= next.notBefore * 1000;
}

/**
 * The key frames are signed with by default: the successor once its
 * `not_before` has passed, otherwise the current key. New nodes are handed
 * its public half at join.
 *
 * @param set - The key set.
 * @param now - Current time, unix ms.
 * @returns The active key.
 */
export function activeSigningKey(set: SigningKeySet, now = Date.now()): SigningKey {
  return set.next && rolloverDue(set.next, now) ? set.next : set.current;
}

/**
 * The key to sign a connection's frames with.
 *
 * @param set - The key set.
 * @param pinned - Kids the agent pins (`hello.pinned_kids`, else those
 *   recorded at join or announced since); `null` when unknown, for agents
 *   that predate rollover and pin the key they joined with.
 * @param now - Current time, unix ms.
 * @returns The successor when it is due and pinned, else the current key
 *   when pinned, else the active key (the agent pins neither, and only a
 *   re-join can help it).
 */
export function signingKeyFor(
  set: SigningKeySet,
  pinned: readonly string[] | null,
  now = Date.now(),
): SigningKey {
  if (!pinned) return set.current;
  if (set.next && rolloverDue(set.next, now) && pinned.includes(set.next.kid)) return set.next;
  if (pinned.includes(set.current.kid)) return set.current;
  if (set.next && pinned.includes(set.next.kid)) return set.next;
  return activeSigningKey(set, now);
}

/**
 * The successors to announce in a frame signed under `signingKid`: never
 * that kid itself, which agents reject as malformed.
 *
 * @param set - The key set.
 * @param signingKid - Kid of the frame's envelope.
 * @returns At most one announcement (empty when nothing is scheduled).
 */
export function announcementsFor(set: SigningKeySet, signingKid: string): SigningKeyAnnouncement[] {
  if (!set.next || set.next.kid === signingKid) return [];
  return [{ kid: set.next.kid, public_key: set.next.publicKey, not_before: set.next.notBefore }];
}

// -----------------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------------

/**
 * A fresh signing key id: time-ordered, with a random suffix so two keys
 * made in the same millisecond still differ.
 */
function newKid(now: number): string {
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `k${now.toString(36)}${suffix}`;
}

async function sealedPair(
  keys: KeyEnv,
  settingKey: string,
  now: number,
): Promise<StoredSigningKey> {
  const pair = await generateSigningKey();
  return {
    kid: newKid(now),
    public_key: pair.publicKey,
    private_key: await sealInstanceSecret(keys, pair.privateKey, settingKey),
  };
}

/**
 * Generates and stores the first control-plane signing key at setup. The
 * private half is sealed under the master-derived KEK.
 *
 * @param db - Database client.
 * @param keys - The master keyring bindings (`c.env`).
 * @returns The new public key, base64.
 */
export async function createSigningKey(db: Db, keys: KeyEnv): Promise<string> {
  const value = await sealedPair(keys, SettingKey.signingKey, Date.now());
  await db
    .insert(instanceSettings)
    .values({ key: SettingKey.signingKey, value })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value } });
  invalidateSigningKeys();
  return value.public_key;
}

/** A successor as reported by the API; never includes private material. */
export interface ScheduledSigningKey {
  kid: string;
  publicKey: string;
  /** Unix seconds. */
  notBefore: number;
}

/**
 * Generates a successor signing key and schedules the switch to it.
 *
 * @param db - Database client.
 * @param keys - The master keyring bindings.
 * @param options - When to switch (`notBefore`, unix seconds) and who asked.
 * @returns The scheduled key, or `null` when a rollover is already scheduled.
 */
export async function scheduleSigningKeyRollover(
  db: Db,
  keys: KeyEnv,
  options: { notBefore: number; scheduledBy: string | null; now?: number },
): Promise<ScheduledSigningKey | null> {
  const now = options.now ?? Date.now();
  const pair = await sealedPair(keys, SettingKey.signingKeyNext, now);
  const value: StoredNextSigningKey = {
    ...pair,
    not_before: options.notBefore,
    scheduled_at: now,
    scheduled_by: options.scheduledBy,
  };
  const [row] = await db
    .insert(instanceSettings)
    .values({ key: SettingKey.signingKeyNext, value })
    .onConflictDoNothing({ target: instanceSettings.key })
    .returning({ key: instanceSettings.key });
  invalidateSigningKeys();
  return row ? { kid: pair.kid, publicKey: pair.public_key, notBefore: options.notBefore } : null;
}

const rawText = sql<string>`CAST(${instanceSettings.value} AS TEXT)`;

/** Why a rollover couldn't be completed or cancelled. */
export type RolloverRefusal =
  /** Nothing is scheduled. */
  | "none"
  /** Completing: `not_before` hasn't passed. Cancelling: it has. */
  | "not_due"
  | "already_due"
  /** A concurrent write (another completion, or a master-key re-wrap) won; retry. */
  | "conflict";

async function readRaw(db: Db, key: string) {
  const [row] = await db
    .select({ raw: rawText })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, key))
    .limit(1);
  return row?.raw;
}

/**
 * Promotes the due successor to current and retires the old key, deleting
 * its private half. Agents that never pinned the successor can no longer
 * verify frames afterwards.
 *
 * @param db - Database client.
 * @param keys - The master keyring bindings.
 * @param now - Current time, unix ms.
 * @returns The new and retired kids, or why nothing changed.
 */
export async function completeSigningKeyRollover(
  db: Db,
  keys: KeyEnv,
  now = Date.now(),
): Promise<{ ok: true; kid: string; retiredKid: string } | { ok: false; reason: RolloverRefusal }> {
  const [currentRaw, nextRaw] = await Promise.all([
    readRaw(db, SettingKey.signingKey),
    readRaw(db, SettingKey.signingKeyNext),
  ]);
  if (currentRaw === undefined || nextRaw === undefined) return { ok: false, reason: "none" };
  const current = StoredSigningKeySchema.parse(JSON.parse(currentRaw));
  const next = StoredNextSigningKeySchema.parse(JSON.parse(nextRaw));
  if (!rolloverDue({ notBefore: next.not_before }, now)) return { ok: false, reason: "not_due" };

  // The AAD names the setting, so moving the key between settings re-seals it.
  const pkcs8 = await unsealInstanceSecret(keys, next.private_key, SettingKey.signingKeyNext);
  const promoted: StoredSigningKey = {
    kid: next.kid,
    public_key: next.public_key,
    private_key: await sealInstanceSecret(keys, pkcs8, SettingKey.signingKey),
  };
  const retired = StoredRetiredSigningKeySchema.parse({
    kid: current.kid,
    public_key: current.public_key,
    retired_at: now,
  });
  const nextUnchanged = sql`EXISTS (SELECT 1 FROM instance_settings AS n WHERE n.key = ${SettingKey.signingKeyNext} AND CAST(n.value AS TEXT) = ${nextRaw})`;
  // D1 runs a batch as one transaction. Both statements compare-and-swap on
  // what was read above, and the delete only runs once the promotion landed,
  // so a concurrent completion or master-key re-wrap leaves both rows alone.
  const [promotedRows] = await db.batch([
    db
      .update(instanceSettings)
      .set({ value: promoted, updatedAt: new Date(now) })
      .where(
        and(
          eq(instanceSettings.key, SettingKey.signingKey),
          sql`${rawText} = ${currentRaw}`,
          nextUnchanged,
        ),
      )
      .returning({ key: instanceSettings.key }),
    db
      .delete(instanceSettings)
      .where(
        and(
          eq(instanceSettings.key, SettingKey.signingKeyNext),
          sql`${rawText} = ${nextRaw}`,
          sql`EXISTS (SELECT 1 FROM instance_settings AS c WHERE c.key = ${SettingKey.signingKey} AND json_extract(c.value, '$.kid') = ${next.kid})`,
        ),
      ),
  ]);
  invalidateSigningKeys();
  if (promotedRows.length === 0) return { ok: false, reason: "conflict" };
  // NOTE: informational only (the dashboard names the retired kid), so it
  // needn't be atomic with the promotion.
  await putSetting(db, SettingKey.signingKeyRetired, retired);
  return { ok: true, kid: next.kid, retiredKid: current.kid };
}

/**
 * Withdraws a successor whose `not_before` hasn't passed. Agents forget it
 * at their next welcome.
 *
 * @param db - Database client.
 * @param now - Current time, unix ms.
 * @returns The withdrawn kid, or why nothing changed.
 */
export async function cancelSigningKeyRollover(
  db: Db,
  now = Date.now(),
): Promise<{ ok: true; kid: string } | { ok: false; reason: RolloverRefusal }> {
  const raw = await readRaw(db, SettingKey.signingKeyNext);
  if (raw === undefined) return { ok: false, reason: "none" };
  const next = StoredNextSigningKeySchema.parse(JSON.parse(raw));
  // SECURITY: once due, agents may already have switched to it and dropped
  // the old kid; withdrawing it then would strand them.
  if (rolloverDue({ notBefore: next.not_before }, now)) return { ok: false, reason: "already_due" };
  const deleted = await db
    .delete(instanceSettings)
    .where(and(eq(instanceSettings.key, SettingKey.signingKeyNext), sql`${rawText} = ${raw}`))
    .returning({ key: instanceSettings.key });
  invalidateSigningKeys();
  return deleted.length ? { ok: true, kid: next.kid } : { ok: false, reason: "conflict" };
}

// -----------------------------------------------------------------------------
// Status
// -----------------------------------------------------------------------------

/** One node's view of the signing keys. */
export interface NodeSigningKeys {
  id: string;
  name: string;
  workspaceId: string;
  protocolVersion: number;
  /** Kids it pins, as last reported or announced; `null` when never known. */
  pinnedKids: string[] | null;
  connected: boolean;
  /** Last hello or heartbeat, unix ms; `null` if it never connected. */
  lastSeenAt: number | null;
}

/** Everything `GET /v1/instance/signing-keys` reports, without private keys. */
export interface SigningKeyStatus {
  current: { kid: string; publicKey: string };
  next: (ScheduledSigningKey & { scheduledAt: number; scheduledBy: string | null }) | null;
  retired: { kid: string; publicKey: string; retiredAt: number } | null;
  nodes: NodeSigningKeys[];
}

/**
 * Reads the stored keys and every live node's pinned kids.
 *
 * @param db - Database client.
 * @param isConnected - Whether a node row counts as connected now.
 * @returns The status.
 * @throws When setup hasn't created a key yet.
 */
export async function signingKeyStatus(
  db: Db,
  isConnected: (node: typeof nodes.$inferSelect) => boolean,
): Promise<SigningKeyStatus> {
  const [rawCurrent, rawNext, rawRetired, rows] = await Promise.all([
    getSetting<unknown>(db, SettingKey.signingKey),
    getSetting<unknown>(db, SettingKey.signingKeyNext),
    getSetting<unknown>(db, SettingKey.signingKeyRetired),
    db.select().from(nodes).where(sql`${nodes.deletedAt} IS NULL`).orderBy(nodes.createdAt),
  ]);
  if (rawCurrent === undefined) throw new Error("signing key not initialised; run setup first");
  const current = StoredSigningKeySchema.parse(rawCurrent);
  const next = rawNext === undefined ? null : StoredNextSigningKeySchema.parse(rawNext);
  const retired = rawRetired === undefined ? null : StoredRetiredSigningKeySchema.parse(rawRetired);
  return {
    current: { kid: current.kid, publicKey: current.public_key },
    next: next && {
      kid: next.kid,
      publicKey: next.public_key,
      notBefore: next.not_before,
      scheduledAt: next.scheduled_at,
      scheduledBy: next.scheduled_by,
    },
    retired: retired && {
      kid: retired.kid,
      publicKey: retired.public_key,
      retiredAt: retired.retired_at,
    },
    nodes: rows.map((n) => ({
      id: n.id,
      name: n.name,
      workspaceId: n.workspaceId,
      protocolVersion: n.protocolVersion,
      pinnedKids: n.pinnedSigningKids ?? null,
      connected: isConnected(n),
      lastSeenAt: n.lastHeartbeatAt ? +n.lastHeartbeatAt : null,
    })),
  };
}
