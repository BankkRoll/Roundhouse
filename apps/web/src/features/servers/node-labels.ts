/**
 * Server labels: the API's rules for keys and values, and how a selector matches them.
 *
 * @module
 */
import type { KeyValuePair } from "../services/settings/key-value-editor";

/** A label key, as `PUT …/nodes/{nodeId}/labels` accepts it: lowercase, 1 to 63 characters. */
export const NODE_LABEL_KEY = /^[a-z0-9]([a-z0-9._/-]{0,61}[a-z0-9])?$/;

/** A label value: empty, or 1 to 63 characters starting and ending alphanumeric. */
export const NODE_LABEL_VALUE = /^([A-Za-z0-9]([A-Za-z0-9._-]{0,61}[A-Za-z0-9])?)?$/;

/** Most labels one server may carry. */
export const MAX_NODE_LABELS = 16;

/**
 * Checks edited label rows against the API's rules.
 *
 * @param pairs - Rows from the editor; fully blank rows are ignored.
 * @returns A message per offending row index.
 * @example
 * labelErrors([{ key: "Pool", value: "x" }]); // { 0: "Keys are lowercase …" }
 */
export function labelErrors(pairs: readonly KeyValuePair[]): Record<number, string> {
  const seen = new Set<string>();
  const errors: Record<number, string> = {};
  pairs.forEach((pair, index) => {
    const key = pair.key.trim();
    if (!key && !pair.value) return;
    if (!NODE_LABEL_KEY.test(key)) {
      errors[index] =
        "Keys are lowercase letters, digits and . _ / -, starting and ending with a letter or digit.";
    } else if (!NODE_LABEL_VALUE.test(pair.value)) {
      errors[index] =
        "Values are up to 63 letters, digits and . _ -, starting and ending with a letter or digit.";
    } else if (seen.has(key)) {
      errors[index] = "This key is already set.";
    }
    seen.add(key);
  });
  return errors;
}

/**
 * Whether a server's labels satisfy a selector: every selector key present with the
 * same value.
 *
 * @param labels - The server's labels.
 * @param selector - Required labels.
 * @returns `true` when all of `selector` matches; an empty selector matches every server.
 */
export function matchesSelector(
  labels: Readonly<Record<string, string>>,
  selector: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(selector).every(
    ([key, value]) => Object.hasOwn(labels, key) && labels[key] === value,
  );
}

/**
 * Labels as `key=value` strings, sorted by key, for compact display.
 *
 * @param labels - A server's labels.
 * @returns E.g. `["pool=untrusted", "region=eu-central"]`.
 */
export function formatLabels(labels: Readonly<Record<string, string>>): string[] {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`);
}
