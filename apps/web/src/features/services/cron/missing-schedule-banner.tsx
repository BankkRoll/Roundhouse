import type { ReactNode } from "react";

/**
 * The notice on a cron service whose config has no `cron` part yet: services created
 * before cron jobs ran on a schedule kept their config, and the API refuses to deploy
 * them (422 `cron_schedule_required`) until a schedule is set (ADR 0010).
 *
 * @param props - `children`: the action that leads to the Cron settings, if any.
 * @returns The banner.
 */
export function MissingScheduleBanner({ children }: { children?: ReactNode }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 py-2 pr-2 pl-3.5 text-sm text-foreground"
    >
      <span>This cron job needs a schedule before it can deploy.</span>
      {children}
    </div>
  );
}
