import { cn } from "@roundhouse/ui";
import { useCronRuns, useCronState } from "../../queries/cron";
import type { RunStatusMeta } from "../services/cron/cron-format";
import { formatSlot, RUN_STATUS } from "../services/cron/cron-format";

const TONE_DOT: Record<RunStatusMeta["tone"], string> = {
  neutral: "bg-muted-foreground",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

/** Props for {@link CronNodeSummary}. */
export interface CronNodeSummaryProps {
  /** Id the node points `aria-describedby` at. */
  id: string;
  serviceId: string;
  /** Environment the canvas shows; nothing loads while it is unknown (not deployed yet). */
  environmentId: string | undefined;
}

/**
 * A cron node's extra line: its next run in the schedule's zone (or that it is paused)
 * and the last run's status. It shares the Runs tab's queries, so realtime run updates
 * reach it too.
 *
 * @param props - Description id, service and environment.
 * @returns The line, or nothing before the service is deployed.
 */
export function CronNodeSummary({ id, serviceId, environmentId }: CronNodeSummaryProps) {
  const state = useCronState(serviceId, environmentId);
  const runs = useCronRuns(serviceId, environmentId);
  if (!state.data) return null;
  const last = runs.data?.pages[0]?.runs[0];
  const zone = state.data.timezone ?? "UTC";
  const next = state.data.next_run_at;
  const status = last ? RUN_STATUS[last.status] : null;
  return (
    <span
      id={id}
      className="flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground"
    >
      <span className="truncate tabular-nums">
        {state.data.paused
          ? "Paused"
          : next !== null
            ? `Next ${formatSlot(next, zone)}`
            : "No run scheduled"}
      </span>{" "}
      {status ? (
        <span className="flex shrink-0 items-center gap-1">
          <span aria-hidden="true" className={cn("size-1.5 rounded-full", TONE_DOT[status.tone])} />
          <span className="sr-only">last run {status.label}</span>
          <span aria-hidden="true">{status.label}</span>
        </span>
      ) : null}
    </span>
  );
}
