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
// Signing keys (ADR 0014 §13)
// -----------------------------------------------------------------------------

/** Most successor signing keys `welcome.next_keys` and `key_announce` carry. */
export const MAX_NEXT_SIGNING_KEYS = 2;

/** Most control-plane key IDs an agent reports as pinned in `hello`. */
export const MAX_PINNED_SIGNING_KEYS = 3;

// -----------------------------------------------------------------------------
// Volumes and data services (ADR 0004)
// -----------------------------------------------------------------------------

/** Most volumes one `desired_state` lists. */
export const MAX_VOLUMES_PER_NODE = 128;

/** Most mounts per workload. One in Phase 2; raising it is additive. */
export const MAX_MOUNTS_PER_WORKLOAD = 1;

/** Smallest volume quota, in MiB. */
export const MIN_VOLUME_SIZE_MB = 256;

/** Largest volume quota, in MiB (1 TiB). */
export const MAX_VOLUME_SIZE_MB = 1_048_576;

/** Longest container mount path, in bytes. */
export const MAX_MOUNT_PATH_BYTES = 1024;

/** Most source CIDRs a published (TCP proxy) port admits. */
export const MAX_PUBLISH_CIDRS = 64;

/** Most databases a dump backup may name. */
export const MAX_BACKUP_DATABASES = 64;

/** Most parts of one multipart backup object (R2 and S3 limit). */
export const MAX_BACKUP_PARTS = 10_000;

/** Most presigned part URLs in `backup_job`. */
export const MAX_BACKUP_JOB_PARTS = 16;

/** Most presigned part URLs in one `backup_parts` (and requested by one `backup_parts_request`). */
export const MAX_BACKUP_PARTS_PER_FRAME = 32;

/** Most uploaded parts one `backup_progress` reports. */
export const MAX_BACKUP_PROGRESS_PARTS = 256;

/** Smallest backup part, in bytes (R2's multipart minimum). */
export const MIN_BACKUP_PART_BYTES = 5 * 1024 * 1024;

/** Largest backup part, in bytes (R2's and S3's 5 GiB part maximum). */
export const MAX_BACKUP_PART_BYTES = 5 * 1024 * 1024 * 1024;

/** Backup parts are a whole number of these, so the control plane's sizing stays exact. */
export const BACKUP_PART_ALIGN_BYTES = 1024 * 1024;

/** Longest presigned object-storage URL, in bytes. */
export const MAX_PRESIGNED_URL_BYTES = 4096;

/** Longest backup or restore run, in seconds (12 h). */
export const MAX_BACKUP_TIMEOUT_S = 43_200;

/** Most rows a `db_query` may return. */
export const MAX_DB_QUERY_ROWS = 1000;

/** Largest encoded `db_query_result` rows payload, in bytes; fits an agent frame. */
export const MAX_DB_QUERY_RESULT_BYTES = 458_752;

/** Longest `db_query` run, in milliseconds. */
export const MAX_DB_QUERY_TIMEOUT_MS = 30_000;

/** Longest raw statement or command document, in bytes. */
export const MAX_DB_STATEMENT_BYTES = 64 * 1024;

/** Most positional parameters of a raw SQL statement, or arguments of a Redis command. */
export const MAX_DB_PARAMS = 256;

/** Most result columns of one `db_query_result`. */
export const MAX_DB_COLUMNS = 1024;

/** Longest database identifier (namespace, table, column, key pattern), in bytes. */
export const MAX_DB_IDENTIFIER_BYTES = 256;

// -----------------------------------------------------------------------------
// Mesh (ADR 0005)
// -----------------------------------------------------------------------------

/** Most WireGuard peers of one node: every other node of the 254 the address plan allows. */
export const MAX_MESH_PEERS = 253;

/** Most mesh IPs one `desired_state.mesh.addresses` lists. */
export const MAX_MESH_ADDRESSES = 4096;

/** Most CIDR pairs one relay node forwards. */
export const MAX_MESH_FORWARD_PAIRS = 4096;

/** Most `allowed_ips` of one peer: its own /24 plus the pairs it relays. */
export const MAX_MESH_ALLOWED_IPS = 256;

/** Most remote upstreams of one route-only workload. */
export const MAX_UPSTREAMS = 256;

/** Most htpasswd users of a primary registry: one per other node. */
export const MAX_REGISTRY_PULL_USERS = 254;

// -----------------------------------------------------------------------------
// Jobs, metrics, certificates (ADRs 0008, 0009, 0010)
// -----------------------------------------------------------------------------

