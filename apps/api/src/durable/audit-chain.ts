/**
 * `AuditChain`: the single writer of the audit log's hash chain (ADR 0014
 * "Audit log"). One instance, `idFromName("global")`.
 *
 * Rows are inserted by `auditInsert` inside the batch of the action they
 * record, with `seq` but no hash. This object then seals them in `seq`
 * order: `prev_hash` = the previous entry's `hash`, `hash` = `auditEntryHash`.
 * Being the only writer of those two columns is what keeps the chain from
 * forking under concurrent requests.
 *
 * Owned by the api-authz-rbac-github stream; the methods below are the
 * contract, not yet implemented.
 *
 * @module
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

/** Result of one {@link AuditChain.seal} pass. */
export interface SealResult {
  /** Entries sealed by this pass. */
  sealed: number;
  /** `seq` of the newest sealed entry. */
  headSeq: number;
  headHash: string | null;
}

/** Serialises sealing of the audit chain. */
export class AuditChain extends DurableObject<Env> {
  /**
   * Seals every unsealed entry, oldest first, in batches of 100. Called with
   * `ctx.waitUntil` after each audited request, and by an alarm every minute
   * as a safety net.
   *
   * @returns What was sealed.
   */
  async seal(): Promise<SealResult> {
    // TODO(api-authz-rbac-github): implement (ADR 0014 "Audit log").
    return { sealed: 0, headSeq: 0, headHash: null };
  }
}
