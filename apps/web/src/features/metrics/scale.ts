/**
 * Pure geometry for the hand-rolled metric charts: "nice" value ticks (decimal, or in
 * powers of 1024 for bytes), UTC time ticks aligned to round intervals, SVG paths that
 * break at gaps, nearest-point lookup for the hover crosshair, and series summaries for
 * screen readers.
 *
 * @module
 */
import type { MetricPoint } from "../../lib/api/metrics-client";

/** A point mapped to pixels. */
export interface PlotPoint {
  x: number;
  y: number;
}

const NICE_STEPS = [1, 2, 2.5, 5, 10] as const;

function niceStep(raw: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const step = NICE_STEPS.find((s) => s >= normalized - 1e-9) ?? 10;
  return step * magnitude;
}

/**
 * Value-axis ticks from zero up to a round number at or above `max`.
 *
 * With `binary`, ticks are round in the largest power of 1024 below `max`, so a bytes
 * axis reads "256 MB, 512 MB" rather than "238.4 MB, 476.8 MB".
 *
 * @param max - Largest value to cover; zero or less yields a unit axis.
 * @param options - `count`: about how many intervals (default 4); `binary`: 1024-based.
 * @returns Ascending ticks, the first `0`, the last the axis top.
 * @example
 * niceTicks(340); // [0, 100, 200, 300, 400]
 * niceTicks(300 * 1024 ** 2, { binary: true }); // [0, 100 MiB, 200 MiB, 300 MiB]
 */
export function niceTicks(
  max: number,
  options: { count?: number; binary?: boolean } = {},
): number[] {
  const count = options.count ?? 4;
  if (!Number.isFinite(max) || max <= 0) return [0, 1];
  const unit =
    options.binary && max >= 1024 ? 1024 ** Math.floor(Math.log(max) / Math.log(1024)) : 1;
  const scaled = max / unit;
  const step = niceStep(scaled / count);
  const top = Math.ceil(scaled / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let i = 0; i <= Math.round(top / step); i++)
    ticks.push(Number((i * step).toPrecision(12)) * unit);
  return ticks;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TIME_INTERVALS = [
  MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
] as const;

/** Time-axis ticks and the interval they were aligned to. */
export interface TimeTicks {
  ticks: number[];
  intervalMs: number;
}

/**
 * Time-axis ticks on round UTC boundaries (every 15 min, every 6 h, every midnight).
 *
 * @param from - Range start, unix ms.
 * @param to - Range end, unix ms.
 * @param maxTicks - Most ticks that fit the chart's width.
 * @returns Ticks inside `[from, to]` and their interval.
 */
export function timeTicks(from: number, to: number, maxTicks: number): TimeTicks {
  const span = Math.max(1, to - from);
  const limit = Math.max(2, maxTicks);
  const intervalMs =
    TIME_INTERVALS.find((interval) => span / interval <= limit) ?? TIME_INTERVALS.at(-1)!;
  const ticks: number[] = [];
  for (let t = Math.ceil(from / intervalMs) * intervalMs; t <= to; t += intervalMs) ticks.push(t);
  return { ticks, intervalMs };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Label of a time tick, in UTC like every other timestamp in the dashboard.
 *
 * @param t - Tick, unix ms.
 * @param intervalMs - Interval the ticks were aligned to.
 * @returns `"14:30"` below a day, `"Oct 22"` for daily ticks.
 */
export function formatTimeTick(t: number, intervalMs: number): string {
  const date = new Date(t);
  if (intervalMs >= DAY) return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return date.toISOString().slice(11, 16);
}

/**
 * Splits a series into runs of consecutive non-null points, mapped to pixels. A `null`
 * value ends a run, so the chart draws a break instead of bridging missing data.
 *
 * @param points - Series points, oldest first.
 * @param x - Maps a timestamp to an x pixel.
 * @param y - Maps a value to a y pixel.
 * @returns Runs, each with at least one point.
 */
export function segments(
  points: readonly MetricPoint[],
  x: (t: number) => number,
  y: (value: number) => number,
): PlotPoint[][] {
  const runs: PlotPoint[][] = [];
  let run: PlotPoint[] = [];
  for (const [t, value] of points) {
    if (value === null) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push({ x: x(t), y: y(value) });
    }
  }
  if (run.length) runs.push(run);
  return runs;
}

const r = (n: number) => Math.round(n * 10) / 10;

/**
 * SVG path of one run as a polyline.
 *
 * @param run - Points of a run.
 * @returns `d` attribute, e.g. `"M0 10L5 8"`.
 */
export function linePath(run: readonly PlotPoint[]): string {
  return run.map((p, i) => `${i === 0 ? "M" : "L"}${r(p.x)} ${r(p.y)}`).join("");
}

/**
 * SVG path of one run filled down to the baseline.
 *
 * @param run - Points of a run.
 * @param baseline - y pixel of zero.
 * @returns Closed `d` attribute.
 */
export function areaPath(run: readonly PlotPoint[], baseline: number): string {
  const first = run[0];
  const last = run.at(-1);
  if (!first || !last) return "";
  return `${linePath(run)}L${r(last.x)} ${r(baseline)}L${r(first.x)} ${r(baseline)}Z`;
}

/**
 * Index of the timestamp nearest to `t`.
 *
 * @param times - Ascending timestamps.
 * @param t - Target timestamp.
 * @returns Index into `times`, or `-1` when it is empty.
 */
export function nearestIndex(times: readonly number[], t: number): number {
  if (times.length === 0) return -1;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1]! - t) <= Math.abs(times[lo]! - t)) return lo - 1;
  return lo;
}

/** Average, peak and newest value of a series. */
export interface SeriesSummary {
  avg: number | null;
  max: number | null;
  latest: number | null;
}

/**
 * Summarises a series, skipping gaps.
 *
 * @param points - Series points, oldest first.
 * @returns Average, peak and newest non-null value; all `null` without samples.
 */
export function summarize(points: readonly MetricPoint[]): SeriesSummary {
  let sum = 0;
  let count = 0;
  let max: number | null = null;
  let latest: number | null = null;
  for (const [, value] of points) {
    if (value === null) continue;
    sum += value;
    count += 1;
    max = max === null ? value : Math.max(max, value);
    latest = value;
  }
  return { avg: count ? sum / count : null, max, latest };
}

/**
 * Whether any point of any series carries a value.
 *
 * @param series - Series to check.
 * @returns `false` when every point is a gap (or there are none).
 */
export function hasSamples(series: readonly { points: readonly MetricPoint[] }[]): boolean {
  return series.some((s) => s.points.some(([, value]) => value !== null));
}
