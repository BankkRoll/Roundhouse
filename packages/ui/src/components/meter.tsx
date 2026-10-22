import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/** Severity of a utilisation value. */
export type MeterTone = "normal" | "warning" | "danger";

/**
 * Maps a utilisation percentage to a tone: amber above 70%, red above 90%.
 *
 * @param percent - Utilisation from 0 to 100.
 * @returns The tone to paint the meter with.
 */
export function meterTone(percent: number): MeterTone {
  if (percent > 90) return "danger";
  if (percent > 70) return "warning";
  return "normal";
}

/**
 * Clamps a percentage into the 0-100 range, treating non-finite input as 0.
 *
 * @param percent - Raw percentage.
 * @returns A value between 0 and 100.
 */
export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

const fillTone: Record<MeterTone, string> = {
  normal: "bg-meter-fill",
  warning: "bg-warning",
  danger: "bg-danger",
};

/** Props for {@link Meter}. */
export interface MeterProps extends Omit<ComponentProps<"div">, "children"> {
  /** Utilisation 0-100, or `null` when unknown (renders an empty track). */
  value: number | null;
  /** Accessible name, e.g. "Memory usage". */
  label: string;
  /** Human-readable value for screen readers, e.g. "71%, 11.4 of 16 GB". */
  valueText?: string;
}

/**
 * Thin 4px utilisation bar. Exposes `role="meter"` with the value so it is announced.
 *
 * @param props - Value, accessible label and div props.
 * @returns The rendered meter.
 */
export function Meter({ value, label, valueText, className, ...props }: MeterProps) {
  const known = value !== null && Number.isFinite(value);
  const percent = known ? clampPercent(value) : 0;
  return (
    // biome-ignore lint/a11y/useSemanticElements: native <meter> cannot be styled consistently across browsers
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? Math.round(percent) : undefined}
      aria-valuetext={valueText ?? (known ? `${Math.round(percent)}%` : "Unknown")}
      data-tone={known ? meterTone(percent) : "unknown"}
      className={cn("h-1 w-full overflow-hidden rounded-full bg-meter-track", className)}
      {...props}
    >
      {known ? (
        <div
          className={cn("h-full rounded-full transition-[width]", fillTone[meterTone(percent)])}
          style={{ width: `${percent}%` }}
        />
      ) : null}
    </div>
  );
}

/** Props for {@link MeterRow}. */
export interface MeterRowProps {
  /** Short label on the left, e.g. "CPU". */
  label: string;
  /** Utilisation 0-100 or `null` when unknown. */
  percent: number | null;
  /** Right-aligned mono value, e.g. "71% · 11.4/16 GB". */
  value: string;
  /** Accessible name for the bar. Defaults to `${label} usage`. */
  meterLabel?: string;
  /** Extra classes for the row. */
  className?: string;
}

/**
 * Labelled meter with a right-aligned mono value, as used on server cards.
 *
 * @param props - Label, percentage and display value.
 * @returns The rendered row.
 */
export function MeterRow({ label, percent, value, meterLabel, className }: MeterRowProps) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-[11px] text-foreground tabular-nums">{value}</span>
      </div>
      <Meter value={percent} label={meterLabel ?? `${label} usage`} valueText={value} />
    </div>
  );
}

/** One segment of a {@link StackedBar}. */
export interface StackedBarSegment {
  /** Legend label, e.g. "system". */
  label: string;
  /** Size in the same unit as `total`. */
  value: number;
  /** Tailwind background class for the segment. Defaults to the meter fill. */
  className?: string;
}

/** Props for {@link StackedBar}. */
export interface StackedBarProps {
  /** Segments drawn left to right. */
  segments: readonly StackedBarSegment[];
  /** Capacity the segments are measured against. */
  total: number;
  /** Accessible description of the whole bar. */
  label: string;
  /** Extra classes for the track. */
  className?: string;
}

/**
 * Horizontal bar split into segments of a total, e.g. RAM used per service vs capacity.
 *
 * @param props - Segments, total and accessible label.
 * @returns The rendered bar.
 */
export function StackedBar({ segments, total, label, className }: StackedBarProps) {
  const safeTotal = total > 0 ? total : 0;
  return (
    <div
      role="img"
      aria-label={label}
      className={cn("flex h-2 w-full overflow-hidden rounded-sm bg-meter-track", className)}
    >
      {safeTotal > 0
        ? segments.map((segment) => (
            <div
              key={segment.label}
              title={segment.label}
              className={cn("h-full bg-meter-fill", segment.className)}
              style={{ width: `${clampPercent((segment.value / safeTotal) * 100)}%` }}
            />
          ))
        : null}
    </div>
  );
}
