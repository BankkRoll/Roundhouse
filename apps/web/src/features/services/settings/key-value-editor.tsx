import { Button, Input } from "@roundhouse/ui";
import { PlusIcon, XIcon } from "lucide-react";

/** One editable pair. */
export interface KeyValuePair {
  key: string;
  value: string;
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
}: KeyValueEditorProps) {
  return (
    <fieldset className="grid gap-2" disabled={disabled}>
      <legend className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</legend>
      {pairs.length === 0 ? <p className="text-xs text-subtle-foreground">None.</p> : null}
      {pairs.map((pair, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until saved; editing keeps order
        <div key={index} className="grid gap-1">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2">
            <Input
              aria-label={`${label} ${index + 1} key`}
              value={pair.key}
              placeholder={keyPlaceholder}
              aria-invalid={errors[index] ? true : undefined}
              onChange={(event) =>
                onChange(
                  pairs.map((row, i) => (i === index ? { ...row, key: event.target.value } : row)),
                )
              }
              className="font-mono text-xs"
              spellCheck={false}
            />
            <Input
              aria-label={`${label} ${index + 1} value`}
              value={pair.value}
              placeholder={valuePlaceholder}
              onChange={(event) =>
                onChange(
                  pairs.map((row, i) =>
                    i === index ? { ...row, value: event.target.value } : row,
                  ),
                )
              }
              className="font-mono text-xs"
              spellCheck={false}
            />
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
