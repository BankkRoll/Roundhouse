import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** Props for {@link ActivityItem}. */
export interface ActivityItemProps {
  /** Small icon describing the kind of event. */
  icon?: ReactNode;
  /** Who did it; rendered bold. */
  actor: ReactNode;
  /** What they did, e.g. "added server". */
  action: ReactNode;
  /** What it was done to, rendered in mono. */
  target?: ReactNode;
  /** Relative time, right-aligned in mono, e.g. "4m". */
  time: string;
  /** ISO or locale timestamp exposed on hover and to assistive tech. */
  timestamp?: string;
  /** Extra classes. */
  className?: string;
}

/**
 * One line in an activity feed: icon, "actor action target", and a relative time.
 *
 * @param props - Event details.
 * @returns The rendered list item.
 */
export function ActivityItem({
  icon,
  actor,
  action,
  target,
  time,
  timestamp,
  className,
}: ActivityItemProps) {
  return (
    <li className={cn("flex items-start gap-2.5 py-2 text-sm", className)}>
      {icon ? (
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground [&_svg]:size-3">
          {icon}
        </span>
      ) : null}
      <p className="min-w-0 flex-1 leading-snug text-muted-foreground">
        <span className="font-medium text-foreground">{actor}</span> {action}
        {target ? (
          <>
            {" "}
            <span className="font-mono text-xs text-foreground">{target}</span>
          </>
        ) : null}
      </p>
      <time
        className="shrink-0 font-mono text-[11px] text-subtle-foreground"
        dateTime={timestamp}
        title={timestamp}
      >
        {time}
      </time>
    </li>
  );
}
