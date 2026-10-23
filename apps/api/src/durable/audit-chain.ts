/**
 * `AuditChain`: the single writer of the audit log's hash chain (ADR 0014
 * "Audit log"). One instance, `idFromName("global")`.
 *
 * Rows are inserted by `auditInsert` inside the batch of the action they
 * record, with `seq` but no hash. This object then seals them in `seq`
 * order: `prev_hash` = the previous entry's `hash`, `hash` =
 * `auditEntryHash`. Being the only writer of those two columns is what keeps
 * the chain from forking under concurrent requests.
 *
 * It also keeps, in its own storage where database access can't reach, the
 * newest sealed entry (the head) and a checkpoint every
 * {@link CHECKPOINT_EVERY} entries or {@link CHECKPOINT_INTERVAL_MS}. A
 * rewrite of the log that recomputes every later hash still disagrees with
 * them (see `verifyAuditChain`).
 *
 * The Worker's per-minute cron calls {@link AuditChain.seal}, and the verify
 * route seals before it verifies.
 *
 * @module
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import {
  auditEntryHash,
  type ChainPoint,
  type ChainState,
  GENESIS_HASH,
  RAW_AUDIT_COLUMNS,
  type RawAuditRow,
} from "../lib/audit-chain";

/** Entries sealed per D1 batch. */
export const SEAL_BATCH = 100;

/** Entries between checkpoints. */
export const CHECKPOINT_EVERY = 1000;

/** Longest time between checkpoints while entries are being sealed. */
export const CHECKPOINT_INTERVAL_MS = 60 * 60 * 1000;

/** Checkpoints kept; the oldest are dropped past this. */
export const MAX_CHECKPOINTS = 5000;

const HEAD_KEY = "head";
const CHECKPOINT_PREFIX = "checkpoint:";

/** Result of one {@link AuditChain.seal} pass. */
export interface SealResult {
  /** Entries sealed by this pass. */
  sealed: number;
  /** `seq` of the newest sealed entry. */
  headSeq: number;
  headHash: string | null;
}

const checkpointKey = (seq: number) => `${CHECKPOINT_PREFIX}${String(seq).padStart(16, "0")}`;

/** Serialises sealing of the audit chain. */
export class AuditChain extends DurableObject<Env> {
  // D1 calls let other requests interleave inside this object, so passes
  // are queued explicitly; two concurrent passes would fork the chain.
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Seals every unsealed entry, oldest first, in batches of
   * {@link SEAL_BATCH}. Concurrent calls run one after another.
   *
   * @returns What was sealed.
   */
  async seal(): Promise<SealResult> {
    const run = this.queue.then(() => this.sealPass());
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * The head and checkpoints this object recorded, for verification.
   *
   * @returns The chain state; empty before the first seal.
   */
  async state(): Promise<ChainState> {
    const head = (await this.ctx.storage.get<ChainPoint>(HEAD_KEY)) ?? null;
    const checkpoints = [
      ...(await this.ctx.storage.list<ChainPoint>({ prefix: CHECKPOINT_PREFIX })).values(),
    ];
    return { head, checkpoints };
  }

  private async sealPass(): Promise<SealResult> {
    const d1 = this.env.DB;
    let head = await d1
      .prepare("SELECT seq, hash FROM audit_logs WHERE hash IS NOT NULL ORDER BY seq DESC LIMIT 1")
      .first<{ seq: number; hash: string }>();
    let sealed = 0;
    for (;;) {
      const { results } = await d1
        .prepare(
          `SELECT ${RAW_AUDIT_COLUMNS} FROM audit_logs WHERE hash IS NULL ORDER BY seq LIMIT ${SEAL_BATCH}`,
        )
        .all<RawAuditRow>();
      if (!results.length) break;
      // NOTE: seq is assigned as MAX(seq) + 1 inside each insert and D1
      // commits serially, so nothing unsealed sits below the head unless a
      // row was edited by hand. Sealing it would hide that; leave it for
      // verification to report.
      const fresh = results.filter((r) => !head || r.seq > head.seq);
      if (!fresh.length) {
        console.error("audit chain: unsealed entries below the head", results[0]!.seq);
        break;
      }
      const statements: D1PreparedStatement[] = [];
      for (const row of fresh) {
        const prev = head?.hash ?? GENESIS_HASH;
        const hash = await auditEntryHash(row, prev);
        statements.push(
          d1
            .prepare("UPDATE audit_logs SET prev_hash = ?, hash = ? WHERE id = ? AND hash IS NULL")
            .bind(prev, hash, row.id),
        );
        head = { seq: row.seq, hash };
      }
      await d1.batch(statements);
      sealed += fresh.length;
      if (fresh.length < results.length || results.length < SEAL_BATCH) break;
    }
    if (sealed && head) await this.record({ ...head, at: Date.now() });
    return { sealed, headSeq: head?.seq ?? 0, headHash: head?.hash ?? null };
  }

  /** Stores the new head, and a checkpoint when one is due. */
  private async record(point: ChainPoint): Promise<void> {
    const storage = this.ctx.storage;
    await storage.put(HEAD_KEY, point);
    const [last] = (
      await storage.list<ChainPoint>({ prefix: CHECKPOINT_PREFIX, reverse: true, limit: 1 })
    ).values();
    if (
      last &&
      point.seq - last.seq < CHECKPOINT_EVERY &&
      point.at - last.at < CHECKPOINT_INTERVAL_MS
    ) {
      return;
    }
    await storage.put(checkpointKey(point.seq), point);
    const all = await storage.list<ChainPoint>({ prefix: CHECKPOINT_PREFIX });
    const excess = all.size - MAX_CHECKPOINTS;
    if (excess > 0) await storage.delete([...all.keys()].slice(0, excess));
  }
}
