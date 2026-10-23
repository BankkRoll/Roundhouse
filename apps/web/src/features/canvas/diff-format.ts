/**
 * How staged changes read in review: grouping by service and value-free rendering of
 * each side of a diff. Pure, so it is unit-tested apart from React.
 *
 * @module
 */
import { type StagedOp, serviceOfOp } from "@roundhouse/shared";
import type { DiffEntry, StagedChange } from "../../lib/api/changes-types";

/** Shown for an absent value. */
export const ABSENT = "—";

/**
 * Renders one side of a diff entry. Variables arrive as `{ tier, fingerprint }` and are
 * shown by fingerprint only; masked build args stay masked.
 *
 * @param value - `before` or `after` of a {@link DiffEntry}.
 * @returns Display text.
 * @example
 * formatSide({ tier: "secret", fingerprint: "a1b2c3d4" }); // "secret · a1b2c3d4"
 */
export function formatSide(value: unknown): string {
  if (value === null || value === undefined) return ABSENT;
  if (typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (v.masked === true) return "••••••";
    if (typeof v.fingerprint === "string" && typeof v.tier === "string") {
      return `${v.tier} · ${v.fingerprint}`;
    }
  }
  if (typeof value === "string") return value === "" ? '""' : value;
  return JSON.stringify(value);
}

/**
 * A diff path as a reader would say it: `/deploy/replicas` → `deploy.replicas`,
 * `/variables/API_KEY` → `API_KEY`.
 *
 * @param path - A JSON pointer.
 * @returns The label.
 */
export function pathLabel(path: string): string {
  if (path.startsWith("/variables/")) return path.slice("/variables/".length);
  return path.replace(/^\//, "").replace(/\//g, ".").replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Changes about one service (or the environment's shared variables). */
export interface ChangeGroup {
  /** Service id, `new:<n>`, or `shared`. */
  key: string;
  name: string;
  changes: StagedChange[];
}

/**
 * Groups a set's changes by the service they touch, in first-seen order.
 *
 * @param changes - Staged changes in apply order.
 * @param nameOf - Display name of a service id or `new:<n>`.
 * @returns One group per service, plus `shared` for shared variables.
 */
export function groupChanges(
  changes: readonly StagedChange[],
  nameOf: (ref: string) => string,
): ChangeGroup[] {
  const groups = new Map<string, ChangeGroup>();
  for (const change of changes) {
    const key = serviceOfOp(change.op as StagedOp) ?? "shared";
    const group = groups.get(key) ?? {
      key,
      name: key === "shared" ? "Shared variables" : nameOf(key),
      changes: [],
    };
    group.changes.push(change);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Counts what a set does, for the staged bar.
 *
 * @param count - Number of staged changes.
 * @returns e.g. `1 change`, `3 changes`.
 */
export function changeCount(count: number): string {
  return `${count} change${count === 1 ? "" : "s"}`;
}

/**
 * Whether a diff entry is about a variable.
 *
 * @param entry - A diff entry.
 * @returns `true` for `/variables/*`.
 */
export function isVariableEntry(entry: DiffEntry): boolean {
  return entry.path.startsWith("/variables/");
}