/** Shortest `job_run.timeout_s`. */
export const MIN_JOB_TIMEOUT_S = 10;
/** Longest `job_run.timeout_s` (24 h). */
export const MAX_JOB_TIMEOUT_S = 86_400;

/** Most container samples in one `metrics` frame (the hello status cap, inside Analytics Engine's 250 points per invocation). */
export const MAX_METRIC_SAMPLES = 160;

/** Most certificates one `desired_state.certificates` manifest lists. */
export const MAX_CERTIFICATES_PER_NODE = 4096;

/** Most certificate bodies in one `cert_sync`. */
export const MAX_CERT_UPSERTS_PER_FRAME = 32;

/** Most certificate IDs one `cert_sync.removes` or `cert_ack` names. */
export const MAX_CERT_IDS_PER_FRAME = 256;

/** Most hostnames one certificate covers. */
export const MAX_CERT_HOSTNAMES = 100;

/** Longest certificate chain PEM, in bytes. */
export const MAX_CERT_PEM_BYTES = 64 * 1024;

/** Longest private key PEM, in bytes. */
export const MAX_CERT_KEY_PEM_BYTES = 16 * 1024;

/** Most hostnames `desired_state.ingress.managed_hosts` lists. */
export const MAX_MANAGED_HOSTS = 4096;

/** Most source CIDRs `desired_state.ingress.allowed_sources` lists. */
export const MAX_INGRESS_SOURCES = 256;

/** Longest HSTS `max-age`, in seconds (two years). */
export const MAX_HSTS_MAX_AGE_S = 63_072_000;

// -----------------------------------------------------------------------------
// Phase 4 (ADR 0012 web shell, ADR 0011 image push)
// -----------------------------------------------------------------------------

/** Most argv entries an `exec_open.command` carries (ADR 0014 §15). */
export const MAX_EXEC_ARGS = 32;

/** Most UTF-8 bytes of all `exec_open.command` entries together (ADR 0014 §15). */
export const MAX_EXEC_COMMAND_BYTES = 4096;

/** Most environment variables an `exec_open` sets. */
export const MAX_EXEC_ENV_VARS = 8;

/** Longest value of an `exec_open` environment variable, in bytes. */
export const MAX_EXEC_ENV_VALUE_BYTES = 256;

/** Most raw bytes one `exec_input` carries (before base64 and sealing). */
export const MAX_EXEC_INPUT_BYTES = 16 * 1024;

/** Most raw bytes one `exec_output` carries (before base64). */
export const MAX_EXEC_OUTPUT_BYTES = 32 * 1024;

/** Widest terminal, in columns. */
export const MAX_EXEC_COLS = 1000;

/** Tallest terminal, in rows. */
export const MAX_EXEC_ROWS = 500;

/** Shortest idle timeout a session may ask for, in seconds. */
export const MIN_EXEC_IDLE_TIMEOUT_S = 10;

/** Longest idle timeout a session may ask for, in seconds. */
export const MAX_EXEC_IDLE_TIMEOUT_S = 28_800;

/** Shortest total duration a session may ask for, in seconds. */
export const MIN_EXEC_MAX_DURATION_S = 60;

/** Longest total duration a session may ask for, in seconds (8 hours). */
export const MAX_EXEC_MAX_DURATION_S = 28_800;

/** Most shell sessions one node runs at once (ADR 0012). */
export const MAX_EXEC_SESSIONS_PER_NODE = 4;

/** Most `exec_output` frames one session sends per second (ADR 0012). */
export const MAX_EXEC_OUTPUT_FRAMES_PER_SECOND = 64;

/** Longest `image_push.timeout_s`. */
export const MAX_IMAGE_PUSH_TIMEOUT_S = 3600;

/** Shortest `image_push.timeout_s`. */
export const MIN_IMAGE_PUSH_TIMEOUT_S = 60;

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

/**
 * Route hostname: a {@link HOSTNAME_RE} hostname, optionally with one leading
 * `*.` wildcard label (ADR 0009). The total length is checked separately.
 */
export const WILDCARD_HOSTNAME_RE =
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Control-plane signing key ID, as in `Envelope.kid` (`k<base36>` in production). */
export const SIGNING_KEY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Node ID inside mesh peer lists and addresses: the ID minted at join. */
export const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Correlation ID of a `db_query`. */
export const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Database name a dump backup may select. */
export const DB_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_$-]{0,63}$/;

/** Database principal whose password `set_password` changes. */
export const DB_USER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/;

/**
 * A new database password: characters that need no quoting in a SQL string
 * literal, a Redis ACL rule or a connection URL, so the agent sets it
 * without an escaping step that could be got wrong. Generated passwords are
 * 43 base64url characters.
 */
