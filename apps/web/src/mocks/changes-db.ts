/**
 * Change sets, canvas layouts and explicit canvas edges of the mock database (ADR 0006),
 * and their API views. Row shapes follow the API's wire types; staged variable values are
 * kept in the row (the API seals them) so the mock can apply them, and are never part of
 * a view.
 *
 * Approval: no seeded environment requires one, so existing flows apply directly. Turn
 * it on with `requireApprovalIn` from `./changes-handlers` (or set
 * `db.changes.requireApproval[environmentId] = true` on a protected environment); the
 * seeded production environments (`SEED.production`, `SEED.toolsProduction`) are already
 * protected.
 *
 * @module
 */
import type { ServiceEdge } from "../../../api/src/contracts";
import type {
  CanvasPositions,
  ChangeSet,
  ChangeSetSummary,
  StagedChange,
} from "../lib/api/changes-types";

/** One staged op, with the value a `variable.set` carries. */
export interface DbStagedChange extends StagedChange {
  /** Plaintext of a staged `variable.set`; the API seals it and never returns it. */
  value?: string;
  /** Config or variable version the op was staged against. */
  base_version: number | null;
}

/** Review fields a stored set may leave out; {@link toSummary} fills them in. */
type ReviewFields =
  | "review_status"
  | "submitted_by"
  | "submitted_at"
  | "approved_by"
  | "approved_at"
  | "rejected_by"
  | "rejected_at"
  | "review_note";

/** A change set row. */
export type DbChangeSet = Omit<ChangeSetSummary, "op_count" | "conflicted_count" | ReviewFields> &
  Partial<Pick<ChangeSetSummary, ReviewFields>> & {
    changes: DbStagedChange[];
    /** The revision an approval covers; never part of a view. */
    approved_revision?: number | null;
  };

/** Change set tables. */
export interface ChangesDb {
  sets: DbChangeSet[];
  /** Canvas positions and version by project id. */
  layouts: Record<string, { positions: CanvasPositions; version: number }>;
  /** Explicit "connects to" edges, oldest first. */
  edges: ServiceEdge[];
  /**
   * The `require_approval` protection setting by environment id. Like the API's, it only
   * takes effect while the environment is `protected`.
   */
  requireApproval: Record<string, boolean>;
}

/**
 * An empty change set store.
 *
 * @returns The tables.
 */
export function emptyChanges(): ChangesDb {
  return { sets: [], layouts: {}, edges: [], requireApproval: {} };
}

/**
 * Whether a set holds an approval of its current revision.
 *
 * @param set - The row.
 * @returns `true` when approved at its revision.
 */
export function hasValidApproval(set: DbChangeSet): boolean {
  return (
    set.review_status === "approved" &&
    set.approved_by != null &&
    set.approved_revision === set.revision
  );
}

/**
 * Stand-in for the API's keyed fingerprint (FNV-1a, 8 hex), the same one the variables
 * mock uses, so a staged value and a stored one compare.
 *
 * @param value - Raw value.
 * @returns 8 hex characters.
 */
export function mockFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * A set's summary view.
 *
 * @param set - The row.
 * @returns `ChangeSetSummary`.
 */
export function toSummary(set: DbChangeSet): ChangeSetSummary {
  const { changes, approved_revision: _approvedRevision, ...rest } = set;
  const live = changes.filter((c) => c.status !== "applied");
  // NOTE: Like the API, an approval stored for another revision reads as `submitted`.
  const stale = rest.review_status === "approved" && !hasValidApproval(set);
  return {
    ...rest,
    review_status: stale ? "submitted" : (rest.review_status ?? "none"),
    submitted_by: rest.submitted_by ?? null,
    submitted_at: rest.submitted_at ?? null,
    approved_by: rest.approved_by ?? null,
    approved_at: rest.approved_at ?? null,
    rejected_by: rest.rejected_by ?? null,
    rejected_at: rest.rejected_at ?? null,
    review_note: rest.review_note ?? null,
    op_count: set.status === "applied" ? changes.length : live.length,
    conflicted_count: live.filter((c) => c.status === "conflicted").length,
  };
}

/**
 * A set's full view; staged values never leave the mock.
 *
 * @param set - The row.
 * @returns `ChangeSet`.
 */
export function toChangeSet(set: DbChangeSet): ChangeSet {
  return {
    ...toSummary(set),
    changes: set.changes.map(({ value: _value, base_version: _base, ...change }) => change),
  };
}
