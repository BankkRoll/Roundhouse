/**
 * Staged edits to a service's variables, and the `${{` reference autocomplete.
 *
 * Edits stay local until Save, which sends them as one `PUT` (a new version on the API).
 * Everything here is pure so the editor's rules are tested without rendering.
 *
 * @module
 */
import {
  BUILTIN_VARIABLES,
  classifyVariable,
  isReservedBuildName,
  parseReferences,
  SHARED_NAMESPACE,
  secretDerivedVariables,
  type VariableClassification,
} from "@roundhouse/shared";
import type { Variable, VariablesPutBody } from "../../../lib/api/deploy-types";

/**
 * A change staged for a key. Every field is optional on a saved key: an omitted field
 * keeps what is stored, so a change without `value` only flips the tier or the delivery
 * flags. That is the only way to change a secret's flags, since its value is write-only.
 */
export interface StagedValue {
  /** New value; omitted keeps the stored one. A new key always has one. */
  value?: string;
  /** Requested tier; omitted on a value-less change keeps the stored tier. */
  isSecret?: boolean;
  /** `available_at_build`; omitted keeps the stored flag (`false` for a new key). */
  availableAtBuild?: boolean;
  /** `mount_as_file`; omitted keeps the stored flag (`false` for a new key). */
  mountAsFile?: boolean;
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
  /** Also delivered to builds (ADR 0014 "Builds"). */
  availableAtBuild: boolean;
  /** Delivered as `/run/secrets/<KEY>` instead of an environment variable. */
  mountAsFile: boolean;
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
 * @param value - The change; see {@link StagedValue}.
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
 * Reduces a change against what is stored: fields equal to the stored ones are dropped,
 * so an edit that changes nothing stages nothing and a flag toggle stays flags-only.
 *
 * @param change - The change as edited, value included only when it is new.
 * @param saved - The stored variable, or `undefined` for a new key.
 * @returns The change to stage, or `null` when it changes nothing.
 * @example
 * normalizeChange({ isSecret: true, availableAtBuild: true }, savedSecret);
 * // { availableAtBuild: true }
 */
export function normalizeChange(
  change: StagedValue,
  saved: Variable | undefined,
): StagedValue | null {
  const out: StagedValue = {};
  if (change.value !== undefined) {
    out.value = change.value;
    out.isSecret = change.isSecret ?? false;
  } else if (
    saved &&
    change.isSecret !== undefined &&
    change.isSecret !== (saved.tier === "secret")
  ) {
    out.isSecret = change.isSecret;
  }
  if (
    change.availableAtBuild !== undefined &&
    change.availableAtBuild !== (saved?.available_at_build ?? false)
  ) {
    out.availableAtBuild = change.availableAtBuild;
  }
  if (change.mountAsFile !== undefined && change.mountAsFile !== (saved?.mount_as_file ?? false)) {
    out.mountAsFile = change.mountAsFile;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Stages flags on a key, on top of whatever is already staged for it. Toggling a flag
 * back to its stored state drops the change when nothing else is staged.
 *
 * @param draft - Current draft.
 * @param key - Variable name.
 * @param saved - The stored variable, or `undefined` for a key only in the draft.
 * @param flags - The flags to set.
 * @returns The new draft.
 */
export function stageFlags(
  draft: VariablesDraft,
  key: string,
  saved: Variable | undefined,
  flags: Pick<StagedValue, "availableAtBuild" | "mountAsFile">,
): VariablesDraft {
  const next = normalizeChange({ ...draft.set.get(key), ...flags }, saved);
  return next ? stageSet(draft, key, next) : unstage(draft, key);
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
    const newValue = staged?.value;
    rows.set(variable.key, {
      key: variable.key,
      value: newValue ?? variable.value,
      isSecret: staged?.isSecret ?? variable.tier === "secret",
      availableAtBuild: staged?.availableAtBuild ?? variable.available_at_build,
      mountAsFile: staged?.mountAsFile ?? variable.mount_as_file,
      fingerprint: newValue === undefined ? variable.fingerprint : null,
      change: draft.remove.has(variable.key) ? "deleted" : staged ? "changed" : "none",
      version: variable.version,
    });
  }
  for (const [key, staged] of draft.set) {
    if (rows.has(key)) continue;
    rows.set(key, {
      key,
      value: staged.value ?? "",
      isSecret: staged.isSecret ?? false,
      availableAtBuild: staged.availableAtBuild ?? false,
      mountAsFile: staged.mountAsFile ?? false,
      fingerprint: null,
      change: "added",
    });
  }
  return [...rows.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The tier a key and value must have, when the shared classifier (the same one the API
 * runs) locks it: a recognised credential is always secret, and a framework's public
 * prefix (`VITE_`, `NEXT_PUBLIC_`…) is always plain.
 *
 * @param key - Variable name.
 * @param value - Value as typed.
 * @returns The classification when it is locked, else `null`.
 * @example
 * lockedTier("VITE_API_URL", "https://api.example.test")?.tier; // "plain"
 */
export function lockedTier(key: string, value: string): VariableClassification | null {
  if (!key) return null;
  const classification = classifyVariable(key, value);
  return classification.locked ? classification : null;
}

/** What the person agreed to after the API asked (ADR 0014 write flow). */
export interface PutConsent {
  /** Keys that become secret may be stored write-only. */
  confirmWriteOnly?: boolean;
  /** Public keys that look like credentials may be stored anyway. */
  acknowledgePublic?: readonly string[];
}

/**
 * Builds the `PUT` body from the draft, in a stable order so API errors (`set.3.value`)
 * can be mapped back to a key. Nothing is confirmed up front: the API answers
 * `confirmation_required` or `public_prefix_secret_value` with the keys concerned, the
 * editor asks, and the save is resent with the consent given.
 *
 * @param draft - Staged changes.
 * @param consent - What the person already agreed to.
 * @returns The body, and the key of each `set` entry by index.
 */
export function toPutBody(
  draft: VariablesDraft,
  consent: PutConsent = {},
): { body: VariablesPutBody; setKeys: string[] } {
  const setKeys = [...draft.set.keys()].sort();
  return {
    body: {
      set: setKeys.map((key) => {
        const staged = draft.set.get(key)!;
        const flags = {
          ...(staged.availableAtBuild !== undefined
            ? { available_at_build: staged.availableAtBuild }
            : {}),
          ...(staged.mountAsFile !== undefined ? { mount_as_file: staged.mountAsFile } : {}),
        };
        if (staged.value === undefined) {
          const tier = staged.isSecret === undefined ? null : staged.isSecret ? "secret" : "plain";
          return { key, ...(tier ? { tier } : {}), ...flags } as const;
        }
        const tier = lockedTier(key, staged.value)?.tier ?? (staged.isSecret ? "secret" : "plain");
        return { key, value: staged.value, tier, ...flags };
      }),
      delete: [...draft.remove].sort(),
      confirm_write_only: consent.confirmWriteOnly ?? false,
      ...(consent.acknowledgePublic?.length
        ? { acknowledge_public: [...consent.acknowledgePublic] }
        : {}),
    },
    setKeys,
  };
}

/** An API validation error tied to a staged key. */
export interface FieldError {
  key: string;
  /** The part of the entry it is about; build-time refusals land on `available_at_build`. */
  field: "key" | "value" | "tier" | "available_at_build" | "mount_as_file";
  message: string;
  /** Span of the problem in the value, when the API reports one. */
  start?: number;
  end?: number;
}

/** Detail codes the API uses when it refuses a key's `available_at_build`. */
const BUILD_DETAIL_CODES: ReadonlySet<string> = new Set(["build_arg_secret", "reserved_name"]);

/**
 * Turns the API's per-key `details` into one error per key: the first problem found.
 * Malformed references keep their span in the value; build-time refusals
 * (`build_arg_secret`, `reserved_name`) are tied to the key's build-time switch.
 *
 * @param details - `error.details` of a 400 response.
 * @returns Errors by variable key.
 */
export function errorsFromDetails(
  details: readonly {
    field: string;
    code?: string;
    message: string;
    start?: number;
    end?: number;
  }[],
): Record<string, FieldError> {
  const errors: Record<string, FieldError> = {};
  for (const detail of details) {
    if (errors[detail.field]) continue;
    errors[detail.field] = {
      key: detail.field,
      field: detail.code && BUILD_DETAIL_CODES.has(detail.code) ? "available_at_build" : "value",
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
  const set = /^set\.(\d+)\.(key|value|tier|available_at_build|mount_as_file): (.*)$/s.exec(
    message,
  );
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

/** What the dashboard knows of the environment, to predict build-time refusals. */
export interface BuildContext {
  /** This service's slug, which unqualified references name. */
  slug: string;
  /** Shared variables of the environment (plain values only when readable). */
  shared: readonly Pick<Variable, "key" | "tier" | "value">[];
}

/**
 * Why the API would refuse `available_at_build` on a variable, mirroring its checks:
 * a name the builder reserves for its own environment, or a plain value whose
 * resolution reaches a secret (build args end up in the image). Only references this
 * page can see are followed; the API checks the whole environment and has the last word.
 *
 * @param key - Variable name.
 * @param row - The variable as it would be stored.
 * @param rows - This service's variables as they would be stored.
 * @param context - The environment around it.
 * @returns The reason, or `null` when the flag is allowed as far as is known.
 * @example
 * buildTimeRefusal("PATH", { value: "/bin", isSecret: false }, [], context);
 * // "PATH is reserved for the builder's own environment…"
 */
export function buildTimeRefusal(
  key: string,
  row: { value: string | null; isSecret: boolean },
  rows: readonly Pick<VariableRow, "key" | "value" | "isSecret" | "change">[],
  context: BuildContext,
): string | null {
  if (isReservedBuildName(key)) {
    return `${key} is reserved for the builder's own environment and can't be passed to a build.`;
  }
  if (row.isSecret || row.value === null || parseReferences(row.value).references.length === 0) {
    return null;
  }
  const others = rows.filter((r) => r.change !== "deleted" && r.key !== key);
  const own: Record<string, string> = { [key]: row.value };
  for (const r of others) own[r.key] = r.value ?? "";
  const taint = secretDerivedVariables({
    services: { [context.slug]: own },
    shared: Object.fromEntries(context.shared.map((v) => [v.key, v.value ?? ""])),
    secretServiceKeys: { [context.slug]: others.filter((r) => r.isSecret).map((r) => r.key) },
    secretSharedKeys: context.shared.filter((v) => v.tier === "secret").map((v) => v.key),
  });
  return taint.services[context.slug]?.includes(key)
    ? `${key} references a secret, and build args end up in the image. Make it a secret and read it with RUN --mount=type=secret,id=${key}.`
    : null;
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