export const DB_PASSWORD_RE = /^[A-Za-z0-9._~-]{16,256}$/;

/** age X25519 recipient (bech32, lowercase). */
export const AGE_RECIPIENT_RE = /^age1[02-9ac-hj-np-z]{58}$/;

/** age X25519 identity (bech32, uppercase). Only ever inside a sealed box. */
export const AGE_IDENTITY_RE = /^AGE-SECRET-KEY-1[02-9AC-HJ-NP-Z]{58}$/;

/** bcrypt hash of an htpasswd user. */
export const BCRYPT_RE = /^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$/;

/** Registry user name. */
export const REGISTRY_USER_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** S3 ETag as returned by `UploadPart`: printable ASCII, quotes included. */
export const ETAG_RE = /^[\x21-\x7e]{1,256}$/;

/** Presigned object-storage URL. Plain `http` is for the fake S3 in tests. */
export const PRESIGNED_URL_RE = /^https?:\/\/[^\s/?#]+\/[^\s]*$/;

/** Absolute container path a volume may be mounted at; see {@link isSafeMountPath}. */
export const MOUNT_PATH_RE = /^\/[A-Za-z0-9._@%+=:,/-]*$/;

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

/**
 * Container paths a volume may never cover: the root, kernel filesystems, and
 * the agent's `mount_as_file` secrets directory (ADR 0014).
 */
export const RESERVED_MOUNT_PATHS = ["/proc", "/sys", "/dev", "/run/secrets"] as const;

/**
 * Whether a container path is a safe volume mount target: absolute, at most
 * {@link MAX_MOUNT_PATH_BYTES}, no `.`/`..`/empty segment, no trailing `/`,
 * not `/`, and not inside {@link RESERVED_MOUNT_PATHS}. Mirrors Go's
 * `IsSafeMountPath`.
 *
 * @param path - `mounts[].path` from a workload.
 * @returns `true` when the agent may bind a volume there.
 * @example
 * isSafeMountPath("/var/lib/postgresql"); // true
 * isSafeMountPath("/proc/self"); // false
 */
export function isSafeMountPath(path: string): boolean {
  if (path.length > MAX_MOUNT_PATH_BYTES || !MOUNT_PATH_RE.test(path) || path === "/") return false;
  const segments = path.slice(1).split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return false;
  return !RESERVED_MOUNT_PATHS.some((r) => path === r || path.startsWith(`${r}/`));
}

const IPV4_OCTET = "(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";

/** Dotted-quad IPv4 address without leading zeros. */
export const IPV4_RE = new RegExp(`^${IPV4_OCTET}([.]${IPV4_OCTET}){3}$`);

/**
 * Whether a string is an IPv4 address in dotted-quad form, without leading
 * zeros. Mirrors Go's `IsIPv4`.
 *
 * @param s - Candidate address.
 * @returns `true` for e.g. `10.200.1.1`.
 */
export function isIPv4(s: string): boolean {
  return IPV4_RE.test(s);
}

/**
 * Whether a string is an IPv6 address in RFC 4291 text form: eight groups of
 * 1–4 hex digits, at most one `::`, optionally ending in a dotted IPv4. No
 * zone. Mirrors Go's `IsIPv6` (a hand-written parser on both sides, so they
 * agree exactly).
 *
 * @param s - Candidate address.
 * @returns `true` for e.g. `2606:4700::` or `::ffff:10.0.0.1`.
 */
export function isIPv6(s: string): boolean {
  if (s.length < 2 || s.length > 45) return false;
  const halves = s.split("::");
  if (halves.length > 2) return false;
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const all = [...head, ...tail];
  let count = all.length;
  const last = all[all.length - 1];
  if (last?.includes(".")) {
    if (!s.endsWith(last!) || !isIPv4(last!)) return false;
    all.pop();
    count += 1;
  }
  if (!all.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return false;
  return halves.length === 2 ? count <= 7 : count === 8;
}

/**
 * Whether a string is an IPv4 or IPv6 CIDR block (`10.0.0.0/8`,
 * `2606:4700::/32`). Host bits may be set; agents mask them. Mirrors Go's
 * `IsCIDR`.
 *
 * @param s - Candidate block.
 * @returns `true` when the address and prefix length are valid for the family.
 */
export function isCidr(s: string): boolean {
  const slash = s.indexOf("/");
  if (slash < 0) return false;
  const addr = s.slice(0, slash);
  const bits = s.slice(slash + 1);
  if (!/^(0|[1-9][0-9]{0,2})$/.test(bits)) return false;
  const n = Number(bits);
  if (isIPv4(addr)) return n <= 32;
  return isIPv6(addr) && n <= 128;
}

/**
 * Whether a string is an IPv4 CIDR block. Mirrors Go's `IsIPv4CIDR`.
 *
 * @param s - Candidate block.
 * @returns `true` for e.g. `10.200.0.0/16`.
 */
export function isIPv4Cidr(s: string): boolean {
  return isCidr(s) && isIPv4(s.slice(0, s.indexOf("/")));
}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
}

/**
 * Whether an IPv4 address lies inside an IPv4 CIDR block. Mirrors Go's
 * `IPv4InCIDR`.
 *
 * @param ip - Address, see {@link isIPv4}.
 * @param cidr - Block, see {@link isIPv4Cidr}.
 * @returns `false` when either is malformed.
 * @example
 * ipv4InCidr("10.200.3.1", "10.200.0.0/16"); // true
 */
export function ipv4InCidr(ip: string, cidr: string): boolean {
  if (!isIPv4(ip) || !isIPv4Cidr(cidr)) return false;
  const [base, bits] = cidr.split("/") as [string, string];
  const size = 2 ** (32 - Number(bits));
  return Math.floor(ipv4ToInt(ip) / size) === Math.floor(ipv4ToInt(base) / size);
}

/**
 * Whether a string is `host:port`, where host is a hostname (one label
 * allowed), an IPv4 address, or a bracketed IPv6 address, and port is
 * 1–65535 without leading zeros. Mirrors Go's `IsHostPort`.
 *
 * @param s - Candidate endpoint, e.g. a WireGuard `endpoint`.
 * @returns `true` for e.g. `203.0.113.7:51820` or `[2001:db8::1]:51820`.
 */
export function isHostPort(s: string): boolean {
  const colon = s.lastIndexOf(":");
  if (colon <= 0 || s.length > MAX_HOSTNAME_LENGTH + 6) return false;
  const host = s.slice(0, colon);
  const port = s.slice(colon + 1);
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) return false;
  if (host.startsWith("[") && host.endsWith("]")) return isIPv6(host.slice(1, -1));
  return (
    isIPv4(host) ||
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(host)
  );
}

