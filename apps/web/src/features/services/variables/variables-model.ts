/**
 * Staged edits to a service's variables, and the `${{` reference autocomplete.
 *
 * Edits stay local until Save, which sends them as one `PUT` (a new version on the API).
 * Everything here is pure so the editor's rules are tested without rendering.
 *
 * @module
 */
import { BUILTIN_VARIABLES, parseReferences, SHARED_NAMESPACE } from "@roundhouse/shared";
import type { Variable, VariablesPutBody } from "../../../lib/api/deploy-types";

/** A value staged for a key. */
export interface StagedValue {
  value: string;
  isSecret: boolean;
}

/** Local, unsaved changes. */
export interface VariablesDraft {
  set: ReadonlyMap<string, StagedValue>;
  remove: ReadonlySet<string>;
}

/** No changes. */
export const EMPTY_DRAFT: VariablesDraft = { set: new Map(), remove: new Set() };

/** One row of the editor: the saved variable with any staged change applied. */
export interface VariableRow {
  key: string;
  /** Plain value; `null` for a saved secret (write-only) unless re-entered. */
  value: string | null;
  isSecret: boolean;
  /**
   * Saved value's fingerprint (ADR 0014), the only trace of a secret the dashboard
   * gets; `null` once a new value is staged or for rows not yet backfilled.
   */
  fingerprint: string | null;
  change: "none" | "added" | "changed" | "deleted";
  /** Saved version, when the key exists on the server. */
  version?: number;
}

/**
 * Stages a value for a key, cancelling a staged delete of it.
 *
 * @param draft - Current draft.
 * @param key - Variable name.
 * @param value - New value and secret flag.
 * @returns The new draft.
 */
export function stageSet(draft: VariablesDraft, key: string, value: StagedValue): VariablesDraft {
  const set = new Map(draft.set);
  set.set(key, value);
  const remove = new Set(draft.remove);
  remove.delete(key);
  return { set, remove };
}

/**
 * Stages a delete. A key that only exists in the draft is simply dropped.
 *
 * @param draft - Current draft.
 * @param key - Variable name.
 * @param saved - Whether the key exists on the server.
 * @returns The new draft.
 */
export function stageDelete(draft: VariablesDraft, key: string, saved: boolean): VariablesDraft {
  const set = new Map(draft.set);
  set.delete(key);
  const remove = new Set(draft.remove);
  if (saved) remove.add(key);
  return { set, remove };
}

/**
 * Undoes any staged change to a key.
 *
 * @param draft - Current draft.
 * @param key - Variable name.
 * @returns The new draft.
 */
export function unstage(draft: VariablesDraft, key: string): VariablesDraft {
  const set = new Map(draft.set);
  set.delete(key);
  const remove = new Set(draft.remove);
  remove.delete(key);
  return { set, remove };
}

/**
 * Number of keys with a staged change.
 *
 * @param draft - Current draft.
 * @returns The count.
 */
export function draftSize(draft: VariablesDraft): number {
  return draft.set.size + draft.remove.size;
}

/**
 * Merges saved variables with the draft, sorted by key.
 *
 * @param saved - Variables from the API (secrets masked).
 * @param draft - Staged changes.
 * @returns Editor rows.
 */
