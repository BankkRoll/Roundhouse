/**
 * Time handling for point-in-time restores: showing restorable windows in the viewer's
 * zone or UTC, reading and writing a `datetime-local` input in either, and checking a
 * picked moment against the windows and the clock.
 *
 * Windows are half-open, as the API returns them: `from` is restorable, `to` is the
 * newest archived moment and is not. The picker works in whole seconds.
 *
 * @module
 */
import type { PitrRange } from "../../lib/api/backups-client";

/** Which clock times are shown and entered in. */
export type TimeZoneMode = "local" | "utc";

const SECOND = 1000;

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/**
 * The viewer's IANA time zone, e.g. `Europe/Berlin`.
 *
 * @returns The zone name, or `"local time"` when the runtime can't tell.
 */
export function localZoneName(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  } catch {
    return "local time";
  }
}

/**
 * The short name of the zone an instant is shown in: `UTC`, or the local abbreviation
 * in effect then (it changes with daylight saving), e.g. `CET` or `GMT+1`.
 *
 * @param ms - Unix ms.
 * @param mode - Local or UTC.
 * @returns The abbreviation.
 */
export function zoneAbbreviation(ms: number, mode: TimeZoneMode): string {
  if (mode === "utc") return "UTC";
  const part = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
    .formatToParts(new Date(ms))
    .find((entry) => entry.type === "timeZoneName");
  return part?.value ?? "local";
}

function fields(ms: number, mode: TimeZoneMode) {
  const d = new Date(ms);
  return mode === "utc"
    ? [
        d.getUTCFullYear(),
        d.getUTCMonth() + 1,
        d.getUTCDate(),
        d.getUTCHours(),
        d.getUTCMinutes(),
        d.getUTCSeconds(),
      ]
    : [
        d.getFullYear(),
        d.getMonth() + 1,
        d.getDate(),
        d.getHours(),
        d.getMinutes(),
        d.getSeconds(),
      ];
}

/**
 * An instant as `YYYY-MM-DD HH:mm:ss ZONE` in the chosen clock.
 *
 * @param ms - Unix ms.
 * @param mode - Local or UTC.
 * @returns The formatted instant.
 * @example
 * formatInZone(Date.UTC(2026, 9, 31, 14, 3, 22), "utc"); // "2026-10-31 14:03:22 UTC"
 */
export function formatInZone(ms: number, mode: TimeZoneMode): string {
  const [y, mo, d, h, mi, s] = fields(ms, mode) as [number, number, number, number, number, number];
  return `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}:${pad(s)} ${zoneAbbreviation(ms, mode)}`;
}

/**
 * An instant as a `datetime-local` value with seconds, in the chosen clock.
 *
 * @param ms - Unix ms.
 * @param mode - Local or UTC.
 * @returns e.g. `"2026-10-31T14:03:22"`.
 */
export function toInputValue(ms: number, mode: TimeZoneMode): string {
  const [y, mo, d, h, mi, s] = fields(ms, mode) as [number, number, number, number, number, number];
  return `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`;
}

const INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

/**
 * Reads a `datetime-local` value in the chosen clock. Browsers drop `:00` seconds and may
 * add fractions, so both forms are accepted; fractions are ignored.
 *
 * @param value - The input's value.
 * @param mode - Local or UTC.
 * @returns Unix ms, or `null` for an empty or malformed value.
 * @example
 * parseInputValue("2026-10-31T14:03", "utc"); // Date.UTC(2026, 9, 31, 14, 3)
 */
export function parseInputValue(value: string, mode: TimeZoneMode): number | null {
  const match = INPUT.exec(value.trim());
  if (!match) return null;
  const [y, mo, d, h, mi, s] = match.slice(1).map((part) => Number(part ?? 0)) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const ms =
    mode === "utc" ? Date.UTC(y, mo - 1, d, h, mi, s) : new Date(y, mo - 1, d, h, mi, s).getTime();
  // NOTE: Date rolls an impossible day (Feb 30) into the next month; reject it instead.
  const back = fields(ms, mode);
  return back[1] === mo && back[2] === d ? ms : null;
}

/**
 * The earliest whole second a window can be restored to.
 *
 * @param window - A restorable window.
 * @returns Unix ms.
 */
export function earliestIn(window: PitrRange): number {
  return Math.ceil(window.from / SECOND) * SECOND;
}

/**
 * The latest whole second a window can be restored to: just before its exclusive end,
 * and never after now.
 *
 * @param window - A restorable window.
 * @param now - Current unix ms.
 * @returns Unix ms.
 */
export function latestIn(window: PitrRange, now: number): number {
  return Math.floor(Math.min(window.to - 1, now) / SECOND) * SECOND;
}

/**
 * Whether a moment can be restored to: inside a window and not in the future.
 *
 * @param target - Unix ms.
 * @param window - A restorable window.
 * @param now - Current unix ms.
 * @returns `true` when it can.
 */
export function inWindow(target: number, window: PitrRange, now: number): boolean {
  return target >= window.from && target < window.to && target <= now;
}

/**
 * Why a picked moment can't be restored to, as a sentence naming the bounds in the
 * chosen clock; `null` when it can.
 *
 * @param target - The parsed moment, or `null` when the input is empty or malformed.
 * @param window - The window the picker is set to.
 * @param now - Current unix ms.
 * @param mode - The clock the bounds are named in.
 * @returns The problem, or `null`.
 */
export function targetProblem(
  target: number | null,
  window: PitrRange | undefined,
  now: number,
  mode: TimeZoneMode,
): string | null {
  if (!window) return "Nothing is restorable to a point in time yet.";
  if (target === null) return "Enter a date and a time, to the second.";
  const earliest = formatInZone(earliestIn(window), mode);
  const latest = formatInZone(latestIn(window, now), mode);
  if (target > now) return `That time is in the future. The latest restorable moment is ${latest}.`;
  if (!inWindow(target, window, now)) {
    return `Outside the restorable window. Pick a time from ${earliest} to ${latest}.`;
  }
  return null;
}
