import type { ReactNode } from "react";

/** Props for {@link SectionHeader}. */
export interface SectionHeaderProps {
  /** Id for the heading, so the section can be labelled by it. */
  id: string;
  /** The section's name, rendered as an `h2`. */
  title: ReactNode;
  /** A grey note after the title: a count, a period, a freshness stamp. */
  meta?: ReactNode;
  /** A quiet action on the right, such as a "View all" link. */
  action?: ReactNode;
}

/**
 * Heading row of a block on an overview page: title and grey note on the left, one
 * quiet action on the right. The block itself sits on the page, not in a card.
 *
 * @param props - Id, title, note and action.
 * @returns The header row.
 */
export function SectionHeader({ id, title, meta, action }: SectionHeaderProps) {
  return (
    <div className="mb-3 flex min-h-7 items-center justify-between gap-3">
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 id={id} className="text-[15px] font-semibold text-foreground">
          {title}
        </h2>
        {meta ? <span className="truncate text-sm text-muted-foreground">{meta}</span> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** Classes for the quiet text link in a {@link SectionHeader}. */
export const sectionLinkClasses =
  "rounded-sm text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
