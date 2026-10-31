/**
 * Linux kernel compatibility rules: parsing the kernel release a node's
 * agent reports in `hello.kernel` (`uname -r`), and deciding whether a
 * workload is known not to start on it.
 *
 * MongoDB 8.0 and later bundle a TCMalloc that registers rseq in a way the
 * upstream rseq ABI does not allow. Kernel 6.19 started enforcing that ABI,
 * so `mongod` refuses to start there ("Linux kernel versions 6.19 and newer
 * has a known incompatibility with this version of MongoDB",
 * https://jira.mongodb.org/browse/SERVER-121912). The kernel restored
 * compatibility in 7.0.14, and MongoDB dropped the startup refusal for 7.0.14
 * and above (https://jira.mongodb.org/browse/SERVER-125742). The scheduler
 * keeps MongoDB 8.0+ off nodes in between, so it fails with a reason
 * instead of crash-looping.
 *
 * Only the upstream `major.minor.patch` prefix of a release counts:
 * distribution kernels add their own ABI and build numbers after it
 * (`7.0.0-14-generic` is upstream 7.0.0, Ubuntu build 14), and those can't
 * be mapped to upstream fixes without the distribution's changelog.
 *
 * @module
 */
import type { ServiceDatabaseEngine } from "./databases";

/** An upstream kernel version, from the front of a release string. */
export interface KernelVersion {
  major: number;
  minor: number;
  patch: number;
}

/** First kernel `mongod` 8.0+ refuses to start on (SERVER-121912). */
export const MONGODB_RSEQ_FIRST_AFFECTED_KERNEL: KernelVersion = {
  major: 6,
  minor: 19,
  patch: 0,
};

/** First kernel with the rseq compatibility fix (SERVER-125742). */
export const MONGODB_RSEQ_FIXED_KERNEL: KernelVersion = { major: 7, minor: 0, patch: 14 };

/** Upstream issue describing the MongoDB 8.0+ kernel incompatibility. */
export const MONGODB_RSEQ_ISSUE_URL = "https://jira.mongodb.org/browse/SERVER-121912";

/** Oldest MongoDB major whose bundled TCMalloc trips the rseq ABI check. */
export const MONGODB_RSEQ_FIRST_AFFECTED_MAJOR = 8;

const RELEASE = /^\s*(\d{1,4})\.(\d{1,4})(?:\.(\d{1,6}))?(?![\d])/;

/**
 * Parses the upstream version at the front of a kernel release string.
 * A missing patch level reads as 0; anything after the third number
 * (distribution ABI, flavour, a fourth WSL component) is ignored.
 *
 * @param release - A `uname -r` value.
 * @returns The version, or `null` when the string doesn't start with one.
 * @example
 * parseKernelRelease("6.8.0-45-generic"); // { major: 6, minor: 8, patch: 0 }
 * parseKernelRelease("6.19.2-arch1-1"); // { major: 6, minor: 19, patch: 2 }
 * parseKernelRelease("unknown"); // null
 */
export function parseKernelRelease(release: string | null | undefined): KernelVersion | null {
  if (!release) return null;
  const m = RELEASE.exec(release);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: m[3] ? Number(m[3]) : 0 };
}

/**
 * Orders two kernel versions.
 *
 * @param a - A version.
 * @param b - Another version.
 * @returns Negative when `a` is older, positive when newer, 0 when equal.
 */
export function compareKernelVersions(a: KernelVersion, b: KernelVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Whether MongoDB 8.0+ refuses to start on a kernel: releases in
 * [6.19.0, 7.0.14). Unknown or unparsable releases count as unaffected, so
 * a node that hasn't reported its kernel is never refused on a guess.
 *
 * @param release - A `uname -r` value, as `nodes.kernel` stores it.
 * @returns `true` when the kernel is in the affected range.
 * @example
 * isMongoRseqAffectedKernel("7.0.0-14-generic"); // true
 * isMongoRseqAffectedKernel("7.0.14"); // false
 * isMongoRseqAffectedKernel("6.8.0-45-generic"); // false
 */
export function isMongoRseqAffectedKernel(release: string | null | undefined): boolean {
  const v = parseKernelRelease(release);
  if (!v) return false;
  return (
    compareKernelVersions(v, MONGODB_RSEQ_FIRST_AFFECTED_KERNEL) >= 0 &&
    compareKernelVersions(v, MONGODB_RSEQ_FIXED_KERNEL) < 0
  );
}

/**
 * Whether a database service runs a MongoDB version that can't start on an
 * affected kernel (see {@link isMongoRseqAffectedKernel}): MongoDB 8.0 and
 * later.
 *
 * @param engine - The service's database engine; `null` for a service
 *   that isn't a database.
 * @param version - Its registry version, e.g. `8.0`.
 * @returns `true` for MongoDB 8.0 and later.
 * @example
 * isKernelSensitiveDatabase("mongodb", "8.0"); // true
 * isKernelSensitiveDatabase("postgres", "18"); // false
 */
export function isKernelSensitiveDatabase(
  engine: ServiceDatabaseEngine | null | undefined,
  version: string | null | undefined,
): boolean {
  if (engine !== "mongodb" || !version) return false;
  const major = Number.parseInt(version, 10);
  return Number.isFinite(major) && major >= MONGODB_RSEQ_FIRST_AFFECTED_MAJOR;
}

/**
 * Why a MongoDB 8.0+ service can't be placed on a node, for a deploy's
 * failure reason.
 *
 * @param release - The node's kernel release.
 * @returns One actionable sentence pair.
 * @example
 * mongoKernelRefusal("7.0.0-14-generic");
 * // "MongoDB 8.0 and later cannot start on Linux kernel 7.0.0-14-generic (6.19 to 7.0.13). …"
 */
export function mongoKernelRefusal(release: string): string {
  return (
    `MongoDB 8.0 and later cannot start on Linux kernel ${release} (6.19 to 7.0.13). ` +
    "Upgrade the server's kernel to 7.0.14 or later, or place the service on another server."
  );
}
