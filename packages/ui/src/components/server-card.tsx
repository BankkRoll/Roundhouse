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
  /** Extra classes. */
  className?: string;
}

/**
 * Card summarising one server: identity, status, usage meters and a footer line.
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
  className,
}: ServerCardProps) {
  return (
    <article
      className={cn(
        "flex flex-col rounded-lg border border-border bg-surface transition-colors hover:border-border-strong",
        className,
      )}
    >
      <header className="flex items-start justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          <h3 className="truncate font-mono text-sm font-semibold text-foreground">{title}</h3>
          {meta ? (
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{meta}</p>
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
        <footer className="mt-auto flex items-center justify-between gap-2 border-t border-border px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate">{footer}</span>
          <span className="shrink-0">{footerAside}</span>
        </footer>
      ) : null}
    </article>
  );
}
