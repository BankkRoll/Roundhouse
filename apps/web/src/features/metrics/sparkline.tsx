import { cn } from "@roundhouse/ui";
import type { MetricPoint } from "../../lib/api/metrics-client";
import { linePath, segments } from "./scale";

/** Props for {@link Sparkline}. */
export interface SparklineProps {
  points: readonly MetricPoint[];
  /** Accessible name, e.g. `"CPU, last hour: 120m"`. */
  label: string;
  /**
   * Top of the scale, such as the limit, so a sparkline reads as headroom. The peak
   * is used when absent or smaller.
   */
  max?: number | null;
  width?: number;
  height?: number;
  /** CSS colour; the accent by default. */
  color?: string;
  className?: string;
}

/**
 * A word-sized trend line with no axes: breaks at gaps, scaled from zero to `max` (or
 * the peak). A flat dash stands in when there are no samples.
 *
 * @param props - Points, accessible name, scale and size.
 * @returns An SVG with `role="img"`.
 * @example
 * <Sparkline points={summary.cpu} max={summary.cpu_limit_millis} label="CPU, last hour" />
 */
export function Sparkline({
  points,
  label,
  max,
  width = 56,
  height = 16,
  color = "var(--accent-text)",
  className,
}: SparklineProps) {
  let peak = 0;
  for (const [, v] of points) if (v !== null && v > peak) peak = v;
  const top = Math.max(peak, max ?? 0) || 1;
  const first = points[0]?.[0] ?? 0;
  const span = Math.max(1, (points.at(-1)?.[0] ?? 0) - first);
  const pad = 1.5;
  const x = (t: number) => pad + ((t - first) / span) * (width - 2 * pad);
  const y = (v: number) => pad + (height - 2 * pad) * (1 - v / top);
  const runs = segments(points, x, y);

  return (
    <svg
      role="img"
      aria-label={label}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("shrink-0 overflow-visible", className)}
    >
      {runs.length === 0 ? (
        <line
          x1={pad}
          x2={width - pad}
          y1={height - pad}
          y2={height - pad}
          stroke="var(--border-strong)"
          strokeWidth={1}
          strokeDasharray="2 2"
        />
      ) : (
        runs.map((run) =>
          run.length === 1 ? (
            <circle key={run[0]!.x} cx={run[0]!.x} cy={run[0]!.y} r={1.25} fill={color} />
          ) : (
            <path
              key={run[0]!.x}
              d={linePath(run)}
              fill="none"
              stroke={color}
              strokeWidth={1.25}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ),
        )
      )}
    </svg>
  );
}
