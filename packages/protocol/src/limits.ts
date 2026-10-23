/**
 * Size limits and string formats shared by every protocol schema, mirrored
 * one-for-one by `go/limits.go`.
 *
 * Byte limits count UTF-8 bytes, not UTF-16 code units, so the zod schemas
 * and the Go validators agree on non-ASCII input.
 *
 * @module
 */
import { z } from "zod";

// -----------------------------------------------------------------------------
// Frames
// -----------------------------------------------------------------------------

/**
 * Largest agent → control frame the control plane accepts, in encoded bytes.
 * Sized for a `logs` frame at its text limit with worst-case JSON escaping.
 */
export const MAX_AGENT_FRAME_BYTES = 512 * 1024;

/** Largest signed control → agent frame, in encoded bytes. Matches the agent's read limit. */
export const MAX_CONTROL_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Longest validity window (`exp - iat`) of a control frame that carries a
 * credential: a git token, registry password, or object-storage secret.
 * A captured frame is then useless within a minute.
 */
export const CREDENTIAL_FRAME_TTL_MS = 60_000;

// -----------------------------------------------------------------------------
// Workloads
// -----------------------------------------------------------------------------

/** Most `service` workloads one `desired_state` may list. */
export const MAX_WORKLOADS_PER_NODE = 128;

/** Most statuses an agent reports in one `hello`, including system workloads. */
export const MAX_STATUSES_PER_HELLO = 160;

/** Most environment variables per workload. */
export const MAX_ENV_VARS = 256;

/** Longest environment variable name, in bytes. */
export const MAX_ENV_KEY_BYTES = 256;

/** Longest single environment variable value, in bytes. */
export const MAX_ENV_VALUE_BYTES = 32 * 1024;

/** Combined size of every env key and value of one workload, in bytes. */
export const MAX_ENV_TOTAL_BYTES = 64 * 1024;

/** Most labels per workload. */
export const MAX_LABELS = 64;

/** Longest label key, in bytes. */
export const MAX_LABEL_KEY_BYTES = 128;

/** Longest label value, in bytes. */
export const MAX_LABEL_VALUE_BYTES = 1024;

/** Most arguments in `command` or `entrypoint`. */
export const MAX_ARGS = 256;

/** Longest single `command` or `entrypoint` argument, in bytes. */
export const MAX_ARG_BYTES = 4096;

/** Most exposed ports per workload. */
export const MAX_PORTS = 32;

/** Most ingress routes per workload. */
export const MAX_ROUTES = 32;

/** Most build args per build job. */
export const MAX_BUILD_ARGS = 64;

/** Longest single build arg value, in bytes. */
export const MAX_BUILD_ARG_VALUE_BYTES = 4096;

/** Most BuildKit secrets per build job. */
export const MAX_BUILD_SECRETS = 64;

/** Longest single build secret value, in bytes. */
export const MAX_BUILD_SECRET_VALUE_BYTES = 32 * 1024;

/**
 * Longest base64 ciphertext of one sealed box, in characters. Generous next
 * to {@link MAX_ENV_TOTAL_BYTES} because JSON escaping can multiply control
 * characters six-fold; the frame limit still bounds the total.
 */
export const MAX_SEALED_BOX_CT_CHARS = 512 * 1024;

/** Longest git ref a build job may name, in bytes. */
export const MAX_GIT_REF_BYTES = 255;

// -----------------------------------------------------------------------------
// Logs
// -----------------------------------------------------------------------------

/** Most lines in one `logs` frame. */
export const MAX_LOG_LINES_PER_FRAME = 500;

/** Combined UTF-8 size of every line's `text` in one `logs` frame. */
export const MAX_LOG_FRAME_TEXT_BYTES = 64 * 1024;

/** Longest single log line; agents truncate longer lines with {@link truncateLogLine}. */
export const MAX_LOG_LINE_BYTES = 16 * 1024;

/** Longest human-readable message in a status or build result, in bytes. */
export const MAX_MESSAGE_BYTES = 4096;

// -----------------------------------------------------------------------------
// Formats
// -----------------------------------------------------------------------------

/**
 * Prefixed entity ID as minted by `@roundhouse/shared` (`prj_01J…`), or a
 * fixed system name such as `sys_registry`.
 */
export const ID_RE = /^[a-z]{1,8}_[0-9A-Za-z_]{1,64}$/;

/** POSIX-portable environment variable name. Also used for build args. */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Docker label key: reverse-DNS style, e.g. `roundhouse.service_id`. */
export const LABEL_KEY_RE = /^[A-Za-z0-9]([A-Za-z0-9._/-]*[A-Za-z0-9])?$/;

/**
 * Lowercase DNS hostname: 1–63 character labels of `[a-z0-9-]` that neither
 * start nor end with `-`, at least two labels. The 253-character total is
 * checked separately because Go's RE2 has no lookahead.
 */
export const HOSTNAME_RE =
  /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Longest hostname, in characters. */
export const MAX_HOSTNAME_LENGTH = 253;

/** URL path prefix for a route: starts with `/`, RFC 3986 path characters only. */
export const PATH_PREFIX_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;

/** Docker network name. */
export const NETWORK_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** Full SHA-256 content digest. */
export const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

/** Lowercase hex SHA-256, as produced by `computeSpecHash`. */
export const SPEC_HASH_RE = /^[a-f0-9]{64}$/;

/** A full git commit SHA (SHA-1 or SHA-256 repositories). */
export const COMMIT_SHA_RE = /^([a-f0-9]{40}|[a-f0-9]{64})$/;

