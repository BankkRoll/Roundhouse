/**
 * The node Durable Object's side of the data browser (ADR 0004, "Data
 * browser and query runner"): correlates `db_query_result` frames with the
 * `runQuery` calls waiting for them.
 *
 * Results live only in memory, for as long as the call that asked waits:
 * nothing here is persisted, so query results are never stored.
 *
 * @module
 */
import type { DbQueryResult } from "@roundhouse/protocol";

/** Queries one node runs at once (ADR 0004, "Limits"); more are refused as `busy`. */
export const MAX_QUERIES_PER_NODE = 4;

interface Waiter {
  resolve(result: DbQueryResult | null): void;
  timer: ReturnType<typeof setTimeout>;
}

/** `runQuery` calls waiting for their `db_query_result`, keyed by `request_id`. */
export class PendingQueries {
  private waiters = new Map<string, Waiter>();

  /** Calls waiting now. */
  get size(): number {
    return this.waiters.size;
  }

  /**
   * Registers a request before its frame is sent, so an answer arriving
   * straight away is not missed.
   *
   * @param requestId - The frame's `request_id`.
   * @param timeoutMs - How long to wait.
   * @returns The result, or `null` on timeout or {@link cancel}.
   * @throws When the request ID is already waiting.
   */
  wait(requestId: string, timeoutMs: number): Promise<DbQueryResult | null> {
    if (this.waiters.has(requestId)) throw new Error(`duplicate request ${requestId}`);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.waiters.set(requestId, { resolve, timer });
    });
  }

  /**
   * Hands a result to its waiting call. A result nobody waits for (late,
   * or never asked for) is dropped.
   *
   * @param result - The validated frame.
   * @returns Whether a call was waiting for it.
   */
  settle(result: DbQueryResult): boolean {
    const w = this.waiters.get(result.request_id);
    if (!w) return false;
    this.waiters.delete(result.request_id);
    clearTimeout(w.timer);
    w.resolve(result);
    return true;
  }

  /**
   * Gives up on one request, e.g. when its frame could not be sent.
   *
   * @param requestId - The request.
   */
  cancel(requestId: string): void {
    const w = this.waiters.get(requestId);
    if (!w) return;
    this.waiters.delete(requestId);
    clearTimeout(w.timer);
    w.resolve(null);
  }
}

/** Queries one user may start per second (ADR 0004, "Limits"). */
export const MAX_QUERIES_PER_USER_PER_S = 2;

/** Users whose recent queries one limiter remembers. */
const LIMITER_USERS = 1024;

/** A per-user sliding one-second window over query starts. */
export class UserQueryLimiter {
  private starts = new Map<string, number[]>();

  /**
   * Counts a query start, unless the user is over the limit.
   *
   * @param userId - The caller.
   * @param now - Unix ms.
   * @returns Whether the query may run.
   */
  admit(userId: string, now: number): boolean {
    const recent = (this.starts.get(userId) ?? []).filter((t) => now - t < 1000);
    if (recent.length >= MAX_QUERIES_PER_USER_PER_S) {
      this.starts.set(userId, recent);
      return false;
    }
    if (!this.starts.has(userId) && this.starts.size >= LIMITER_USERS) this.starts.clear();
    recent.push(now);
    this.starts.set(userId, recent);
    return true;
  }
}
