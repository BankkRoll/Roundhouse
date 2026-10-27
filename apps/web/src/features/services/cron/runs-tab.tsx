/**
 * A cron service's Runs tab (ADR 0010): schedule state and actions, the run history,
 * and each run's output.
 *
 * @module
 */
import { CRON_RUN_STATUSES, type CronRunStatus, isTerminalCronRunStatus } from "@roundhouse/shared";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  EmptyState,
  Select,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import { PauseIcon, PlayIcon, TimerIcon } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import { ErrorState } from "../../../components/error-state";
import { errorMessage, isApiError } from "../../../lib/api/client";
import type { CronRun, CronState } from "../../../lib/api/cron-client";
import { formatDuration, formatRelativeTime, formatTimestamp } from "../../../lib/format";
import { useNow } from "../../../lib/use-now";
import {
  useCancelCronRun,
  useCronRun,
  useCronRuns,
  useCronState,
  useSetCronPaused,
  useTriggerCronRun,
} from "../../../queries/cron";
import { useServiceConfig } from "../../../queries/services";
import { LockedButton, useEnvironmentGate } from "../../access/environment-gate";
import { findService, useProjectEnvironment } from "../../projects/use-project-environment";
import { LogViewer } from "../logs/log-viewer";
import { useLogStream } from "../logs/use-log-stream";
import type { ServicePageProps } from "../service-layout";
import { SERVICE_TAB_PATHS } from "../tabs";
import { explainRunError, formatSlot, RUN_STATUS, RUN_TRIGGER } from "./cron-format";
import { MissingScheduleBanner } from "./missing-schedule-banner";

function RunStatus({ run }: { run: Pick<CronRun, "status"> }) {
  const meta = RUN_STATUS[run.status];
  return (
    <Badge tone={meta.tone} data-status={run.status}>
      {meta.label}
    </Badge>
  );
}

/**
 * What a run row says in its main cell instead of the slot: a missed record reads as a
 * count with the outage it covers, taken from the API's `error` (`N runs missed between
 * <ISO> and <ISO>`, or `1 run missed at <ISO>`).
 *
 * @param run - A run.
 * @param timezone - Zone to show the outage in.
 * @returns `null` for runs that aren't missed records.
 * @example
 * runSummary(missed, "UTC"); // "12 runs missed (control plane unavailable 09:02–09:13)"
 */
export function runSummary(run: CronRun, timezone = "UTC"): string | null {
  if (run.status !== "missed") return null;
  const count = run.missed_count ?? 1;
  const head = `${count} run${count === 1 ? "" : "s"} missed`;
  const time = (iso: string | undefined) => {
    const t = iso ? Date.parse(iso) : Number.NaN;
    return Number.isNaN(t) ? null : formatSlot(t, timezone).slice(-5);
  };
  const between = /between (\S+) and (\S+)$/.exec(run.error ?? "");
  const from = time(between?.[1]);
  const to = time(between?.[2]);
  if (from && to) return `${head} (control plane unavailable ${from}–${to})`;
  const at = time(/ at (\S+)$/.exec(run.error ?? "")?.[1]);
  return at ? `${head} (control plane unavailable at ${at})` : head;
}

function runDuration(run: CronRun, now: number): string {
  if (run.started_at === null) return "—";
  return formatDuration((run.finished_at ?? now) - run.started_at);
}

