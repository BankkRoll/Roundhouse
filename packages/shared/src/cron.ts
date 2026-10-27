/**
 * Cron schedules: the parser and the slot calculator for backup policies
 * (ADR 0004, always UTC) and cron services (ADR 0010, in any IANA zone).
 * It is the only implementation; agents never parse schedules.
 *
 * - Five fields, in order: minute 0–59, hour 0–23, day of month 1–31, month
 *   1–12 or `JAN`–`DEC`, day of week 0–7 (0 and 7 are Sunday) or
 *   `SUN`–`SAT`. Names are case-insensitive.
 * - Per field: `*`, a value, `a-b`, `a-b/n`, `*\/n`, `a/n` (from `a` to the
 *   end), and comma lists of these.
 * - Macros: `@yearly`/`@annually`, `@monthly`, `@weekly`, `@daily`/`@midnight`,
 *   `@hourly`.
 * - As in crontab(5), when both day of month and day of week are restricted
 *   (neither is `*`), a day matches if either does.
 * - Seconds, `?`, `L`, `W`, `#`, `@reboot` and steps larger than the field's
 *   range are rejected with a {@link ScheduleError} pointing at the input.
 * - Slots are computed in the zone's wall-clock time. A wall time skipped by
 *   a spring-forward gap runs once, at the first instant after the gap; one
 *   repeated by a fall-back change runs once, at its first occurrence.
 *
 * @module
 */

/** A parsed expression: the allowed values of each field. */
export interface CronSchedule {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  /** Day of month was `*` (or `*` with a step of 1). */
  anyDay: boolean;
  /** Day of week was `*`. */
  anyWeekday: boolean;
}

/** Why a schedule or zone was refused; offsets index the input string. */
export interface ScheduleError {
  code: "invalid_schedule" | "invalid_timezone";
  message: string;
  /** Offset of the first offending character. */
  start: number;
  /** Offset just past the last offending character. */
  end: number;
}

/** Thrown for an expression that doesn't parse; carries the {@link ScheduleError} span. */
export class CronSyntaxError extends Error {
  override name = "CronSyntaxError";
  /** Offset of the first offending character. */
  readonly start: number;
  /** Offset just past the last offending character. */
  readonly end: number;

  constructor(message: string, start = 0, end = 0) {
    super(message);
    this.start = start;
    this.end = end;
  }
}

/** Default zone of a cron service's schedule. */
export const DEFAULT_CRON_TIMEZONE = "UTC";

/** Longest schedule string accepted. */
export const MAX_SCHEDULE_LENGTH = 120;

const FIELDS = [
  { name: "minute", min: 0, max: 59, names: null },
  { name: "hour", min: 0, max: 23, names: null },
  { name: "day of month", min: 1, max: 31, names: null },
  {
    name: "month",
    min: 1,
    max: 12,
    names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"],
  },
  { name: "day of week", min: 0, max: 7, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] },
] as const;

type Field = (typeof FIELDS)[number];

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

/** A value of a field, a number or (for months and weekdays) a name. */
function fieldValue(token: string, f: Field, at: number): number {
  if (/^\d{1,2}$/.test(token)) return Number(token);
  if (f.names) {
    const i = (f.names as readonly string[]).indexOf(token.toUpperCase());
    if (i >= 0) return f.name === "month" ? i + 1 : i;
  }
  throw new CronSyntaxError(`invalid ${f.name} "${token}"`, at, at + token.length);
}