/**
 * Whether a string is a route hostname: a lowercase DNS hostname, optionally
 * with one leading `*.` label (ADR 0009). Mirrors Go's `IsRouteHostname`.
 *
 * @param s - `routes[].hostname`.
 * @returns `true` for e.g. `*.apps.example.com`.
 */
export function isRouteHostname(s: string): boolean {
  return s.length <= MAX_HOSTNAME_LENGTH && WILDCARD_HOSTNAME_RE.test(s);
}

/** Lowercase hex SHA-256. */
export const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, "expected a lowercase hex sha256");

/** IPv4 address; see {@link isIPv4}. */
export const Ipv4String = z.string().refine(isIPv4, { message: "expected an IPv4 address" });

/** IPv4 or IPv6 CIDR block; see {@link isCidr}. */
export const CidrString = z.string().refine(isCidr, { message: "expected a CIDR block" });

/** IPv4 CIDR block; see {@link isIPv4Cidr}. */
export const Ipv4CidrString = z
  .string()
  .refine(isIPv4Cidr, { message: "expected an IPv4 CIDR block" });

/** `host:port`; see {@link isHostPort}. */
export const HostPortString = z.string().refine(isHostPort, { message: "expected host:port" });

/** Route hostname, wildcard allowed; see {@link isRouteHostname}. */
export const RouteHostnameString = z
  .string()
  .refine(isRouteHostname, { message: "expected a lowercase DNS hostname or *.hostname" });

/** Node ID; see {@link NODE_ID_RE}. */
export const NodeIdString = z.string().regex(NODE_ID_RE, "expected a node id");

/** Unix-second timestamp. */
export const UnixSeconds = z.number().int().nonnegative();

/** Non-negative integer counter or byte count. */
export const Count = z.number().int().nonnegative();

/** Standard padded base64. */
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Standard padded base64 of 1 to `maxBytes` raw bytes. Mirrors Go's
 * `validBase64`, which decodes; the byte count here comes from the length
 * and padding, so no decode is needed.
 *
 * @param maxBytes - Most raw bytes.
 * @returns A zod string schema.
 */
export function base64Bytes(maxBytes: number) {
  return z
    .string()
    .min(4)
    .max(Math.ceil(maxBytes / 3) * 4)
    .regex(BASE64_RE, "expected base64")
    .refine(
      (s) => (s.length / 4) * 3 - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0) <= maxBytes,
      {
        message: `must encode at most ${maxBytes} bytes`,
      },
    );
}
