import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** Props for {@link EmptyState}. */
export interface EmptyStateProps {
  /** Icon element shown above the title. */
  icon?: ReactNode;
  /** One-line headline. */
  title: string;
  /** Supporting copy. */
  description?: ReactNode;
  /** Call to action, typically a {@link Button}. */
  action?: ReactNode;
  /** Small mono tag above the title, e.g. "PHASE 1". */
  eyebrow?: string;
  /** Extra classes. */
  className?: string;
}

/**
 * Centered placeholder for empty lists and not-yet-built sections.
 *
 * @param props - Icon, copy and optional action.
 * @returns The rendered empty state.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  eyebrow,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border-strong px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface text-muted-foreground [&_svg]:size-4.5">
          {icon}
        </div>
      ) : null}
      <div className="grid max-w-sm gap-1">
        {eyebrow ? (
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-accent-text">
            {eyebrow}
          </p>
        ) : null}
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="mt-1 flex items-center gap-2">{action}</div> : null}
    </div>
  );
}
