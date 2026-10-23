import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** Props for {@link KpiStrip}. */
export interface KpiStripProps {
  /** Accessible name of the group, e.g. "Workspace at a glance". */
  label: string;
  /** {@link Kpi} cells. */
  children: ReactNode;
  /** Extra classes, e.g. to change the column count. */
  className?: string;
}

/**
 * Headline figures in one container split by hairlines: two columns on a phone, one row
 * from 1024px. An odd last cell on a phone takes the full width rather than leaving half
 * a row empty.
 *
 * @param props - Accessible name and cells.
 * @returns The strip.
 * @example
 * <KpiStrip label="At a glance">
 *   <Kpi label="Servers online" value="3" unit="of 4" />
 * </KpiStrip>
 */
export function KpiStrip({ label, children, className }: KpiStripProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset is for form controls; this groups figures
    <div
      role="group"
      aria-label={label}
      className={cn(
        "grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border lg:auto-cols-fr lg:grid-flow-col lg:grid-cols-none",
        "[&>*:last-child:nth-child(odd)]:col-span-2 lg:[&>*:last-child:nth-child(odd)]:col-span-1",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Props for {@link Kpi}. */
export interface KpiProps {
  /** What the figure counts, in sentence case. Also names the cell for assistive tech. */
  label: string;
  /** The figure. Use a grey dash for a missing value, `0` for a real zero. */
  value: ReactNode;
  /** A smaller grey suffix, e.g. "of 4" or "failing". */
  unit?: ReactNode;
  /** One line of context under the figure. */
  sub?: ReactNode;
  /** Something drawn under the figure, e.g. a meter. */
  children?: ReactNode;
  /** Colour the figure as a problem, for a count that needs action. */
  alert?: boolean;
  /** Extra classes. */
  className?: string;
}

/**
 * One cell of a {@link KpiStrip}: label over a tabular figure, with an optional unit,
 * context line and drawing. A named region, so each figure can be found on its own.
 *
 * @param props - Label, value, unit and context.
 * @returns The cell.
 */
export function Kpi({ label, value, unit, sub, children, alert = false, className }: KpiProps) {
  return (
    <section
      aria-label={label}
      className={cn("flex min-w-0 flex-col bg-background px-4 py-3.5", className)}
    >
      <p className="text-[13px] text-muted-foreground">{label}</p>
      <p className="mt-1 flex items-baseline gap-1.5">
        <span
          className={cn(
            "text-2xl font-semibold tracking-tight tabular-nums",
            alert ? "text-danger" : "text-foreground",
          )}
        >
          {value}
        </span>
        {unit ? (
          <>
            {" "}
            <span className="text-sm text-muted-foreground">{unit}</span>
          </>
        ) : null}
      </p>
      {sub ? <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p> : null}
      {children ? <div className="mt-auto pt-2.5">{children}</div> : null}
    </section>
  );
}
