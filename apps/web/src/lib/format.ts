/**
 * Small, pure display formatters for bytes, percentages, durations and times. Every
 * function treats `null`/`undefined` as "no data" and returns {@link EMPTY}.
 *
 * @module
 */

/** Placeholder shown wherever a value is missing. */
export const EMPTY = "—";

// NOTE: Sizes use binary multiples (1024) but conventional "GB" labels, matching what
// `free -h`, Docker and most hosting dashboards show for RAM and disk.
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

function isNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function trimFixed(value: number, decimals: number): string {
  return Number(value.toFixed(decimals)).toString();
}

function unitIndex(bytes: number): number {
  if (bytes <= 0) return 0;
  return Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
}

/**
 * Formats a byte count with the largest sensible unit.
 *
 * @param bytes - Size in bytes.
 * @param decimals - Max fraction digits; trailing zeros are dropped. Defaults to 1.
 * @returns e.g. `"11.4 GB"`, `"512 B"`, or {@link EMPTY}.
 * @example
 * formatBytes(16 * 1024 ** 3); // "16 GB"
 */
export function formatBytes(bytes: number | null | undefined, decimals = 1): string {
  if (!isNumber(bytes) || bytes < 0) return EMPTY;
  const index = unitIndex(bytes);
  return `${trimFixed(bytes / 1024 ** index, index === 0 ? 0 : decimals)} ${BYTE_UNITS[index]}`;
}

/**
 * Formats a used/total pair in the total's unit so both numbers line up.
 *
 * @param used - Bytes in use.
 * @param total - Capacity in bytes.
 * @returns e.g. `"11.4/16 GB"`, or {@link EMPTY} when either side is unknown.
 */
export function formatBytesPair(
  used: number | null | undefined,
  total: number | null | undefined,
): string {
  if (!isNumber(used) || !isNumber(total) || used < 0 || total <= 0) return EMPTY;
  const index = unitIndex(total);
  const divisor = 1024 ** index;
  return `${trimFixed(used / divisor, 1)}/${trimFixed(total / divisor, 1)} ${BYTE_UNITS[index]}`;
}

/**
 * Computes `used / total` as a percentage.
 *
 * @param used - Amount used.
 * @param total - Capacity.
 * @returns 0-100 (not clamped), or `null` when unknown or total is not positive.
 */
export function percentOf(
  used: number | null | undefined,
  total: number | null | undefined,
): number | null {
  if (!isNumber(used) || !isNumber(total) || total <= 0) return null;
  return (used / total) * 100;
}

/**
 * Formats a percentage.
 *
 * @param value - Percentage 0-100.
 * @param decimals - Fraction digits. Defaults to 0.
 * @returns e.g. `"71%"`, or {@link EMPTY}.
 */
export function formatPercent(value: number | null | undefined, decimals = 0): string {
  if (!isNumber(value)) return EMPTY;
  const rounded = Number(value.toFixed(decimals));
  return `${Object.is(rounded, -0) ? 0 : rounded}%`;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Formats a duration as its two most significant units.
 *
 * @param ms - Duration in milliseconds.
 * @returns e.g. `"41d 6h"`, `"3h 12m"`, `"4m 5s"`, `"12s"`, or {@link EMPTY}.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (!isNumber(ms) || ms < 0) return EMPTY;
  const parts: [number, string][] = [
    [Math.floor(ms / DAY), "d"],
    [Math.floor((ms % DAY) / HOUR), "h"],
    [Math.floor((ms % HOUR) / MINUTE), "m"],
    [Math.floor((ms % MINUTE) / SECOND), "s"],
  ];
  const first = parts.findIndex(([value]) => value > 0);
  if (first === -1) return "0s";
  return parts
    .slice(first, first + 2)
    .filter(([value], i) => i === 0 || value > 0)
    .map(([value, unit]) => `${value}${unit}`)
    .join(" ");
}

/**
 * Formats remaining time as a clock, for join-token expiry countdowns. Join tokens live
 * for 15 minutes, so there is no hours field.
 *
 * @param ms - Milliseconds remaining. Negative values show as zero.
 * @returns `"m:ss"`, e.g. `"14:59"`.
 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / SECOND));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Formats how long ago something happened, compactly.
 *
 * Clock skew between the browser and the control plane can produce timestamps slightly
 * in the future; those read as "now" rather than a negative age.
 *
 * @param timestamp - Unix ms of the event.
 * @param now - Current unix ms. Defaults to `Date.now()`.
 * @returns `"now"`, `"12s"`, `"4m"`, `"3h"`, `"6d"`, or `"Mar 4"` beyond 30 days
 *   (`"Mar 4, 2025"` in another year); `"never"` for `null`.
 */