/** Build cache scope key. */
export const CACHE_KEY_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Key ID of a node encryption key; see `nodeEncryptionKeyId`. */
export const NODE_ENCRYPTION_KEY_ID_RE = /^[a-f0-9]{16}$/;

/** Characters allowed in a git ref; see {@link isSafeGitRef}. */
export const GIT_REF_RE = /^[A-Za-z0-9._/-]+$/;

/**
 * Private hostname alias a replica may carry in the `roundhouse.private_domain`
 * label: `<service>.<environment>.internal`, lowercase.
 */
export const PRIVATE_DOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.internal$/;

const PATH_COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const DOMAIN = "(?:[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*(?::[0-9]{1,5})?/)?";
const REPOSITORY = `${DOMAIN}${PATH_COMPONENT}(?:/${PATH_COMPONENT})*`;

/**
 * Image repository without tag or digest, following the `distribution`
 * reference grammar: `127.0.0.1:5000/prj_01j…/svc_01j…`. Path components
 * are lowercase.
 */
export const IMAGE_REPOSITORY_RE = new RegExp(`^${REPOSITORY}$`);

/**
 * Image reference with an optional tag and an optional digest:
 * `nginx:1.27`, `ghcr.io/acme/api@sha256:…`.
 */
export const IMAGE_REFERENCE_RE = new RegExp(
  `^${REPOSITORY}(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$`,
);

/** Characters allowed in a repository-relative path; see {@link isSafeRelativePath}. */
export const RELATIVE_PATH_RE = /^[A-Za-z0-9._\-/]{1,512}$/;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Counts the UTF-8 bytes of a string without allocating. Lone surrogates
 * count as the 3-byte replacement character, as `TextEncoder` encodes them.
 *
 * @param value - Any JS string.
 * @returns Its UTF-8 length in bytes.
 * @example
 * utf8ByteLength("é"); // 2
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Truncates a log line to at most {@link MAX_LOG_LINE_BYTES} UTF-8 bytes
 * without splitting a code point. Mirrors Go's `TruncateLogLine`.
 *
 * @param text - Raw line.
 * @param maxBytes - Byte budget; defaults to the protocol limit.
 * @returns `text` unchanged when it fits, otherwise its longest valid prefix.
 */
export function truncateLogLine(text: string, maxBytes = MAX_LOG_LINE_BYTES): string {
  if (text.length <= maxBytes / 3 || utf8ByteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    const pair =
      c >= 0xd800 && c <= 0xdbff && i + 1 < text.length
        ? text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff
        : false;
    const size = c < 0x80 ? 1 : c < 0x800 ? 2 : pair ? 4 : 3;
    if (bytes + size > maxBytes) break;
    bytes += size;
    i += pair ? 2 : 1;
  }
  return text.slice(0, i);
}

/**
 * Whether a path stays inside the repository it is resolved against: no
 * leading `/`, no `..` segment, no backslashes. `.` means the root.
 *
 * @param path - Build context or Dockerfile path from a build job.
 * @returns `true` when the path is safe to join onto a checkout directory.
 * @example
 * isSafeRelativePath("apps/web"); // true
 * isSafeRelativePath("../etc"); // false
 */
export function isSafeRelativePath(path: string): boolean {
  if (!RELATIVE_PATH_RE.test(path) || path.startsWith("/")) return false;
  return !path.split("/").includes("..");
}

/**
 * Whether a git ref is safe to pass to `git fetch`: it can't be read as an
 * option, and it follows `git check-ref-format` (no `..`, no `//`, no
 * component starting with `.`, no trailing `/`, `.` or `.lock`). Agents
 * still pass `--end-of-options` before it.
 *
 * @param ref - Branch or tag name, with or without `refs/heads/`.
 * @returns `true` when the ref is safe.
 * @example
 * isSafeGitRef("feature/login"); // true
 * isSafeGitRef("--upload-pack=sh"); // false
 */
export function isSafeGitRef(ref: string): boolean {
  if (utf8ByteLength(ref) > MAX_GIT_REF_BYTES || !GIT_REF_RE.test(ref)) return false;
  if (ref.startsWith("-") || ref.startsWith("/") || ref.endsWith("/") || ref.endsWith(".")) {
    return false;
  }
  if (ref.endsWith(".lock") || ref.includes("..") || ref.includes("//")) return false;
  return !ref.split("/").some((c) => c.startsWith(".") || c.endsWith(".lock"));
}

/** Git ref; see {@link isSafeGitRef}. */
export const GitRefString = z.string().refine(isSafeGitRef, { message: "expected a safe git ref" });

/** Repository-relative path; see {@link isSafeRelativePath}. */
export const RelativePath = z
  .string()
  .refine(isSafeRelativePath, { message: "expected a relative path inside the repository" });

/**
 * A string whose UTF-8 encoding is at most `max` bytes.
 *
 * @param max - Byte limit.
 * @param min - Minimum length in characters (0 allows the empty string).
 * @returns A zod string schema.
 */
export function boundedString(max: number, min = 0) {
  return z
    .string()
    .min(min)
    .refine((s) => utf8ByteLength(s) <= max, { message: `must be at most ${max} UTF-8 bytes` });
}

/** Prefixed entity ID; see {@link ID_RE}. */
export const IdString = z.string().regex(ID_RE, "expected a prefixed id");

/** TCP/UDP port number. */
export const PortNumber = z.number().int().min(1).max(65535);

/** Unix-millisecond timestamp. */
export const UnixMillis = z.number().int().nonnegative();

/** Lowercase DNS hostname; see {@link HOSTNAME_RE}. */
export const HostnameString = z
  .string()
  .max(MAX_HOSTNAME_LENGTH)
  .regex(HOSTNAME_RE, "expected a lowercase DNS hostname");
