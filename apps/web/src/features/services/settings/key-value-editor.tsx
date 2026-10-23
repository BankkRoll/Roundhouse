import { Button, Input } from "@roundhouse/ui";
import { Switch } from "@roundhouse/ui/controls";
import { PlusIcon, XIcon } from "lucide-react";
import type { ServiceConfig } from "../../../lib/api/deploy-types";

/** One editable pair. */
export interface KeyValuePair {
  key: string;
  value: string;
  /** Marked secret (build args only); see {@link KeyValueEditorProps.secrets}. */
  secret?: boolean;
  /**
   * The saved secret value is still in `value` but shown masked; typing replaces it
   * and leaving the field blank keeps it.
   */
  masked?: boolean;
}

/**
 * Converts a record to editable rows.
 *
 * @param record - e.g. build args or a node selector.
 * @returns Rows in key order.
 */
export function toPairs(record: Readonly<Record<string, string>>): KeyValuePair[] {
  return Object.entries(record)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => ({ key, value }));
}

/**
 * Converts rows back to a record, dropping rows with an empty key.
 *
 * @param pairs - Edited rows.
 * @returns The record; later duplicates win.
 */
export function fromPairs(pairs: readonly KeyValuePair[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const { key, value } of pairs) {
    if (key.trim()) record[key.trim()] = value;
  }
  return record;
}

type BuildConfig = ServiceConfig["build"];

/**
 * Converts a build config's args to editable rows, with saved secret args masked.
 *
 * @param build - The saved build config.
 * @returns Rows in key order.
 */
export function toBuildArgPairs(
  build: Pick<BuildConfig, "build_args" | "secret_build_args">,
): KeyValuePair[] {
  const secret = new Set(build.secret_build_args ?? []);
  return toPairs(build.build_args).map((pair) =>
    secret.has(pair.key) ? { ...pair, secret: true, masked: true } : pair,
  );
}

/**
 * Converts edited build-arg rows back to `build_args` and `secret_build_args`.
 *
 * `secret_build_args` is always present, empty when nothing is secret, because the API
 * merges a partial build config and an omitted list would keep naming removed args.
 *
 * @param pairs - Edited rows.
 * @returns Both fields; secret names are distinct keys of `build_args`, sorted.
 */
export function fromBuildArgPairs(
  pairs: readonly KeyValuePair[],
): Pick<BuildConfig, "build_args"> & { secret_build_args: string[] } {
  const build_args = fromPairs(pairs);
  const secret = new Set<string>();
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (!key) continue;
    if (pair.secret) secret.add(key);
    else secret.delete(key);
  }
  return { build_args, secret_build_args: [...secret].sort() };
}

/**
 * Re-masks secret rows whose value now matches the saved config, so a value typed in
 * stops being shown once it is saved.
 *
 * @param pairs - Current rows.
 * @param build - The saved build config.
 * @returns Rows with saved secrets masked; the same array when nothing changes.
 */
export function maskSavedSecrets(
  pairs: KeyValuePair[],
  build: Pick<BuildConfig, "build_args" | "secret_build_args">,
): KeyValuePair[] {
  const secret = new Set(build.secret_build_args ?? []);
  let changed = false;
  const next = pairs.map((pair) => {
    const key = pair.key.trim();
    if (
      !pair.secret ||
      pair.masked ||
      !secret.has(key) ||
      !Object.hasOwn(build.build_args, key) ||
      build.build_args[key] !== pair.value
    ) {
      return pair;
    }
    changed = true;
    return { ...pair, masked: true };
  });
  return changed ? next : pairs;
}

const MASKED_PLACEHOLDER = "•••••••• saved; type to replace";

/** Props for {@link KeyValueEditor}. */
export interface KeyValueEditorProps {
  /** Accessible name of the list, e.g. "Build arguments". */
  label: string;
  pairs: readonly KeyValuePair[];
  onChange: (pairs: KeyValuePair[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  disabled?: boolean;
  /** Error per row index. */
  errors?: Readonly<Record<number, string>>;
  max?: number;
  /** Keep the legend for assistive tech only, when a visible label already names the list. */
  hideLegend?: boolean;
  /**
   * Offer a per-row Secret switch. Secret values are entered like passwords and, once
   * saved, never shown again; turning the switch off clears the value so it has to be
   * typed in the clear.
   */
  secrets?: boolean;
}

/**
 * Editable list of key/value rows with add and remove, for build args and node
 * selectors.
 *
 * @param props - Rows, change handler and copy.
 * @returns The editor.
 */
export function KeyValueEditor({
  label,
  pairs,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  disabled,
  errors = {},
  max = 64,
  hideLegend = false,
  secrets = false,
}: KeyValueEditorProps) {
  const update = (index: number, change: Partial<KeyValuePair>) =>
    onChange(pairs.map((row, i) => (i === index ? { ...row, ...change } : row)));
  return (
    <fieldset className="grid gap-2" disabled={disabled}>
      <legend className={hideLegend ? "sr-only" : "mb-1.5 text-[13px] font-medium text-foreground"}>
        {label}
      </legend>
      {pairs.length === 0 ? <p className="text-sm text-muted-foreground">None set.</p> : null}
      {pairs.map((pair, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved; editing keeps order
        <div key={index} className="grid gap-1">
          <div
            className={
              secrets
                ? "grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto_auto]"
                : "grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2"
            }
          >
            <Input
              aria-label={`${label} ${index + 1} key`}
              value={pair.key}
              placeholder={keyPlaceholder}
              aria-invalid={errors[index] ? true : undefined}
              onChange={(event) => update(index, { key: event.target.value })}
              className="font-mono text-[13px]"
              spellCheck={false}
            />
            <Input
              aria-label={`${label} ${index + 1} value`}
              value={pair.masked ? "" : pair.value}
              placeholder={pair.masked ? MASKED_PLACEHOLDER : valuePlaceholder}
              type={pair.secret ? "password" : "text"}
              autoComplete={pair.secret ? "off" : undefined}
              onChange={(event) => update(index, { value: event.target.value, masked: false })}
              className={
                secrets
                  ? "order-last col-span-3 font-mono text-[13px] sm:order-none sm:col-span-1"
                  : "font-mono text-[13px]"
              }
              spellCheck={false}
            />
            {secrets ? (
              <div className="flex h-8 items-center gap-1.5">
                <Switch
                  aria-label={`${label} ${index + 1} secret`}
                  checked={Boolean(pair.secret)}
                  onCheckedChange={(secret) =>
                    update(
                      index,
                      secret
                        ? { secret: true }
                        : { secret: false, masked: false, value: pair.masked ? "" : pair.value },
                    )
                  }
                />
                <span aria-hidden="true" className="text-xs text-muted-foreground">
                  Secret
                </span>
              </div>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Remove ${label.toLowerCase()} ${pair.key || index + 1}`}
              onClick={() => onChange(pairs.filter((_, i) => i !== index))}
            >
              <XIcon />
            </Button>
          </div>
          {errors[index] ? <p className="text-xs text-danger">{errors[index]}</p> : null}
        </div>
      ))}
      {pairs.length < max ? (
        <Button
          variant="ghost"
          size="sm"
          className="justify-self-start"
          onClick={() => onChange([...pairs, { key: "", value: "" }])}
        >
          <PlusIcon />
          Add
        </Button>
      ) : null}
    </fieldset>
  );
}
