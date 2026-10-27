/**
 * Display helpers for cron services: slot times in the schedule's zone, the local
 * schedule preview and its plain-English description, run status and trigger labels,
 * run error explanations, and the zone list.
 *
 * @module
 */
import {
  type CronRunStatus,
  type CronRunTrigger,
  type CronSchedule,
  nextRuns,
  parseCron,
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
  // NOTE: Checked untrimmed so the error span indexes the text as typed.
  const error = scheduleError(schedule, timezone);
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

// -----------------------------------------------------------------------------
// Schedule descriptions
// -----------------------------------------------------------------------------

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const pad = (value: number) => String(value).padStart(2, "0");
const sorted = (values: ReadonlySet<number>) => [...values].sort((a, b) => a - b);
const isFull = (values: ReadonlySet<number>, min: number, max: number) =>
  values.size === max - min + 1;

function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Values as words, with runs of three or more collapsed into `a–b`. */
function listOf(values: ReadonlySet<number>, name: (value: number) => string): string {
  const runs: [number, number][] = [];
  for (const value of sorted(values)) {
    const last = runs.at(-1);
    if (last && value === last[1] + 1) last[1] = value;
    else runs.push([value, value]);
  }
  return joinWords(
    runs.flatMap(([from, to]) =>
      to - from >= 2
        ? [`${name(from)}–${name(to)}`]
        : to === from
          ? [name(from)]
          : [name(from), name(to)],
    ),
  );
}

/** The step of `*\/n`-shaped sets (`min`, `min + n`, … to the end of the range), else `null`. */
function stepOf(values: ReadonlySet<number>, min: number, max: number): number | null {
  const list = sorted(values);
  if (list.length < 2 || list[0] !== min) return null;
  const step = list[1]! - list[0]!;
  if (step < 2) return null;
  for (let i = 1; i < list.length; i++) if (list[i]! - list[i - 1]! !== step) return null;
  return list.at(-1)! + step > max ? step : null;
}

function describeTime(schedule: CronSchedule): string {
  const { minutes, hours } = schedule;
  const allHours = isFull(hours, 0, 23);
  /** The hours as a window: `from 09:00 to 17:59`, or a list when they have gaps. */
  const hourSpan = (first: number, last: number) => {
    const list = sorted(hours);
    return list.at(-1)! - list[0]! + 1 === list.length
      ? `from ${pad(list[0]!)}:${pad(first)} to ${pad(list.at(-1)!)}:${pad(last)}`
      : `during hours ${listOf(hours, pad)}`;
  };
  if (isFull(minutes, 0, 59)) return allHours ? "Every minute" : `Every minute ${hourSpan(0, 59)}`;
  const minuteStep = stepOf(minutes, 0, 59);
  if (minuteStep) return `Every ${minuteStep} minutes${allHours ? "" : ` ${hourSpan(0, 59)}`}`;
  if (minutes.size === 1) {
    const minute = sorted(minutes)[0]!;
    const every = minute === 0 ? "Every hour" : `Every hour at :${pad(minute)}`;
    if (allHours) return every;
    if (hours.size <= 6) {
      return `At ${joinWords(sorted(hours).map((hour) => `${pad(hour)}:${pad(minute)}`))}`;
    }
    const hourStep = stepOf(hours, 0, 23);
    if (hourStep) return `Every ${hourStep} hours${minute === 0 ? "" : ` at :${pad(minute)}`}`;
    return `${every} ${hourSpan(minute, minute)}`;
  }
  const at = `At minutes ${listOf(minutes, pad)} past the hour`;
  return allHours ? at : `${at} ${hourSpan(0, 59)}`;
}

function describeWeekdays(weekdays: ReadonlySet<number>): string {
  if (weekdays.size === 7) return "every day";
  const key = sorted(weekdays).join(",");
  if (key === "1,2,3,4,5") return "on weekdays";
  if (key === "0,6") return "on weekends";
  return `on ${listOf(weekdays, (day) => WEEKDAYS[day]!)}`;
}

function describeMonthDays(days: ReadonlySet<number>): string {
  if (days.size === 31) return "every day";
  const step = stepOf(days, 1, 31);
  if (step) return `every ${step} days of the month from the 1st`;
  return days.size === 1
    ? `on day ${sorted(days)[0]} of the month`
    : `on days ${listOf(days, String)} of the month`;
}

/**
 * Describes a schedule in plain English, as the schedule field previews it.
 *
 * @param schedule - Expression or macro.
 * @returns The description, or `null` when the schedule doesn't parse.
 * @example
 * describeSchedule("0 3 * * *"); // "At 03:00, every day"
 * describeSchedule("*\/15 9-17 * * MON-FRI"); // "Every 15 minutes from 09:00 to 17:59, on weekdays"
 */
export function describeSchedule(schedule: string): string | null {
  let parsed: CronSchedule;
  try {
    parsed = parseCron(schedule);
  } catch {
    return null;
  }
  // NOTE: As in crontab(5), a day matches either restricted field, so both read as "or".
  const days =
    parsed.anyDay && parsed.anyWeekday
      ? "every day"
      : parsed.anyDay
        ? describeWeekdays(parsed.weekdays)
        : parsed.anyWeekday
          ? describeMonthDays(parsed.days)
          : `${describeMonthDays(parsed.days)} or ${describeWeekdays(parsed.weekdays)}`;
  const months = isFull(parsed.months, 1, 12)
    ? ""
    : ` in ${listOf(parsed.months, (month) => MONTHS[month - 1]!)}`;
  return `${describeTime(parsed)}, ${days}${months}`;
}

// -----------------------------------------------------------------------------
// Run errors
// -----------------------------------------------------------------------------

/**
 * Lowest agent protocol that runs jobs.
 *
 * NOTE: Mirrors `JOBS_PROTOCOL_VERSION` in `packages/protocol`, which the dashboard
 * doesn't depend on.
 */
export const JOBS_AGENT_PROTOCOL = 6;

/**
 * Explains run errors the control plane records as codes; other errors read as written.
 *
 * @param error - The run's `error`.
 * @returns Text for the runs table and the run panel.
 * @example
 * explainRunError("unschedulable: agent_outdated");
 * // "No server runs an agent that can run jobs (agent protocol 6 or newer). …"
 */
export function explainRunError(error: string): string {
  if (error === "unschedulable: agent_outdated") {
    return `No server runs an agent that can run jobs (agent protocol ${JOBS_AGENT_PROTOCOL} or newer). Update the agent on your servers, then run it again.`;
  }
  return error;
}
