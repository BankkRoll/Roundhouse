import type { NodeStatus } from "@openrail/shared";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { MeterRow, type MeterRowProps } from "./meter";
import { StatusBadge } from "./status";

/** Props for {@link ServerCard}. */
export interface ServerCardProps {
  /** Server name. Pass a link element to make the card navigable. */
  title: ReactNode;
  /** Mono subline, e.g. "hetzner/linux · hel-1". */
  meta?: ReactNode;
  /** Node status shown top-right. */
  status: NodeStatus | (string & {});
  /** Utilisation rows (CPU, RAM, Disk). */
  metrics: readonly MeterRowProps[];
  /** Footer content on the left, e.g. "0 services · agent v0.1.0". */
  footer?: ReactNode;
  /** Footer content on the right, e.g. "seen 4s ago". */
  footerAside?: ReactNode;
  /**
   * `card` (default) is a bordered tile. `row` is a borderless list row: identity, the
   * three meters and the footer side by side from 1024px, stacked below.
   */
  layout?: "card" | "row";
  /** Extra classes. */
  className?: string;
}

/**
 * One server: identity, status, usage meters and a footer line, as a tile or a list row.
 *
 * @param props - Server details to render.
 * @returns The rendered card.
 */
export function ServerCard({
  title,
  meta,
  status,
  metrics,
  footer,
  footerAside,
  layout = "card",
  className,
}: ServerCardProps) {
  if (layout === "row") {
    return (
      <article
        className={cn(
          "grid gap-x-8 gap-y-3 py-4 sm:grid-cols-3 lg:grid-cols-[minmax(0,13rem)_repeat(3,minmax(0,1fr))_minmax(0,11.5rem)] lg:items-center",
          className,
        )}
      >
        <header className="min-w-0 sm:col-span-3 lg:col-span-1">
          <div className="flex items-center justify-between gap-3 lg:justify-start">
            <h3 className="truncate text-sm font-semibold text-foreground">{title}</h3>
            <StatusBadge status={status} className="shrink-0" />
          </div>
          {meta ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{meta}</p> : null}
        </header>
        {metrics.map((metric) => (
          <MeterRow key={metric.label} {...metric} />
        ))}
        {footer || footerAside ? (
          <footer className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-xs text-muted-foreground sm:col-span-3 lg:col-span-1 lg:flex-col lg:items-end lg:text-right">
            <span className="min-w-0">{footer}</span>
            <span className="shrink-0">{footerAside}</span>
          </footer>
        ) : null}
      </article>
    );
  }
  return (
    <article
      className={cn(
        "flex flex-col rounded-lg border border-border bg-surface transition-colors hover:border-border-strong",
        className,
      )}
    >
      <header className="flex items-start justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">{title}</h3>
          {meta ? (
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{meta}</p>
          ) : null}
        </div>
        <StatusBadge status={status} className="mt-0.5" />
      </header>
      <div className="grid gap-3 px-4 py-4">
        {metrics.map((metric) => (
          <MeterRow key={metric.label} {...metric} />
        ))}
      </div>
      {footer || footerAside ? (
        <footer className="mt-auto flex items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">{footer}</span>
          <span className="shrink-0">{footerAside}</span>
        </footer>
      ) : null}
    </article>
  );
}
