/**
 * Change sets and canvas layouts of the mock database (ADR 0006), and their API views.
 * Row shapes follow the API's wire types; staged variable values are kept in the row
 * (the API seals them) so the mock can apply them, and are never part of a view.
 *
 * @module
 */
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

/** A change set row. */
export type DbChangeSet = Omit<ChangeSetSummary, "op_count" | "conflicted_count"> & {
  changes: DbStagedChange[];
};

/** Change set tables. */
export interface ChangesDb {
  sets: DbChangeSet[];
  /** Canvas positions and version by project id. */
  layouts: Record<string, { positions: CanvasPositions; version: number }>;
}

/**
 * An empty change set store.
 *
 * @returns The tables.
 */
export function emptyChanges(): ChangesDb {
  return { sets: [], layouts: {} };
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
  const { changes, ...rest } = set;
  const live = changes.filter((c) => c.status !== "applied");
  return {
    ...rest,
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
