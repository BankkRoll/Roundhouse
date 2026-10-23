/**
 * Display helpers for cron services: slot times in the schedule's zone, the local
 * schedule preview, run status and trigger labels, and the zone list.
 *
 * @module
 */
import {
  type CronRunStatus,
  type CronRunTrigger,
  nextRuns,
  type ScheduleError,
  scheduleError,
} from "@roundhouse/shared";

/** How a run status is drawn. */
export interface RunStatusMeta {
  label: string;
  tone: "neutral" | "success" | "warning" | "danger" | "info";
}

/** Label and tone of every run status; the ones that never ran to an end read apart. */
export const RUN_STATUS: Record<CronRunStatus, RunStatusMeta> = {
  queued: { label: "Queued", tone: "neutral" },
  starting: { label: "Starting", tone: "info" },
  running: { label: "Running", tone: "info" },
  succeeded: { label: "Succeeded", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  timed_out: { label: "Timed out", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  skipped: { label: "Skipped", tone: "warning" },
  missed: { label: "Missed", tone: "warning" },
  lost: { label: "Lost", tone: "danger" },
};

/** Label of every run trigger. */
export const RUN_TRIGGER: Record<CronRunTrigger, string> = {
  schedule: "Schedule",
  manual: "Manual",
  retry: "Retry",
  pre_deploy: "Pre-deploy",
};

/**
 * Formats a slot as wall-clock time in a zone.
 *
 * @param t - Unix ms.
 * @param timezone - IANA zone.
 * @returns e.g. `"Thu 23 Oct 03:00"`.
 */
export function formatSlot(t: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(t));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("hour")}:${get("minute")}`;
}

/** A schedule checked locally: its first problem, or its next slots. */
export interface SchedulePreview {
  error: ScheduleError | null;
  slots: number[];
}

/**
 * Checks a schedule and zone with the shared parser and lists the next slots.
 *
 * @param schedule - Expression or macro.
 * @param timezone - IANA zone.
 * @param count - Slots to list.
 * @param from - Unix ms; slots are strictly later.
 * @returns The problem, or the slots.
 */
export function previewSchedule(
  schedule: string,
  timezone: string,
  count = 5,
  from = Date.now(),
): SchedulePreview {
  const trimmed = schedule.trim();
  if (!trimmed) {
    return {
      error: { code: "invalid_schedule", message: "Enter a schedule", start: 0, end: 0 },
      slots: [],
    };
  }
  const error = scheduleError(trimmed, timezone);
  if (error) return { error, slots: [] };
  return { error: null, slots: nextRuns(trimmed, timezone, from, count) };
}

/**
 * The shortest gap between consecutive slots, for the `allow` overlap warning.
 *
 * @param slots - Ascending unix ms.
 * @returns Milliseconds, or `null` with fewer than two slots.
 */
export function shortestInterval(slots: readonly number[]): number | null {
  let shortest: number | null = null;
  for (let i = 1; i < slots.length; i++) {
    const gap = slots[i]! - slots[i - 1]!;
    if (shortest === null || gap < shortest) shortest = gap;
  }
  return shortest;
}

const FALLBACK_ZONES = [
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Helsinki",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

/**
 * IANA zones to offer, with `UTC` first and the current value kept even when unknown.
 *
 * @param current - The saved zone.
 * @returns Zone names.
 */
export function timeZones(current?: string): string[] {
  const intl = Intl as { supportedValuesOf?: (key: string) => string[] };
  let zones: string[];
  try {
    zones = intl.supportedValuesOf?.("timeZone") ?? FALLBACK_ZONES;
  } catch {
    zones = FALLBACK_ZONES;
  }
  const all = ["UTC", ...zones.filter((zone) => zone !== "UTC")];
  return current && !all.includes(current) ? [current, ...all] : all;
}