function StateHeader({
  state,
  canRun,
  canManage,
  runLocked,
  manageLocked,
  onRun,
  running,
  onTogglePause,
  toggling,
}: {
  state: CronState;
  canRun: boolean;
  canManage: boolean;
  /** Why a protected environment keeps the caller from running it, if one does. */
  runLocked: string | null;
  /** Why a protected environment keeps the caller from pausing it, if one does. */
  manageLocked: string | null;
  onRun: () => void;
  running: boolean;
  onTogglePause: () => void;
  toggling: boolean;
}) {
  const armed = state.armed_deployment_id !== null;
  const zone = state.timezone ?? "UTC";
  return (
    <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">State</dt>
        <dd className="flex items-center gap-2">
          {!armed ? (
            <Badge tone="neutral">Not deployed yet</Badge>
          ) : state.paused ? (
            <Badge tone="warning">Paused</Badge>
          ) : (
            <Badge tone="success">Active</Badge>
          )}
        </dd>
        <dt className="text-muted-foreground">Schedule</dt>
        <dd className="font-mono text-xs text-foreground">
          {state.schedule ? `${state.schedule} (${zone})` : "Deploy to arm the schedule"}
        </dd>
        <dt className="text-muted-foreground">Next run</dt>
        <dd className="text-foreground tabular-nums">
          {state.next_run_at !== null ? (
            <time
              dateTime={new Date(state.next_run_at).toISOString()}
              title={formatTimestamp(state.next_run_at)}
            >
              {formatSlot(state.next_run_at, zone)} ({zone})
            </time>
          ) : (
            "—"
          )}
        </dd>
      </dl>
      <div className="flex items-center gap-2">
        {manageLocked && armed ? (
          <LockedButton variant="secondary" reason={manageLocked}>
            {state.paused ? "Resume" : "Pause"}
          </LockedButton>
        ) : canManage && armed ? (
          <Button variant="secondary" onClick={onTogglePause} loading={toggling}>
            {toggling ? null : state.paused ? <PlayIcon /> : <PauseIcon />}
            {state.paused ? "Resume" : "Pause"}
          </Button>
        ) : null}
        {runLocked ? (
          <LockedButton variant="primary" reason={runLocked}>
            Run now
          </LockedButton>
        ) : canRun ? (
          <Button variant="primary" onClick={onRun} loading={running} disabled={!armed}>
            {running ? null : <PlayIcon />}
            Run now
          </Button>
        ) : null}
      </div>
    </header>
  );
}

/**
 * A run's output in a side panel, live while it runs, with its status and a Cancel action.
 * Also opened from a deployment's timeline for its pre-deploy command, which runs the same way.
 *
 * @param props - The run to show (`null` closes it), the close handler, and whether the
 *   caller may cancel.
 * @returns The panel.
 */
