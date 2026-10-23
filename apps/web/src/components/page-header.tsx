import type { ReactNode } from "react";

/** Props for {@link PageHeader}. */
export interface PageHeaderProps {
  /** Page title (rendered as the page's h1). */
  title: ReactNode;
  /** One grey line under the title: the scope, the finding, or a count. */
  subline?: ReactNode;
  /** Buttons aligned to the right. */
  actions?: ReactNode;
}

/**
 * Standard page heading: h1, a grey subline, and right-aligned actions that wrap under
 * the title on narrow screens.
 *
 * @param props - Title, subline and actions.
 * @returns The header.
 */
export function PageHeader({ title, subline, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 lg:mb-8">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        {subline ? <p className="mt-1 text-sm text-muted-foreground">{subline}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
