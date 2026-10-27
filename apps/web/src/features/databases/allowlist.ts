/**
 * Source allowlists for a published TCP port: parsing what the user typed into entries,
 * checking each is an IPv4 or IPv6 address or CIDR block, and spotting an entry that
 * admits every address. The API normalises and re-checks; this only catches typos
 * before a round trip.
 *
 * @module
 */
import { MAX_TCP_PROXY_CIDRS } from "@roundhouse/shared";

/** Whether a string is a dotted-quad IPv4 address. */
function isIPv4(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255 && !/^0\d/.test(part))
  );
}

/** Whether a string is an IPv6 address, with `::` compression and an IPv4 tail allowed. */
function isIPv6(value: string): boolean {
  let address = value.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(address) || !address.includes(":")) return false;
  const lastColon = address.lastIndexOf(":");
  const tail = address.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!isIPv4(tail)) return false;
    address = `${address.slice(0, lastColon + 1)}0:0`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return false;
  const groups = halves.flatMap((half) => (half === "" ? [] : half.split(":")));
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return false;
  return halves.length === 2 ? groups.length < 8 : groups.length === 8;
}

/**
 * Whether an entry is an IPv4 or IPv6 address, or a CIDR block of either.
 *
 * @param entry - One allowlist entry.
 * @returns `true` when the API would accept its form.
 * @example
 * isAllowlistEntry("203.0.113.7"); // true
 * isAllowlistEntry("2001:db8::/32"); // true
 * isAllowlistEntry("10.0.0.0/33"); // false
 */
export function isAllowlistEntry(entry: string): boolean {
  const [address = "", bits, ...rest] = entry.split("/");
  if (rest.length > 0) return false;
  const v4 = isIPv4(address);
  if (!v4 && !isIPv6(address)) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  return Number(bits) <= (v4 ? 32 : 128);
}

/**
 * Whether an entry admits every address of its family.
 *
 * @param entry - One allowlist entry.
 * @returns `true` for `0.0.0.0/0`, `::/0` and the like.
 */
export function isOpenEntry(entry: string): boolean {
  return /\/0+$/.test(entry.trim());
}

/** The entries of an allowlist as typed, and the ones that aren't valid. */
export interface ParsedAllowlist {
  /** Every non-empty entry, trimmed, in order, without duplicates. */
  entries: string[];
  /** Entries that aren't an address or CIDR block. */
  invalid: string[];
  /** Whether any entry admits every address. */
  open: boolean;
  /** A problem with the list as a whole, e.g. empty or too long. */
  error: string | null;
}

/**
 * Splits typed text into allowlist entries (one per line, or separated by commas or
 * spaces) and checks each.
 *
 * @param text - What the user typed.
 * @returns The entries and what is wrong with them.
 * @example
 * parseAllowlist("203.0.113.7\n10.0.0.0/8").entries; // ["203.0.113.7", "10.0.0.0/8"]
 */
export function parseAllowlist(text: string): ParsedAllowlist {
  const entries = [...new Set(text.split(/[\s,]+/).filter(Boolean))];
  const invalid = entries.filter((entry) => !isAllowlistEntry(entry));
  const error =
    entries.length === 0
      ? "Add at least one address or CIDR block."
      : entries.length > MAX_TCP_PROXY_CIDRS
        ? `At most ${MAX_TCP_PROXY_CIDRS} entries.`
        : null;
  return { entries, invalid, open: entries.some(isOpenEntry), error };
}