function parseField(text: string, f: Field, offset: number): Set<number> {
  const out = new Set<number>();
  let at = offset;
  for (const part of text.split(",")) {
    const end = at + part.length;
    // `?` and `#` never appear in a supported field, and neither do `L` or
    // `W` outside month and weekday names (Quartz-style day modifiers).
    const unsupported = f.names ? /[?#]/.exec(part) : /[?#LW]/i.exec(part);
    if (unsupported) {
      throw new CronSyntaxError(
        `"${unsupported[0]}" is not supported in the ${f.name} field`,
        at + unsupported.index,
        at + unsupported.index + 1,
      );
    }
    const m = /^(\*|([0-9A-Za-z]{1,3})(?:-([0-9A-Za-z]{1,3}))?)(?:\/(\d{1,3}))?$/.exec(part);
    if (!m) throw new CronSyntaxError(`invalid ${f.name} "${part}"`, at, end);
    const step = m[4] === undefined ? 1 : Number(m[4]);
    let lo: number = f.min;
    let hi: number = f.max;
    if (m[1] !== "*") {
      lo = fieldValue(m[2]!, f, at);
      hi =
        m[3] === undefined
          ? m[4] === undefined
            ? lo
            : f.max
          : fieldValue(m[3], f, at + m[2]!.length + 1);
    }
    if (step < 1 || step > f.max - f.min + 1) {
      throw new CronSyntaxError(
        `step ${step} is outside the ${f.name} range ${f.min}-${f.max}`,
        at,
        end,
      );
    }
    if (lo < f.min || hi > f.max || lo > hi) {
      throw new CronSyntaxError(`${f.name} "${part}" is out of range ${f.min}-${f.max}`, at, end);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
    at = end + 1;
  }
  return out;
}

/**
 * Parses a five-field expression or a macro.
 *
 * @param expr - E.g. `0 3 * * *`, `*\/15 9-17 * * MON-FRI` or `@daily`.
 * @returns The schedule.
 * @throws {CronSyntaxError} When a field is malformed, unsupported or out of range.
 * @example
 * parseCron("*\/15 * * * *").minutes.size; // 4
 */
export function parseCron(expr: string): CronSchedule {
  if (expr.length > MAX_SCHEDULE_LENGTH) {
    throw new CronSyntaxError(
      `longer than ${MAX_SCHEDULE_LENGTH} characters`,
      MAX_SCHEDULE_LENGTH,
      expr.length,
    );
  }
  const lead = expr.length - expr.trimStart().length;
  const trimmed = expr.trim();
  if (trimmed.startsWith("@")) {
    const macro = MACROS[trimmed.toLowerCase()];
    if (!macro) {
      throw new CronSyntaxError(
        trimmed.toLowerCase() === "@reboot"
          ? "@reboot is not supported"
          : `unknown macro "${trimmed}"`,
        lead,
        lead + trimmed.length,
      );
    }
    return parseCron(macro);
  }
  const parts: { text: string; start: number }[] = [];
  for (const m of trimmed.matchAll(/\S+/g)) parts.push({ text: m[0], start: lead + m.index });
  if (parts.length === 6) {
    throw new CronSyntaxError("seconds are not supported; use five fields", lead, expr.length);
  }
  if (parts.length !== 5) {
    throw new CronSyntaxError(
      `expected 5 fields, got ${parts.length}`,
      lead,
      Math.max(lead, expr.trimEnd().length),
    );
  }
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) =>
    parseField(p.text, FIELDS[i]!, p.start),
  );
  if (weekdays!.has(7)) weekdays!.add(0);
  weekdays!.delete(7);
  return {
    minutes: minutes!,
    hours: hours!,
    days: days!,
    months: months!,
    weekdays: weekdays!,
    anyDay: parts[2]!.text === "*" || parts[2]!.text === "*/1",
    anyWeekday: parts[4]!.text === "*" || parts[4]!.text === "*/1",
  };
}

/**
 * Whether an expression parses.
 *
 * @param expr - Candidate expression.
 * @returns `true` when {@link parseCron} accepts it.
 */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a string names a time zone this runtime knows (an IANA name such
 * as `Europe/Berlin`, or `UTC`).
 *
 * @param timezone - Candidate zone.
 * @returns `true` when `Intl.DateTimeFormat` accepts it.
 */
export function isValidTimeZone(timezone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/.test(timezone)) return false;
  try {
    formatter(timezone);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks a schedule and zone without throwing, for the API and the
 * dashboard's live preview.
 *
 * @param schedule - Expression or macro.
 * @param timezone - IANA zone.
 * @returns `null` when both are valid, else the first problem.
 */
export function scheduleError(schedule: string, timezone: string): ScheduleError | null {
  try {
    parseCron(schedule);
  } catch (err) {
    if (!(err instanceof CronSyntaxError)) throw err;
    return { code: "invalid_schedule", message: err.message, start: err.start, end: err.end };
  }
  if (!isValidTimeZone(timezone)) {
    return {
      code: "invalid_timezone",
      message: `unknown time zone "${timezone}"`,
      start: 0,
      end: timezone.length,
    };
  }
  return null;
}

// -----------------------------------------------------------------------------
// Time zones
// -----------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    if (formatters.size > 64) formatters.clear();
    formatters.set(timezone, f);
  }
  return f;
}

/** Wall-clock fields of an instant in a zone. */
interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function wallOf(timezone: string, t: number): Wall & { second: number } {
  const out = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of formatter(timezone).formatToParts(new Date(t))) {
    if (p.type in out) out[p.type as keyof typeof out] = Number(p.value);
  }
  return out;
}

