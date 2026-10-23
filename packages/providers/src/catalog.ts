/**
 * Provider-neutral catalogue constants and helpers: supported OS images,
 * architectures, node roles and their installer floors, and money parsing.
 *
 * Kept free of imports from the adapters so they can depend on it without
 * an import cycle through the provider registry.
 *
 * @module
 */

/** CPU architecture as the agent and installer name it. */
export type Arch = "amd64" | "arm64";

/** OS images the installer supports (install/install.sh, `check_os`). */
export const SUPPORTED_IMAGES = ["ubuntu-24.04", "ubuntu-22.04", "debian-12"] as const;

/** Name of a supported OS image. */
export type SupportedImageName = (typeof SUPPORTED_IMAGES)[number];

/** Default OS image for new servers. */
export const DEFAULT_IMAGE: SupportedImageName = "ubuntu-24.04";

/**
 * Whether a string names a supported image.
 *
 * @param name - Candidate.
 * @returns `true` for one of {@link SUPPORTED_IMAGES}.
 */
export function isSupportedImage(name: string): name is SupportedImageName {
  return (SUPPORTED_IMAGES as readonly string[]).includes(name);
}

/** What a node does: `node` runs services; `builder` also builds images. */
export type NodeRole = "node" | "builder";

/**
 * The installer's hard minimums per role (install/install.sh `MIN_*`). An
 * offer below these cannot join, so it is never listed. Memory is the
 * advertised size; the installer accepts the ~950 MiB a "1 GiB" VM reports.
 */
export const ROLE_FLOORS: Record<NodeRole, { vcpus: number; memoryMib: number; diskGb: number }> = {
  node: { vcpus: 1, memoryMib: 1024, diskGb: 10 },
  builder: { vcpus: 1, memoryMib: 1024, diskGb: 20 },
};

/**
 * Converts a non-negative decimal amount to minor units with half-up
 * rounding, without floating point (`"1.0050"` is 101, not 100).
 *
 * @param decimal - A decimal string such as `"4.7481"`, or a finite number.
 * @returns Cents.
 * @throws RangeError for negative or non-numeric input.
 * @example
 * decimalToCents("4.1500"); // 415
 * decimalToCents(24); // 2400
 */
export function decimalToCents(decimal: string | number): number {
  const text = typeof decimal === "number" ? numberToDecimal(decimal) : decimal.trim();
  const m = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (!m) throw new RangeError(`not a decimal amount: ${decimal}`);
  const frac = (m[2] ?? "").padEnd(3, "0");
  const cents = Number(m[1]) * 100 + Number(frac.slice(0, 2));
  return Number(frac[2]) >= 5 ? cents + 1 : cents;
}

function numberToDecimal(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`not a decimal amount: ${n}`);
  // Up to 6 places keeps sub-cent JSON prices (e.g. 0.00744) exact enough to
  // round correctly without exposing binary floating-point noise.
  return n.toFixed(6);
}

/**
 * Whether an RFC 3339 time is at or before `now`.
 *
 * @param iso - Time, or nothing.
 * @param now - Current unix ms.
 * @returns `false` for missing or unparsable input.
 */
export function isPast(iso: string | undefined | null, now: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= now;
}
