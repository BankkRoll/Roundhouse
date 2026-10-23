/**
 * Five-field cron expressions (minute, hour, day of month, month, day of
 * week), evaluated in UTC, for backup schedules (ADR 0004) and later cron
 * services (ADR 0010).
 *
 * Grammar per field: `*`, a number, `a-b`, `*` or `a-b` with `/step`, and
 * comma-separated lists of those. Day of week is 0–7 with both 0 and 7 for
 * Sunday. As in Vixie cron, when both day of month and day of week are
 * restricted, a day matches if either does.
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

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

/** Thrown for an expression that doesn't parse. */
export class CronSyntaxError extends Error {
  override name = "CronSyntaxError";
}

function parseField(text: string, f: (typeof FIELDS)[number]): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!m) throw new CronSyntaxError(`invalid ${f.name} "${part}"`);
    const step = m[4] === undefined ? 1 : Number(m[4]);
    let lo: number = f.min;
    let hi: number = f.max;
    if (m[1] !== "*") {
      lo = Number(m[2]);
      hi = m[3] === undefined ? (m[4] === undefined ? lo : f.max) : Number(m[3]);
    }
    if (step < 1 || lo < f.min || hi > f.max || lo > hi) {
      throw new CronSyntaxError(`${f.name} "${part}" is out of range ${f.min}-${f.max}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/**
 * Parses a five-field expression.
 *
 * @param expr - E.g. `0 3 * * *`.
 * @returns The schedule.
 * @throws {CronSyntaxError} When a field is malformed or out of range.
 * @example
 * parseCron("*\/15 * * * *").minutes.size; // 4
 */
export function parseCron(expr: string): CronSchedule {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronSyntaxError("expected 5 fields");
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => parseField(p, FIELDS[i]!));
  if (weekdays!.has(7)) weekdays!.add(0);
  weekdays!.delete(7);
  return {
    minutes: minutes!,
    hours: hours!,
    days: days!,
    months: months!,
    weekdays: weekdays!,
    anyDay: parts[2] === "*" || parts[2] === "*/1",
    anyWeekday: parts[4] === "*" || parts[4] === "*/1",
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

function dayMatches(s: CronSchedule, d: Date): boolean {
  if (!s.months.has(d.getUTCMonth() + 1)) return false;
  const dom = s.days.has(d.getUTCDate());
  const dow = s.weekdays.has(d.getUTCDay());
  if (s.anyDay && s.anyWeekday) return true;
  if (s.anyDay) return dow;
  if (s.anyWeekday) return dom;
  return dom || dow;
}

/**
 * The first run strictly after `after`, in UTC, to the minute.
 *
 * Walks days, then hours, then minutes, so it costs at most a few thousand
 * steps even for a yearly schedule.
 *
 * @param expr - A five-field expression, or its parsed form.
 * @param after - Unix milliseconds.
 * @returns Unix milliseconds of the next run, or `null` when none falls in the next 5 years
 *   (e.g. `0 0 31 2 *`).
 * @example
 * nextCronRun("0 3 * * *", Date.UTC(2026, 0, 1, 4)); // Date.UTC(2026, 0, 2, 3)
 */
export function nextCronRun(expr: string | CronSchedule, after: number): number | null {
  const s = typeof expr === "string" ? parseCron(expr) : expr;
  const start = new Date(Math.floor(after / 60_000) * 60_000 + 60_000);
  const minutes = [...s.minutes].sort((a, b) => a - b);
  const hours = [...s.hours].sort((a, b) => a - b);
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  for (let i = 0; i < 366 * 5; i++, day.setUTCDate(day.getUTCDate() + 1)) {
    if (!dayMatches(s, day)) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const t = day.getTime() + h * 3_600_000 + m * 60_000;
        if (t >= start.getTime()) return t;
      }
    }
  }
  return null;
}

/**
 * The next `count` runs after `after`, for a schedule preview.
 *
 * @param expr - A five-field expression.
 * @param after - Unix milliseconds.
 * @param count - How many runs.
 * @returns Up to `count` unix-millisecond times, ascending.
 */
export function nextCronRuns(expr: string, after: number, count: number): number[] {
  const s = parseCron(expr);
  const out: number[] = [];
  let t = after;
  while (out.length < count) {
    const next = nextCronRun(s, t);
    if (next === null) break;
    out.push(next);
    t = next;
  }
  return out;
}
