import type { ReactNode } from "react";

/** Props for {@link PageHeader}. */
export interface PageHeaderProps {
  /** Page title (rendered as the page's h1). */
  title: ReactNode;
  /** Mono subline under the title. */
  subline?: ReactNode;
  /** Buttons aligned to the right. */
  actions?: ReactNode;
}

/**
 * Standard page heading: h1, mono subline, and right-aligned actions.
 *
 * @param props - Title, subline and actions.
 * @returns The header.
 */
export function PageHeader({ title, subline, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        {subline ? <p className="mt-1 font-mono text-xs text-muted-foreground">{subline}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