/** The zone's offset from UTC at `t`, in ms (local − UTC). */
function offsetAt(timezone: string, t: number): number {
  if (timezone === "UTC") return 0;
  const w = wallOf(timezone, t);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

/**
 * The instant a wall time runs at: itself when it exists once, its first
 * occurrence when a fall-back change repeats it, and the first instant
 * after the gap when a spring-forward change skips it.
 */
function instantOf(timezone: string, wallMs: number, before: number, after: number): number {
  if (before === after) return wallMs - before;
  const candidates = [wallMs - before, wallMs - after]
    .filter((t) => offsetAt(timezone, t) + t === wallMs)
    .sort((a, b) => a - b);
  if (candidates.length) return candidates[0]!;
  // In the gap: find the transition, the first minute on the later offset.
  let lo = wallMs - Math.max(before, after) - DAY;
  let hi = wallMs - Math.min(before, after) + DAY;
  const early = offsetAt(timezone, lo);
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (offsetAt(timezone, mid) === early) lo = mid;
    else hi = mid;
  }
  return hi;
}

function dayMatches(s: CronSchedule, year: number, month: number, day: number): boolean {
  if (!s.months.has(month)) return false;
  const dom = s.days.has(day);
  const dow = s.weekdays.has(new Date(Date.UTC(year, month - 1, day)).getUTCDay());
  if (s.anyDay && s.anyWeekday) return true;
  if (s.anyDay) return dow;
  if (s.anyWeekday) return dom;
  return dom || dow;
}

/** Days scanned before a schedule is declared never to fire; covers 29 February. */
const MAX_SCAN_DAYS = 366 * 8 + 2;

/**
 * The next `count` slots of a schedule strictly after `from`, in a zone.
 *
 * Walks local days; within each matching day the zone's offset is read at
 * its start and end, so only days with a DST change pay for the careful
 * conversion.
 *
 * @param schedule - Expression, macro, or a parsed schedule.
 * @param timezone - IANA zone the schedule is read in.
 * @param from - Unix ms; slots must be strictly later.
 * @param count - How many slots (at most 10,000).
 * @returns Up to `count` unix-ms instants, ascending and distinct; fewer when
 *   the schedule never fires again within eight years (e.g. `0 0 31 2 *`).
 * @throws {CronSyntaxError} For an invalid expression; `RangeError` for an unknown zone.
 * @example
 * nextRuns("0 3 * * *", "Europe/Berlin", Date.UTC(2026, 9, 22), 1);
 * // [Date.UTC(2026, 9, 22, 1)] — 03:00 CEST
 */
export function nextRuns(
  schedule: string | CronSchedule,
  timezone: string,
  from: number,
  count: number,
): number[] {
  const s = typeof schedule === "string" ? parseCron(schedule) : schedule;
  const want = Math.min(Math.max(0, Math.floor(count)), 10_000);
  const out: number[] = [];
  if (!want) return out;
  const minutes = [...s.minutes].sort((a, b) => a - b);
  const hours = [...s.hours].sort((a, b) => a - b);
  // Start a day early: the local date at `from` may be behind UTC's.
  const start = wallOf(timezone, from);
  const first = Date.UTC(start.year, start.month - 1, start.day) - DAY;
  for (let i = 0; i < MAX_SCAN_DAYS && out.length < want; i++) {
    const dayMs = first + i * DAY;
    const d = new Date(dayMs);
    if (!dayMatches(s, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())) continue;
    const before = offsetAt(timezone, dayMs - offsetAt(timezone, dayMs) - DAY / 2);
    const after = offsetAt(timezone, dayMs + DAY - offsetAt(timezone, dayMs + DAY) + DAY / 2);
    for (const h of hours) {
      for (const m of minutes) {
        const wallMs = dayMs + h * 3_600_000 + m * MINUTE;
        const t = instantOf(timezone, wallMs, before, after);
        if (t <= from || (out.length && t <= out[out.length - 1]!)) continue;
        out.push(t);
        if (out.length === want) return out;
      }
    }
  }
  return out;
}

/**
 * The first run strictly after `after`, in UTC, to the minute.
 *
 * @param expr - A five-field expression, or its parsed form.
 * @param after - Unix milliseconds.
 * @returns Unix milliseconds of the next run, or `null` when none falls in the next eight years.
 * @example
 * nextCronRun("0 3 * * *", Date.UTC(2026, 0, 1, 4)); // Date.UTC(2026, 0, 2, 3)
 */
export function nextCronRun(expr: string | CronSchedule, after: number): number | null {
  return nextRuns(expr, "UTC", after, 1)[0] ?? null;
}

/**
 * The next `count` UTC runs after `after`, for a schedule preview.
 *
 * @param expr - A five-field expression.
 * @param after - Unix milliseconds.
 * @param count - How many runs.
 * @returns Up to `count` unix-millisecond times, ascending.
 */
export function nextCronRuns(expr: string, after: number, count: number): number[] {
  return nextRuns(expr, "UTC", after, count);
}
