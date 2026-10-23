/**
 * The audit log's hash chain (ADR 0014 "Audit log"): the canonical hash of
 * an entry, and verification of the whole chain against the checkpoints the
 * `AuditChain` Durable Object keeps outside D1.
 *
 * Every sealed entry carries `prev_hash` (the previous entry's `hash`, 64
 * zeros for the first) and `hash` = lowercase hex SHA-256 of UTF-8
 * `JSON.stringify(["roundhouse-audit:v1", seq, prev_hash, id, workspace_id,
 * actor_type, actor_id, action, target_type, target_id, metadata, ip,
 * created_at])`, with `metadata` as the stored text and `created_at` as the
 * stored integer, so verifying needs no canonical JSON.
 *
 * The chain alone shows that rows were edited, removed or reordered, but not
 * a rewrite that recomputes every later hash; the checkpoints (and the head)
 * held by the Durable Object, which nothing with only database access can
 * change, catch that.
 *
 * @module
 */

/** Name of the single `AuditChain` Durable Object (`idFromName`). */
export const AUDIT_CHAIN_NAME = "global";

/** Version tag hashed into every entry. */
export const AUDIT_HASH_VERSION = "roundhouse-audit:v1";

/** `prev_hash` of the first chained entry. */
export const GENESIS_HASH = "0".repeat(64);

/** An audit row exactly as D1 stores it. */
export interface RawAuditRow {
  id: string;
  seq: number;
  workspace_id: string | null;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  /** The stored JSON text, not re-serialised. */
  metadata: string | null;
  ip: string | null;
  /** Unix ms, as stored. */
  created_at: number;
  prev_hash: string | null;
  hash: string | null;
}

/** Columns of {@link RawAuditRow}, for raw D1 queries. */
export const RAW_AUDIT_COLUMNS =
  "id, seq, workspace_id, actor_type, actor_id, action, target_type, target_id, metadata, ip, created_at, prev_hash, hash";

/** A sealed position of the chain, recorded by the `AuditChain` Durable Object. */
export interface ChainPoint {
  seq: number;
  hash: string;
  /** Unix ms when it was recorded. */
  at: number;
}

/** What the `AuditChain` Durable Object knows about the chain. */
export interface ChainState {
  /** The newest entry it sealed; `null` before the first seal. */
  head: ChainPoint | null;
  /** Periodic checkpoints, oldest first. */
  checkpoints: ChainPoint[];
}

/**
 * Hash of one entry chained after `prevHash`.
 *
 * @param row - The entry as stored.
 * @param prevHash - `hash` of the previous entry, or {@link GENESIS_HASH}.
 * @returns Lowercase hex SHA-256.
 * @example
 * await auditEntryHash(row, GENESIS_HASH); // "3f1c…"
 */
export async function auditEntryHash(
  row: Omit<RawAuditRow, "prev_hash" | "hash">,
  prevHash: string,
): Promise<string> {
  const canonical = JSON.stringify([
    AUDIT_HASH_VERSION,
    row.seq,
    prevHash,
    row.id,
    row.workspace_id,
    row.actor_type,
    row.actor_id,
    row.action,
    row.target_type,
    row.target_id,
    row.metadata,
    row.ip,
    row.created_at,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Outcome of {@link verifyAuditChain}, shaped like `AuditChainVerificationSchema`. */
export interface ChainVerification {
  ok: boolean;
  /** Sealed entries whose hash and link were recomputed. */
  checked: number;
  head_seq: number;
  head_hash: string | null;
  /** The first entry that doesn't match, when not `ok`. */
  broken_at_seq: number | null;
  /** Entries not sealed yet. */
  unsealed: number;
  /** Durable Object checkpoints compared with the log, the head included. */
  checkpoints: number;
}

/** Rows read per query while verifying. */
const VERIFY_PAGE = 500;

/**
 * Recomputes the whole chain, oldest first, and compares it with the
 * Durable Object's head and checkpoints.
 *
 * An entry breaks the chain when its `seq` doesn't follow the previous one
 * (a row was removed), its `prev_hash` isn't the previous `hash`, its `hash`
 * doesn't match its content, it is sealed after an unsealed entry, or it no
 * longer has the hash a checkpoint recorded for its `seq`. A head newer than
 * the newest sealed entry means the end of the log was cut off.
 *
 * @param d1 - The D1 binding.
 * @param state - Head and checkpoints from the `AuditChain` Durable Object.
 * @returns The verification report; `broken_at_seq` is the lowest break found.
 */
export async function verifyAuditChain(
  d1: D1Database,
  state: ChainState,
): Promise<ChainVerification> {
  const breaks: number[] = [];
  const known = new Map<number, string>();
  for (const p of [...state.checkpoints, ...(state.head ? [state.head] : [])]) {
    known.set(p.seq, p.hash);
  }
  let prevSeq = 0;
  let prevHash = GENESIS_HASH;
  let checked = 0;
  let unsealed = 0;
  let head: { seq: number; hash: string } | null = null;
  const matched = new Set<number>();
  for (let after = 0; ; ) {
    const { results } = await d1
      .prepare(
        `SELECT ${RAW_AUDIT_COLUMNS} FROM audit_logs WHERE seq > ? ORDER BY seq LIMIT ${VERIFY_PAGE}`,
      )
      .bind(after)
      .all<RawAuditRow>();
    for (const row of results) {
      if (row.seq !== prevSeq + 1) breaks.push(row.seq);
      prevSeq = row.seq;
      if (row.hash === null) {
        unsealed++;
        continue;
      }
      if (unsealed > 0) breaks.push(row.seq);
      const expected = await auditEntryHash(row, row.prev_hash ?? GENESIS_HASH);
      if (row.prev_hash !== prevHash || row.hash !== expected) breaks.push(row.seq);
      const recorded = known.get(row.seq);
      if (recorded !== undefined) {
        matched.add(row.seq);
        if (recorded !== row.hash) breaks.push(row.seq);
      }
      checked++;
      prevHash = row.hash;
      head = { seq: row.seq, hash: row.hash };
    }
    if (results.length < VERIFY_PAGE) break;
    after = results.at(-1)!.seq;
  }
  for (const seq of known.keys()) {
    if (!matched.has(seq)) breaks.push(Math.min(seq, (head?.seq ?? 0) + 1));
  }
  const brokenAt = breaks.length ? Math.min(...breaks) : null;
  return {
    ok: brokenAt === null,
    checked,
    head_seq: head?.seq ?? 0,
    head_hash: head?.hash ?? null,
    broken_at_seq: brokenAt,
    unsealed,
    checkpoints: known.size,
  };
}
