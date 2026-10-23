/**
 * Label and tag conventions shared by every adapter.
 *
 * Every resource Roundhouse creates on a user's cloud account carries:
 * - `roundhouse.managed=true`: the marker the deprovision safety check
 *   requires, so a user's own servers are never deleted;
 * - `roundhouse.node=<name>`: the node name, which is also the idempotency
 *   key for provisioning;
 * - `roundhouse.role=node|builder`;
 * - `roundhouse.workspace=<id>`, when the caller supplies one.
 *
 * IMPORTANT: these keys live on users' cloud resources and must never
 * change, including when the code is renamed. They are the exact keys
 * `@roundhouse/hetzner` used.
 *
 * Providers with key/value labels (Hetzner) store them as labels. Providers
 * with plain string tags store one tag per label through a {@link TagCodec},
 * whose format depends on the characters the provider allows in a tag.
 *
 * @module
 */
import type { NodeRole } from "./catalog";

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

/** Every label key this package sets. */
export const LABEL_KEYS = [
  LABEL_MANAGED,
  LABEL_NODE,
  LABEL_ROLE,
  LABEL_WORKSPACE,
  LABEL_FIREWALL,
] as const;

/** A label key this package sets. */
export type LabelKey = (typeof LABEL_KEYS)[number];

const VALUE = /^$|^[a-zA-Z0-9]([a-zA-Z0-9._-]{0,61}[a-zA-Z0-9])?$/;

/**
 * Checks a label value: empty, or at most 63 characters that start and end
 * alphanumeric with `-`, `_`, `.` between. This is Hetzner's grammar, the
 * strictest of the supported providers, so a value that passes is
 * storable everywhere.
 *
 * @param value - Label value.
 * @returns `true` when every provider would accept it.
 */
export function isValidLabelValue(value: string): boolean {
  return VALUE.test(value);
}

/** What a managed server's labels say about it. */
export interface ManagedIdentity {
  /** Node name. */
  node: string;
  /** Node role. */
  role: NodeRole;
  /** Workspace ID, or `null`. */
  workspaceId: string | null;
}

/**
 * The labels for a managed server.
 *
 * @param identity - Node name, role, and workspace.
 * @returns Labels with the managed marker.
 * @example
 * managedLabels({ node: "web-1", role: "node", workspaceId: "ws_1" });
 * // { "roundhouse.managed": "true", "roundhouse.node": "web-1", ... }
 */
export function managedLabels(identity: ManagedIdentity): Record<string, string> {
  const labels: Record<string, string> = {
    [LABEL_MANAGED]: "true",
    [LABEL_NODE]: identity.node,
    [LABEL_ROLE]: identity.role,
  };
  if (identity.workspaceId !== null) labels[LABEL_WORKSPACE] = identity.workspaceId;
  return labels;
}

/**
 * Whether labels mark a resource as managed by this package.
 *
 * @param labels - The resource's labels.
 * @returns `true` only for the exact value `"true"`.
 */
export function isManaged(labels: Record<string, string> | undefined): boolean {
  return labels?.[LABEL_MANAGED] === "true";
}

/**
 * Reads the identity of a managed server from its labels.
 *
 * @param labels - Decoded labels.
 * @returns The identity, or `null` when the resource is not managed or has no node name.
 */
export function readManagedIdentity(
  labels: Record<string, string> | undefined,
): ManagedIdentity | null {
  if (!labels || !isManaged(labels)) return null;
  const node = labels[LABEL_NODE];
  if (!node) return null;
  return {
    node,
    role: labels[LABEL_ROLE] === "builder" ? "builder" : "node",
    workspaceId: labels[LABEL_WORKSPACE] ?? null,
  };
}

/**
 * Hetzner label selector matching the managed server for a node name.
 *
 * @param nodeName - Validated node name.
 * @returns A selector such as `roundhouse.managed=true,roundhouse.node=web-1`.
 */
export function nodeSelector(nodeName: string): string {
  return `${LABEL_MANAGED}=true,${LABEL_NODE}=${nodeName}`;
}

// -----------------------------------------------------------------------------
// Tags
// -----------------------------------------------------------------------------

/** Encodes labels as plain string tags and back. */
export interface TagCodec {
  /**
   * The tag for one label.
   *
   * @param key - Label key.
   * @param value - Label value.
   */
  tag(key: LabelKey, value: string): string;
  /**
   * Tags for a label set, in a stable order.
   *
   * @param labels - Labels with keys from {@link LABEL_KEYS}.
   */
  encode(labels: Record<string, string>): string[];
  /**
   * Labels recovered from a resource's tags. Tags this package did not
   * write are ignored.
   *
   * @param tags - The resource's tags.
   */
  decode(tags: readonly string[]): Record<string, string>;
}

/**
 * Builds a codec that writes `<key><separator><value>`, optionally with the
 * dots in keys replaced (for providers whose tags disallow `.`).
 *
 * Decoding is unambiguous because keys are fixed: a tag decodes only when it
 * starts with one of the known encoded keys followed by the separator.
 *
 * @param options - `separator` between key and value; `keyDot` replaces `.`
 *   in keys.
 * @returns The codec.
 * @example
 * const kv = createTagCodec({ separator: "=" });
 * kv.tag("roundhouse.node", "web-1"); // "roundhouse.node=web-1"
 * const colon = createTagCodec({ separator: ":", keyDot: ":" });
 * colon.tag("roundhouse.node", "web-1"); // "roundhouse:node:web-1"
 */
export function createTagCodec(options: { separator: string; keyDot?: string }): TagCodec {
  const encodeKey = (key: string) =>
    options.keyDot === undefined ? key : key.split(".").join(options.keyDot);
  const prefixes = LABEL_KEYS.map((key) => ({
    key,
    prefix: `${encodeKey(key)}${options.separator}`,
  }))
    // Longest first, so no key's encoding can shadow a longer one.
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const tag = (key: LabelKey, value: string) => `${encodeKey(key)}${options.separator}${value}`;
  return {
    tag,
    encode(labels) {
      return LABEL_KEYS.filter((k) => labels[k] !== undefined).map((k) => tag(k, labels[k]!));
    },
    decode(tags) {
      const out: Record<string, string> = {};
      const conflicted = new Set<string>();
      for (const t of tags) {
        const hit = prefixes.find((p) => t.startsWith(p.prefix));
        if (!hit) continue;
        const value = t.slice(hit.prefix.length);
        if (hit.key in out && out[hit.key] !== value) conflicted.add(hit.key);
        out[hit.key] = value;
      }
      // SECURITY: two different values for one key (e.g. a hand-added
      // second node tag) make the resource's identity ambiguous, so the key
      // is dropped and the safety checks treat it as unmanaged.
      for (const key of conflicted) delete out[key];
      return out;
    },
  };
}
