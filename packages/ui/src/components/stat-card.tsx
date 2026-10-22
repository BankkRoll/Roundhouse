import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { SectionLabel } from "./section-label";

/** Props for {@link StatCard}. */
export interface StatCardProps {
  /** Uppercase section label, e.g. "FLEET". */
  label: string;
  /** Headline value. Use "—" when there is no data yet. */
  value: ReactNode;
  /** Mono subline under the value. */
  sub?: ReactNode;
  /** Optional footer content such as a {@link Meter}. */
  children?: ReactNode;
  /** Optional icon or link in the top-right corner. */
  aside?: ReactNode;
  /** Extra classes. */
  className?: string;
}

/**
 * Summary card for the home page stat row.
 *
 * @param props - Label, value and optional subline/footer.
 * @returns The rendered card.
 */
export function StatCard({ label, value, sub, children, aside, className }: StatCardProps) {
  return (
    <section
      aria-label={label}
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-surface p-4",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>{label}</SectionLabel>
        {aside}
      </div>
      <div className="text-2xl font-semibold tracking-tight text-foreground tabular-nums">
        {value}
      </div>
      {sub ? <div className="font-mono text-[11px] text-muted-foreground">{sub}</div> : null}
      {children ? <div className="mt-auto pt-1">{children}</div> : null}
    </section>
  );
}