export function mergeRows(saved: readonly Variable[], draft: VariablesDraft): VariableRow[] {
  const rows = new Map<string, VariableRow>();
  for (const variable of saved) {
    const staged = draft.set.get(variable.key);
    rows.set(variable.key, {
      key: variable.key,
      value: staged ? staged.value : variable.value,
      isSecret: staged ? staged.isSecret : variable.tier === "secret",
      fingerprint: staged ? null : variable.fingerprint,
      change: draft.remove.has(variable.key) ? "deleted" : staged ? "changed" : "none",
      version: variable.version,
    });
  }
  for (const [key, staged] of draft.set) {
    if (rows.has(key)) continue;
    rows.set(key, {
      key,
      value: staged.value,
      isSecret: staged.isSecret,
      fingerprint: null,
      change: "added",
    });
  }
  return [...rows.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Builds the `PUT` body from the draft, in a stable order so API errors (`set.3.value`)
 * can be mapped back to a key.
 *
 * @param draft - Staged changes.
 * @returns The body, and the key of each `set` entry by index.
 */
export function toPutBody(draft: VariablesDraft): { body: VariablesPutBody; setKeys: string[] } {
  const setKeys = [...draft.set.keys()].sort();
  return {
    body: {
      set: setKeys.map((key) => {
        const staged = draft.set.get(key)!;
        return { key, value: staged.value, tier: staged.isSecret ? "secret" : "plain" };
      }),
      delete: [...draft.remove].sort(),
      // TODO(web): ask in a dialog listing the keys before confirming (ADR 0014).
      confirm_write_only: true,
    },
    setKeys,
  };
}

/** An API validation error tied to a staged key. */
export interface FieldError {
  key: string;
  field: "key" | "value" | "tier";
  message: string;
  /** Span of the problem in the value, when the API reports one. */
  start?: number;
  end?: number;
}

/**
 * Turns the API's per-field `details` (each malformed reference with its key and
 * span) into one error per key: the first problem found in that value.
 *
 * @param details - `error.details` of an `invalid_reference` response.
 * @returns Errors by variable key.
 */
export function errorsFromDetails(
  details: readonly { field: string; message: string; start?: number; end?: number }[],
): Record<string, FieldError> {
  const errors: Record<string, FieldError> = {};
  for (const detail of details) {
    if (errors[detail.field]) continue;
    errors[detail.field] = {
      key: detail.field,
      field: "value",
      message: detail.message,
      start: detail.start,
      end: detail.end,
    };
  }
  return errors;
}

/**
 * Maps an API `invalid_request` message (`set.2.value: …`, the API's `path: message`
 * format) back to the staged key it is about.
 *
 * @param message - The API error message.
 * @param setKeys - Keys in `set` order, from {@link toPutBody}.
 * @param removeKeys - Keys in `delete` order.
 * @returns The key-level error, or `null` when the message has no recognisable path.
 */
export function mapApiError(
  message: string,
  setKeys: readonly string[],
  removeKeys: readonly string[] = [],
): FieldError | null {
  const set = /^set\.(\d+)\.(key|value|tier): (.*)$/s.exec(message);
  if (set) {
    const key = setKeys[Number(set[1])];
    return key ? { key, field: set[2] as FieldError["field"], message: set[3] ?? message } : null;
  }
  const remove = /^delete\.(\d+): (.*)$/s.exec(message);
  if (remove) {
    const key = removeKeys[Number(remove[1])];
    return key ? { key, field: "key", message: remove[2] ?? message } : null;
  }
  return null;
}

/**
 * Reference syntax problems in a value, with their character spans, as the API reports
 * them on save.
 *
 * @param value - A variable value.
 * @returns Errors with `start`/`end` offsets.
 */
export function referenceErrors(value: string) {
  return parseReferences(value).errors;
}

// -----------------------------------------------------------------------------
// ${{ autocomplete
// -----------------------------------------------------------------------------

/** Opening of a variable reference. */
export const REFERENCE_OPEN = `\${{`;

/** Where the caret is inside an unfinished `${{ … }}`. */
export interface ReferenceContext {
  /** Offset just after `${{`. */
  start: number;
  /** What was typed after `${{`, trimmed of leading spaces. */
  query: string;
}

/**
 * Finds an unfinished reference that ends at the caret.
 *
 * @param value - Input value.
 * @param caret - Caret offset.
 * @returns The reference being typed, or `null` when the caret isn't inside one.
 * @example
 * referenceContext("postgres://${{db.HO", 19); // { start: 14, query: "db.HO" }
 */
export function referenceContext(value: string, caret: number): ReferenceContext | null {
  const before = value.slice(0, caret);
  const open = before.lastIndexOf(REFERENCE_OPEN);
  if (open === -1) return null;
  if (open > 0 && before[open - 1] === "$") return null;
  const inside = before.slice(open + 3);
  if (inside.includes("}}") || /[^\sA-Za-z0-9_.-]/.test(inside)) return null;
  return { start: open + 3, query: inside.trimStart() };
}

/** A suggestion in the reference autocomplete. */
export interface ReferenceSuggestion {
  /** Text inserted after `${{`. */
  insert: string;
  /** Shown in the list. */
  label: string;
  /** e.g. "service", "shared", "built-in", "this service". */
  detail: string;
  /** A namespace (`api.`) keeps the list open for its keys; a key closes the reference. */
  complete: boolean;
}

/** What the autocomplete can suggest. */
export interface ReferenceCatalog {
  /** Slugs of the other services in the environment. */
  services: readonly string[];
  /** Keys of this service. */
  ownKeys: readonly string[];
  /** Shared variable keys of the environment. */
  sharedKeys: readonly string[];
  /** Keys of other services, by slug, when loaded. */
  serviceKeys: Readonly<Record<string, readonly string[]>>;
}

/**
 * Suggestions for what is typed after `${{`: namespaces and this service's keys at
 * first, then a namespace's keys after `slug.`.
 *
 * @param query - Text typed after `${{`.
 * @param catalog - Known services and keys.
 * @param limit - Most suggestions to return.
 * @returns Matching suggestions, prefix matches first.
 */
export function referenceSuggestions(
  query: string,
  catalog: ReferenceCatalog,
  limit = 8,
): ReferenceSuggestion[] {
  const dot = query.indexOf(".");
  const matches = (candidate: string, typed: string) =>
    candidate.toLowerCase().startsWith(typed.toLowerCase());
  if (dot === -1) {
    const namespaces: ReferenceSuggestion[] = [SHARED_NAMESPACE, ...catalog.services].map(
      (slug) => ({
        insert: `${slug}.`,
        label: `${slug}.`,
        detail: slug === SHARED_NAMESPACE ? "shared variables" : "service",
        complete: false,
      }),
    );
    const own: ReferenceSuggestion[] = [...new Set([...catalog.ownKeys, ...BUILTIN_VARIABLES])].map(
      (key) => ({
        insert: key,
        label: key,
        detail: (BUILTIN_VARIABLES as readonly string[]).includes(key)
          ? "built-in"
          : "this service",
        complete: true,
      }),
    );
    return [...namespaces, ...own].filter((s) => matches(s.insert, query)).slice(0, limit);
  }
  const namespace = query.slice(0, dot);
  const typed = query.slice(dot + 1);
  const keys =
    namespace === SHARED_NAMESPACE
      ? catalog.sharedKeys
      : catalog.services.includes(namespace)
        ? [...new Set([...(catalog.serviceKeys[namespace] ?? []), ...BUILTIN_VARIABLES])]
        : [];
  return keys
    .filter((key) => matches(key, typed))
    .slice(0, limit)
    .map((key) => ({
      insert: `${namespace}.${key}`,
      label: key,
      detail:
        (BUILTIN_VARIABLES as readonly string[]).includes(key) && namespace !== SHARED_NAMESPACE
          ? `built-in of ${namespace}`
          : namespace === SHARED_NAMESPACE
            ? "shared"
            : namespace,
      complete: true,
    }));
}

/**
 * Applies a suggestion to the input.
 *
 * @param value - Current value.
 * @param caret - Caret offset.
 * @param context - The reference being typed.
 * @param suggestion - The chosen suggestion.
 * @returns The new value and caret.
 */
export function applySuggestion(
  value: string,
  caret: number,
  context: ReferenceContext,
  suggestion: ReferenceSuggestion,
): { value: string; caret: number } {
  const head = value.slice(0, context.start);
  let tail = value.slice(caret);
  let insert = suggestion.insert;
  if (suggestion.complete) {
    if (tail.trimStart().startsWith("}}")) tail = tail.trimStart().slice(2);
    insert += "}}";
  }
  return { value: head + insert + tail, caret: head.length + insert.length };
}
