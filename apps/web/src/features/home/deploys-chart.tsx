import { cn, Skeleton } from "@roundhouse/ui";
import { SectionHeader } from "../../components/section-header";
import { usePermissions } from "../../lib/permissions";
import { DEPLOY_HISTORY_DAYS, type DeployDay, useDeployHistory } from "../../queries/audit";

/**
 * The smallest round axis maximum at or above `max`, with an even split for a middle
 * tick: 2, 4, 6, 10, 20, 40, 60, 100…
 */
export function axisMax(max: number): number {
  if (max <= 2) return 2;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  for (const step of [1, 2, 4, 6, 10]) {
    if (step * magnitude >= max) return step * magnitude;
  }
  return 10 * magnitude;
}

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const LONG_DAY = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "short",
  day: "numeric",
});

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function Columns({ days }: { days: DeployDay[] }) {
  const top = axisMax(Math.max(0, ...days.map((day) => day.deploys)));
  const total = days.reduce((sum, day) => sum + day.deploys, 0);
  const ticks = [top, top / 2, 0];
  return (
    <figure className="m-0">
      <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-2">
        <div className="relative h-36" aria-hidden="true">
          {ticks.map((tick, index) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2 text-xs text-muted-foreground tabular-nums"
              style={{ top: `${(index / (ticks.length - 1)) * 100}%` }}
            >
              {tick}
            </span>
          ))}
        </div>
        <div className="relative h-36">
          {ticks.map((tick, index) => (
            <span
              key={tick}
              aria-hidden="true"
              className={cn(
                "absolute inset-x-0 h-px",
                tick === 0 ? "bg-border-strong" : "bg-border/70",
              )}
              style={{ top: `${(index / (ticks.length - 1)) * 100}%` }}
            />
          ))}
          <ol className="absolute inset-0 grid grid-cols-7 items-end gap-2 px-1 sm:gap-4">
            {days.map((day, index) => {
              const today = index === days.length - 1;
              const label = `${today ? "Today" : LONG_DAY.format(day.start)}: ${plural(day.deploys, "deploy")}${day.failed > 0 ? `, ${day.failed} failed` : ""}`;
              return (
                <li key={day.start} className="flex h-full items-end justify-center">
                  <span className="sr-only">{label}</span>
                  <span
                    aria-hidden="true"
                    title={label}
                    className={cn(
                      "w-full max-w-9 rounded-t-[3px] bg-accent-text",
                      !today && "opacity-60",
                    )}
                    style={{ height: day.deploys === 0 ? 0 : `${(day.deploys / top) * 100}%` }}
                  />
                </li>
              );
            })}
          </ol>
          {total === 0 ? (
            <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-muted-foreground">
              No deploys in the last {DEPLOY_HISTORY_DAYS} days.
            </p>
          ) : null}
        </div>
        <span />
        <div className="mt-2 grid grid-cols-7 gap-2 px-1 sm:gap-4" aria-hidden="true">
          {days.map((day, index) => (
            <span
              key={day.start}
              className={cn(
                "text-center text-xs",
                index === days.length - 1 ? "text-foreground" : "text-muted-foreground",
              )}
            >
              {index === days.length - 1 ? "Today" : WEEKDAY.format(day.start)}
            </span>
          ))}
        </div>
      </div>
    </figure>
  );
}

/**
 * Deploys started per day this week, as columns, counted from the audit log. Today is
 * drawn at full strength; failed deploys are named in each day's label.
 *
 * @param props - Workspace id.
 * @returns The block.
 */
export function DeploysChart({ workspaceId }: { workspaceId: string }) {
  const { can } = usePermissions(workspaceId);
  const allowed = can("audit:read");
  const history = useDeployHistory(workspaceId, allowed);

  return (
    <section aria-labelledby="deploys-heading">
      <SectionHeader
        id="deploys-heading"
        title="Deploys"
        meta={
          history.data
            ? `${plural(history.data.total, "deploy")} in the last ${DEPLOY_HISTORY_DAYS} days`
            : `Last ${DEPLOY_HISTORY_DAYS} days`
        }
      />
      {!allowed ? (
        <p className="text-sm text-muted-foreground">
          Deploy history comes from the audit log, which owners and admins can see.
        </p>
      ) : history.isPending ? (
        <Skeleton className="h-44" />
      ) : history.isError ? (
        <p className="text-sm text-muted-foreground">Could not load deploy history.</p>
      ) : (
        <Columns days={history.data.days} />
      )}
    </section>
  );
}