export function formatAgo(timestamp: number | null | undefined, now = Date.now()): string {
  if (!isNumber(timestamp)) return "never";
  const age = now - timestamp;
  if (age < 5 * SECOND) return "now";
  if (age < MINUTE) return `${Math.floor(age / SECOND)}s`;
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h`;
  if (age < 30 * DAY) return `${Math.floor(age / DAY)}d`;
  const date = new Date(timestamp);
  const label = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return date.getUTCFullYear() === new Date(now).getUTCFullYear()
    ? label
    : `${label}, ${date.getUTCFullYear()}`;
}

/**
 * Like {@link formatAgo} but reads as a sentence fragment.
 *
 * @param timestamp - Unix ms of the event.
 * @param now - Current unix ms. Defaults to `Date.now()`.
 * @returns `"just now"`, `"4m ago"`, `"Mar 4"`, or `"never"`.
 */
export function formatRelativeTime(timestamp: number | null | undefined, now = Date.now()): string {
  const short = formatAgo(timestamp, now);
  if (short === "now") return "just now";
  if (short === "never" || short.includes(" ")) return short;
  return `${short} ago`;
}

/**
 * Formats a timestamp as an unambiguous UTC string for tooltips and audit rows.
 *
 * @param timestamp - Unix ms.
 * @returns e.g. `"2026-10-22 12:41:05 UTC"`, or {@link EMPTY}.
 */
export function formatTimestamp(timestamp: number | null | undefined): string {
  if (!isNumber(timestamp)) return EMPTY;
  return `${new Date(timestamp).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/**
 * Joins OS and architecture the way Docker platforms are written.
 *
 * @param os - e.g. `"linux"`.
 * @param arch - e.g. `"amd64"`.
 * @returns `"linux/amd64"`, whichever half is known, or {@link EMPTY}.
 */
export function formatPlatform(os: string | null | undefined, arch: string | null | undefined) {
  const parts = [os, arch].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("/") : EMPTY;
}

/**
 * Formats an agent version for display. Release builds report semver ("0.1.0")
 * and get a `v` prefix; development builds report free text ("dev") as-is.
 *
 * @param version - Version reported by the agent, or null before it connects.
 * @returns Display string, or `null` when unknown.
 * @example
 * formatAgentVersion("0.1.0"); // "v0.1.0"
 * formatAgentVersion("dev");   // "dev"
 */
export function formatAgentVersion(version: string | null): string | null {
  if (!version) return null;
  return /^\d/.test(version) ? `v${version}` : version;
}

/**
 * Shortens a git commit SHA for display.
 *
 * @param sha - Full SHA-1 or SHA-256 hex.
 * @returns The first 7 characters, or {@link EMPTY}.
 * @example
 * formatCommit("3f9c2b1d8e7a6f5c4b3a29180716253443526170"); // "3f9c2b1"
 */
export function formatCommit(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : EMPTY;
}

/**
 * Formats a CPU limit given in thousandths of a core.
 *
 * @param millis - e.g. `1500`.
 * @returns e.g. `"1.5 vCPU"`, or {@link EMPTY}.
 */
export function formatCpu(millis: number | null | undefined): string {
  if (!isNumber(millis) || millis < 0) return EMPTY;
  return `${trimFixed(millis / 1000, 2)} vCPU`;
}

/**
 * Formats a memory limit given in MiB.
 *
 * @param mb - e.g. `1536`.
 * @returns e.g. `"512 MB"` or `"1.5 GB"`, or {@link EMPTY}.
 */
export function formatMemoryMb(mb: number | null | undefined): string {
  if (!isNumber(mb) || mb < 0) return EMPTY;
  return mb >= 1024 ? `${trimFixed(mb / 1024, 2)} GB` : `${Math.round(mb)} MB`;
}

/**
 * Formats a clock time for log lines, in UTC to match {@link formatTimestamp}.
 *
 * @param timestamp - Unix ms.
 * @returns e.g. `"12:41:05.123"`.
 */
export function formatLogTime(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 23);
}

/**
 * Formats a byte rate, as network and disk charts plot it.
 *
 * @param bytesPerSecond - Bytes per second.
 * @returns e.g. `"1.2 MB/s"`, `"0 B/s"`, or {@link EMPTY}.
 * @example
 * formatBytesPerSecond(1.5 * 1024 * 1024); // "1.5 MB/s"
 */
export function formatBytesPerSecond(bytesPerSecond: number | null | undefined): string {
  const bytes = formatBytes(bytesPerSecond);
  return bytes === EMPTY ? EMPTY : `${bytes}/s`;
}

/**
 * Formats CPU usage given in millicores: millicores below one core, cores above, the
 * way container dashboards and Kubernetes write it.
 *
 * @param millis - Thousandths of a core, e.g. `120` or `1500`.
 * @returns e.g. `"120m"`, `"0.5m"`, `"1.5 vCPU"`, or {@link EMPTY}.
 * @example
 * formatMillicores(120); // "120m"
 * formatMillicores(2000); // "2 vCPU"
 */
export function formatMillicores(millis: number | null | undefined): string {
  if (!isNumber(millis) || millis < 0) return EMPTY;
  if (millis >= 1000) return formatCpu(millis);
  return `${trimFixed(millis, millis < 10 ? 1 : 0)}m`;
}

/**
 * Formats a count compactly for chart axes and tooltips.
 *
 * @param value - A count; fractions keep one digit.
 * @returns e.g. `"3"`, `"0.5"`, `"1.2k"`, or {@link EMPTY}.
 */
export function formatCount(value: number | null | undefined): string {
  if (!isNumber(value)) return EMPTY;
  if (Math.abs(value) >= 1000) return `${trimFixed(value / 1000, 1)}k`;
  return trimFixed(value, 1);
}