export function RunLogsDialog({
  runId,
  onOpenChange,
  canCancel,
}: {
  runId: string | null;
  onOpenChange: (open: boolean) => void;
  canCancel: boolean;
}) {
  const run = useCronRun(runId);
  const cancel = useCancelCronRun();
  const stream = useLogStream(runId ? { kind: "job", runId } : null);
  const [follow, setFollow] = useState(true);
  const current = run.data;
  const active = current ? !isTerminalCronRunStatus(current.status) : false;
  return (
    <Dialog open={runId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="top-0 right-0 left-auto flex h-dvh max-h-dvh w-full max-w-3xl translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-y-0 border-r-0 p-0">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 pr-12">
          <div className="min-w-0">
            <DialogTitle>Run {runId}</DialogTitle>
            <DialogDescription className="mt-0.5 flex flex-wrap items-center gap-2">
              {current ? (
                <>
                  <RunStatus run={current} />
                  <span>{RUN_TRIGGER[current.trigger]}</span>
                  <span>slot {formatTimestamp(current.scheduled_for)}</span>
                  {current.exit_code !== null ? <span>exit {current.exit_code}</span> : null}
                </>
              ) : (
                <span>Loading…</span>
              )}
            </DialogDescription>
            {current?.error ? (
              <p className="mt-1 text-xs text-danger">{explainRunError(current.error)}</p>
            ) : null}
          </div>
          {canCancel && active && current ? (
            <Button
              variant="danger-outline"
              size="sm"
              loading={cancel.isPending}
              onClick={() =>
                cancel.mutate(current.id, {
                  onSuccess: () => toast({ title: "Run cancelled", tone: "success" }),
                  onError: (cause) =>
                    toast({
                      title: "Could not cancel",
                      description: errorMessage(cause),
                      tone: "error",
                    }),
                })
              }
            >
              Cancel run
            </Button>
          ) : null}
        </div>
        {stream.status === "error" ? (
          <ErrorState
            message={stream.error ?? "Could not load the output"}
            onRetry={stream.retry}
          />
        ) : stream.status === "loading" ? (
          <Skeleton className="m-4 h-40" />
        ) : stream.buffer.lines.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {active ? "Waiting for output…" : "This run wrote no output."}
          </p>
        ) : (
          <LogViewer
            lines={stream.buffer.lines}
            follow={follow}
            onFollowChange={setFollow}
            timestamps
            onReachTop={() => void stream.loadOlder()}
            label={`Output of run ${runId}`}
            className="min-h-0 flex-1"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A cron service's Runs tab (ADR 0010): its schedule state (active, paused or not
 * deployed yet, the armed schedule and the next slot) with Run now and Pause/Resume,
 * and its runs newest first, each opening its output (live while it runs) in a side
 * panel with a Cancel action. A Run now refused because a run is in progress offers to
 * cancel that one and run.
 *
 * @param props - Workspace, project and service ids.
 * @returns The tab.
 */
export function RunsTab({ workspaceId, projectId, serviceId }: ServicePageProps) {
  const { project, environment } = useProjectEnvironment(projectId);
  const service = findService(project.data, serviceId);
  const isCron = service?.kind === "cron";
  const gate = useEnvironmentGate(workspaceId, projectId, environment);
  const { can } = gate;
  const [status, setStatus] = useState<CronRunStatus | null>(null);
  const state = useCronState(serviceId, environment?.id, isCron);
  const runs = useCronRuns(serviceId, isCron ? environment?.id : undefined, status);
  const config = useServiceConfig(serviceId, isCron ? environment?.id : undefined);
  const trigger = useTriggerCronRun(serviceId, environment?.id ?? "");
  const setPaused = useSetCronPaused(serviceId, environment?.id ?? "");
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const filterId = useId();
  const now = useNow(1000);

  if (!service || !environment || (isCron && state.isPending)) {
    return <Skeleton className="h-64" aria-busy="true" />;
  }
  if (!isCron) {
    return (
      <EmptyState
        icon={<TimerIcon />}
        title="Not a cron job"
        description="Runs are for cron services."
        className="py-16"
      />
    );
  }
  if (state.isError) {
    return <ErrorState message={errorMessage(state.error)} onRetry={() => void state.refetch()} />;
  }
  const cron = state.data;
  if (!cron) return null;

  function run(force = false) {
    trigger.mutate(
      { force },
      {
        onSuccess: () => {
          setBusy(false);
          toast({ title: "Run queued", tone: "success" });
        },
        onError: (cause) => {
          if (!force && isApiError(cause, "run_in_progress")) {
            setBusy(true);
            return;
          }
          setBusy(false);
          toast({ title: "Could not run", description: errorMessage(cause), tone: "error" });
        },
      },
    );
  }

  const rows = runs.data?.pages.flatMap((page) => page.runs) ?? [];
  const canRun = can("deployments:create");

  return (
    <section aria-label="Runs" className="grid min-w-0 gap-2">
      {config.data && config.data.cron === null ? (
        <div className="mb-2">
          <MissingScheduleBanner>
            <Button size="sm" variant="primary" asChild>
              <Link
                to={SERVICE_TAB_PATHS.settings}
                params={{ workspaceId, projectId, serviceId }}
                hash="cron"
              >
                Set a schedule
              </Link>
            </Button>
          </MissingScheduleBanner>
        </div>
      ) : null}
      <StateHeader
        state={cron}
        canRun={canRun}
        canManage={can("services:manage")}
        runLocked={gate.locked("deployments:create")}
        manageLocked={gate.locked("services:manage")}
        onRun={() => run()}
        running={trigger.isPending}
        toggling={setPaused.isPending}
        onTogglePause={() =>
          setPaused.mutate(!cron.paused, {
            onSuccess: (next) =>
              toast({
                title: next.paused ? "Schedule paused" : "Schedule resumed",
                tone: "success",
              }),
            onError: (cause) =>
              toast({ title: "Could not change", description: errorMessage(cause), tone: "error" }),
          })
        }
      />
      <div className="flex items-center justify-end gap-2">
        <label htmlFor={filterId} className="text-xs text-muted-foreground">
          Status
        </label>
        <Select
          id={filterId}
          className="w-36"
          value={status ?? ""}
          onChange={(event) => setStatus((event.target.value || null) as CronRunStatus | null)}
        >
          <option value="">All</option>
          {CRON_RUN_STATUSES.map((value) => (
            <option key={value} value={value}>
              {RUN_STATUS[value].label}
            </option>
          ))}
        </Select>
      </div>
      {runs.isPending ? (
        <Skeleton className="h-40" />
      ) : runs.isError ? (
        <ErrorState message={errorMessage(runs.error)} onRetry={() => void runs.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<TimerIcon />}
          title={status ? "No runs with this status" : "No runs yet"}
          description={
            cron.armed_deployment_id
              ? "Runs appear here from the next slot, or run it now."
              : "Deploy the service to arm its schedule."
          }
        />
      ) : (
        <Table stack aria-label="Runs">
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">Status</TableHead>
              <TableHead>Slot</TableHead>
              <TableHead className="hidden md:table-cell">Trigger</TableHead>
              <TableHead className="hidden md:table-cell">Started</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Duration</TableHead>
              <TableHead className="hidden text-right lg:table-cell">Exit</TableHead>
              <TableHead className="hidden lg:table-cell">Node</TableHead>
              <TableHead className="hidden text-right lg:table-cell">Attempt</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((entry) => {
              const summary = runSummary(entry, cron.timezone ?? "UTC");
              return (
                <TableRow key={entry.id} data-status={entry.status}>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => setOpenRun(entry.id)}
                      aria-label={`Open run from ${formatTimestamp(entry.scheduled_for)}, ${RUN_STATUS[entry.status].label}`}
                      className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <RunStatus run={entry} />
                    </button>
                  </TableCell>
                  <TableCell cell="primary" className="max-w-0">
                    <span className="block truncate text-sm text-foreground tabular-nums">
                      {summary ?? formatTimestamp(entry.scheduled_for)}
                    </span>
                    {entry.error && entry.status !== "missed" ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {explainRunError(entry.error)}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                    {RUN_TRIGGER[entry.trigger]}
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground tabular-nums md:table-cell">
                    {entry.started_at !== null ? formatRelativeTime(entry.started_at, now) : "—"}
                  </TableCell>
                  <TableCell className="hidden text-right text-xs text-muted-foreground tabular-nums sm:table-cell">
                    {runDuration(entry, now)}
                  </TableCell>
                  <TableCell className="hidden text-right text-xs tabular-nums lg:table-cell">
                    {entry.exit_code ?? "—"}
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs text-muted-foreground lg:table-cell">
                    {entry.node_id ?? "—"}
                  </TableCell>
                  <TableCell className="hidden text-right text-xs tabular-nums lg:table-cell">
                    {entry.attempt}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {runs.hasNextPage ? (
        <div className="mt-2 flex justify-center">
          <Button
            variant="secondary"
            onClick={() => void runs.fetchNextPage()}
            loading={runs.isFetchingNextPage}
          >
            Load older runs
          </Button>
        </div>
      ) : null}
      <RunLogsDialog
        runId={openRun}
        onOpenChange={(open) => {
          if (!open) setOpenRun(null);
        }}
        canCancel={canRun}
      />
      <ConfirmDialog
        open={busy}
        onOpenChange={(open) => {
          if (!open) setBusy(false);
        }}
        title="A run is in progress"
        description="Cancel the running one and start a new run now?"
        confirmLabel="Cancel the running one and run"
        pending={trigger.isPending}
        onConfirm={() => run(true)}
      />
    </section>
  );
}
