/**
 * Hetzner labels that mark resources this package manages, and validation
 * for user-supplied labels.
 *
 * NOTE: label keys use the product's new name (`roundhouse.*`) rather than
 * the repository's current one. Labels live on the user's Hetzner resources
 * and drive the deprovision safety check, so they must not change when the
 * code is renamed.
 *
 * @module
 */

/** Prefix shared by every label this package sets. */
export const LABEL_PREFIX = "roundhouse.";

/** Present with value `"true"` on every resource this package created. */
export const LABEL_MANAGED = "roundhouse.managed";

/** Node name on managed servers; the idempotency key. */
export const LABEL_NODE = "roundhouse.node";

/** `node` or `builder` on managed servers. */
export const LABEL_ROLE = "roundhouse.role";

/** Workspace ID on managed servers, when the caller supplies one. */
export const LABEL_WORKSPACE = "roundhouse.workspace";

/** Which default firewall variant a managed firewall is. */
export const LABEL_FIREWALL = "roundhouse.firewall";

/** Hetzner reserves this prefix. */
const RESERVED_PREFIX = "hetzner.cloud/";

const NAME_SEGMENT = /^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,61}[a-zA-Z0-9])?$/;
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const VALUE = /^$|^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,61}[a-zA-Z0-9])?$/;

/**
 * Checks a label key against Hetzner's rules: an optional DNS-subdomain
 * prefix and `/`, then a name of at most 63 characters that starts and ends
 * alphanumeric.
 *
 * @param key - Label key.
 * @returns `true` when Hetzner would accept it.
 */
export function isValidLabelKey(key: string): boolean {
  if (key.startsWith(RESERVED_PREFIX)) return false;
  const slash = key.lastIndexOf("/");
  const name = slash === -1 ? key : key.slice(slash + 1);
  if (!NAME_SEGMENT.test(name)) return false;
  if (slash === -1) return true;
  const prefix = key.slice(0, slash);
  return prefix.length <= 253 && prefix.split(".").every((l) => DNS_LABEL.test(l));
}

/**
 * Checks a label value: empty, or at most 63 characters that start and end
 * alphanumeric with `-`, `_`, `.` between.
 *
 * @param value - Label value.
 * @returns `true` when Hetzner would accept it.
 */
export function isValidLabelValue(value: string): boolean {
  return VALUE.test(value);
}

/**
 * Validates caller-supplied labels and rejects keys in the managed namespace,
 * which only this package may set.
 *
 * @param labels - Extra labels.
 * @returns The labels, unchanged.
 * @throws RangeError naming the first invalid label.
 */
export function validateExtraLabels(labels: Record<string, string>): Record<string, string> {
  for (const [key, value] of Object.entries(labels)) {
    if (key.startsWith(LABEL_PREFIX))
      throw new RangeError(`label ${key}: the ${LABEL_PREFIX} prefix is reserved`);
    if (!isValidLabelKey(key)) throw new RangeError(`label key ${JSON.stringify(key)} is invalid`);
    if (!isValidLabelValue(value))
      throw new RangeError(`label ${key}: value ${JSON.stringify(value)} is invalid`);
  }
  return labels;
}

/**
 * Label selector matching the managed server for a node name.
 *
 * @param nodeName - Validated node name.
 * @returns A selector such as `roundhouse.managed=true,roundhouse.node=web-1`.
 */
export function nodeSelector(nodeName: string): string {
  return `${LABEL_MANAGED}=true,${LABEL_NODE}=${nodeName}`;
}

/**
 * Whether a resource's labels mark it as managed by this package.
 *
 * @param labels - The resource's labels.
 * @returns `true` only for the exact value `"true"`.
 */
export function isManaged(labels: Record<string, string> | undefined): boolean {
  return labels?.[LABEL_MANAGED] === "true";
}
