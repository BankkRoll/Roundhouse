/**
 * Point-in-time recovery on a Postgres service's Backups tab (ADR 0004): whether WAL is
 * being archived, the restorable windows in the viewer's zone or UTC, and the restore
 * to a chosen second, in place or into a new service, behind the typed slug and a fresh
 * session.
 *
 * @module
 */
import {
  Badge,
  Button,
  Input,
  Label,
  SettingsRow,
  SettingsSection,
  Skeleton,
  toast,
} from "@roundhouse/ui";
import { SegmentedControl } from "@roundhouse/ui/controls";
import type { UseQueryResult } from "@tanstack/react-query";
import { HistoryIcon } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import type { PitrRange, PitrStatus } from "../../lib/api/backups-client";
import { errorMessage } from "../../lib/api/client";
import type { Environment, Service } from "../../lib/api/deploy-types";
import { formatBytes, formatDuration, formatRelativeTime } from "../../lib/format";
import { useRestorePitr } from "../../queries/backups";
import { LockedButton, useEnvironmentGate } from "../access/environment-gate";
import { actionError } from "./backups-tab";
import { lockReason } from "./lock-reason";
import {
  earliestIn,
  formatInZone,
  latestIn,
  localZoneName,
  parseInputValue,
  type TimeZoneMode,
  targetProblem,
  toInputValue,
  zoneAbbreviation,
} from "./pitr-time";
import {
  destinationBody,
  RestoreDestinationFields,
  useRestoreDestination,
} from "./restore-destination";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

function stateOf(status: PitrStatus): { label: string; tone: Tone } {
  if (!status.enabled) return { label: "Off", tone: "neutral" };
  return status.stream?.last_archived_at
    ? { label: "Archiving", tone: "success" }
    : { label: "Starting", tone: "info" };
}

function ZoneSwitch({
  value,
  onChange,
  label = "Show times in",
}: {
  value: TimeZoneMode;
  onChange: (zone: TimeZoneMode) => void;
  label?: string;
}) {
  const now = Date.now();
  return (
    <SegmentedControl<TimeZoneMode>
      label={label}
      value={value}
      onValueChange={onChange}
      options={[
        { value: "local", label: `Local (${zoneAbbreviation(now, "local")})` },
        { value: "utc", label: "UTC" },
      ]}
    />
  );
}

/** One window as "from → to", each with its other-zone time on hover. */
function WindowRange({
  window,
  zone,
  now,
}: {
  window: PitrRange;
  zone: TimeZoneMode;
  now: number;
}) {
  const other: TimeZoneMode = zone === "local" ? "utc" : "local";
  const from = earliestIn(window);
  const to = latestIn(window, now);
  return (
    <span className="tabular-nums">
      <time dateTime={new Date(from).toISOString()} title={formatInZone(from, other)}>
        {formatInZone(from, zone)}
      </time>
      <span className="text-muted-foreground"> to </span>
      <time dateTime={new Date(to).toISOString()} title={formatInZone(to, other)}>
        {formatInZone(to, zone)}
      </time>
    </span>
  );
}

// -----------------------------------------------------------------------------
// Restore dialog
// -----------------------------------------------------------------------------

/** Props for {@link PitrRestoreDialog}. */
export interface PitrRestoreDialogProps {
  service: Service;
  environment: Environment;
  environments: readonly Environment[];
  /** The restorable windows, oldest first; the dialog starts at the newest. */
  windows: readonly PitrRange[];
  /** The clock the section shows times in; the picker starts in it. */
  zone: TimeZoneMode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the started restore's id. */
  onStarted: (restoreId: string) => void;
}

/**
 * Restores a database to a chosen second. The picker is bounded by the chosen window
 * (and now), entered in local time or UTC with the other shown beside it, and says what
 * is wrong with a time outside the window or in the future before anything is sent. The
 * destination and typed slug are the same as for restoring a backup.
 *
 * @param props - The service, its environments, the windows, open state and handlers.
 * @returns The dialog.
 */
export function PitrRestoreDialog({
  service,
  environment,
  environments,
  windows,
  zone: initialZone,
  open,
  onOpenChange,
  onStarted,
}: PitrRestoreDialogProps) {
  const restore = useRestorePitr(service.id, environment.id, service.project_id);
  const destination = useRestoreDestination(environment.id);
  const [zone, setZone] = useState(initialZone);
  const [windowIndex, setWindowIndex] = useState(windows.length - 1);
  const [value, setValue] = useState<string | null>(null);
  const inputId = useId();
  const now = Date.now();
  const window = windows[windowIndex] ?? windows.at(-1);
  const latest = window ? latestIn(window, now) : null;
  const earliest = window ? earliestIn(window) : null;
  const text = value ?? (latest === null ? "" : toInputValue(latest, zone));
  const target = parseInputValue(text, zone);
  const problem = targetProblem(target, window, now, zone);
  const other: TimeZoneMode = zone === "local" ? "utc" : "local";

  function reset() {
    restore.reset();
    destination.reset();
    setZone(initialZone);
    setWindowIndex(windows.length - 1);
    setValue(null);
  }

  function changeZone(next: TimeZoneMode) {
    // NOTE: The moment stays the same; only the clock it is written in changes.
    if (target !== null) setValue(toInputValue(target, next));
    setZone(next);
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
      title={`Restore ${service.name} to a point in time?`}
      description={`${service.name} in ${environment.name} as it was at the moment you pick: the newest base backup before it, with the archived write-ahead log replayed up to it.`}
      confirmLabel={
        destination.mode === "new_service" ? "Restore into a new service" : "Restore in place"
      }
      destructive={destination.mode === "in_place"}
      confirmText={service.slug}
      confirmDisabled={
        problem !== null || (destination.mode === "new_service" && destination.slugError !== null)
      }
      pending={restore.isPending}
      error={restore.isError ? actionError(restore.error) : null}
      onConfirm={() => {
        if (target === null || problem !== null) return;
        restore.mutate(
          {
            environment_id: environment.id,
            target_time: target,
            ...destinationBody(destination, service.slug, environment.id),
          },
          {
            onSuccess: (started) => {
              onOpenChange(false);
              reset();
              onStarted(started.id);
              toast({ title: "Point-in-time restore started", tone: "success" });
            },
          },
        );
      }}
    >
      {windows.length > 1 ? (
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium text-foreground">Window</legend>
          {windows.map((range, index) => (
            <label
              key={range.from}
              className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-background px-3 py-2 text-sm transition-colors has-[:checked]:border-accent-text"
            >
              <input
                type="radio"
                name="pitr-window"
                aria-label={`Window from ${formatInZone(earliestIn(range), zone)} to ${formatInZone(latestIn(range, now), zone)} (${index + 1} of ${windows.length})`}
                checked={index === windowIndex}
                onChange={() => {
                  setWindowIndex(index);
                  setValue(null);
                }}
                className="mt-0.5 size-3.5 shrink-0 accent-accent-text focus-visible:ring-2 focus-visible:ring-ring"
              />
              <WindowRange window={range} zone={zone} now={now} />
            </label>
          ))}
        </fieldset>
      ) : window ? (
        <p className="text-sm text-foreground">
          Restorable from <WindowRange window={window} zone={zone} now={now} />.
        </p>
      ) : null}
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label htmlFor={inputId}>Restore to</Label>
          <ZoneSwitch value={zone} onChange={changeZone} label="Enter the time in" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={inputId}
            type="datetime-local"
            step={1}
            value={text}
            min={earliest === null ? undefined : toInputValue(earliest, zone)}
            max={latest === null ? undefined : toInputValue(latest, zone)}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${inputId}-hint`}
            className="w-auto min-w-0 flex-1 font-mono tabular-nums"
          />
          {earliest !== null && latest !== null ? (
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setValue(toInputValue(earliest, zone))}
              >
                Earliest
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setValue(toInputValue(latest, zone))}
              >
                Latest
              </Button>
            </div>
          ) : null}
        </div>
        <p
          id={`${inputId}-hint`}
          className={problem ? "text-xs text-danger" : "text-xs text-muted-foreground"}
        >
          {problem ??
            `${zone === "local" ? localZoneName() : "UTC"}, to the second. That is ${formatInZone(target!, other)}.`}
        </p>
      </div>
      <RestoreDestinationFields
        destination={destination}
        service={service}
        environment={environment}
        environments={environments}
      />
    </ConfirmDialog>
  );
}

// -----------------------------------------------------------------------------
// Section
// -----------------------------------------------------------------------------

/** Props for {@link PitrSection}. */
export interface PitrSectionProps {
  workspaceId: string;
  service: Service;
  environment: Environment;
  environments: readonly Environment[];
  /** The service's point-in-time status, read by the tab for the policy's switch too. */
  status: UseQueryResult<PitrStatus>;
  /** Called with a started restore's id, for the tab's status line. */
  onStarted: (restoreId: string) => void;
}

/**
 * The point-in-time section of a Postgres service's Backups tab: the archive's state,
 * the restorable windows with a local/UTC switch, and the restore. Windows of a retired
 * stream stay listed after it is turned off, until retention removes their backups.
 * Callers who can't restore see the windows and a locked button saying why.
 *
 * @param props - The service, its environments, the status query and the start handler.
 * @returns The section.
 */
export function PitrSection({
  workspaceId,
  service,
  environment,
  environments,
  status,
  onStarted,
}: PitrSectionProps) {
  const gate = useEnvironmentGate(workspaceId, service.project_id, environment);
  const [zone, setZone] = useState<TimeZoneMode>("local");
  const [open, setOpen] = useState(false);
  const locked = lockReason(gate, ["backups:restore"], "Restoring to a point in time");
  const data = status.data;
  const now = Date.now();
  const state = data ? stateOf(data) : null;
  const windows = data?.windows ?? [];
  const stream = data?.stream ?? null;

  return (
    <SettingsSection
      id="point-in-time"
      title="Point-in-time recovery"
      description="Restore the database to any second inside a window, not only to the moment a backup was taken."
      className="scroll-mt-20"
      actions={state ? <Badge tone={state.tone}>{state.label}</Badge> : null}
    >
      {status.isPending ? (
        <Skeleton className="my-4 h-24" aria-busy="true" />
      ) : status.isError || !data ? (
        <SettingsRow
          label="Could not load point-in-time recovery"
          description={errorMessage(status.error)}
        />
      ) : (
        <>
          <SettingsRow
            label="Write-ahead log archive"
            description={
              stream?.last_archived_at
                ? `Last archived ${formatRelativeTime(stream.last_archived_at)}.`
                : data.enabled
                  ? "Starting: the first base backup is being taken, then the log is archived from it."
                  : (data.unavailable_reason ??
                    "Not archiving. Turn on point-in-time recovery under Schedule.")
            }
          >
            <p className="text-sm text-foreground tabular-nums md:text-right">
              {stream
                ? `${stream.segment_count.toLocaleString("en-US")} segments, ${formatBytes(stream.bytes_stored)}`
                : "Not archiving"}
            </p>
          </SettingsRow>
          <SettingsRow
            label="Restorable windows"
            description={
              windows.length > 0
                ? `${data.base_backups} base ${data.base_backups === 1 ? "backup" : "backups"} to replay from. Hover a time for ${zone === "local" ? "UTC" : "local time"}.`
                : undefined
            }
            control="wide"
          >
            {windows.length > 0 ? (
              <div className="grid gap-2">
                <div>
                  <ZoneSwitch value={zone} onChange={setZone} />
                </div>
                <ul aria-label="Restorable windows" className="grid gap-1 text-sm text-foreground">
                  {windows.map((window, index) => (
                    <li key={window.from} className="flex flex-wrap items-baseline gap-x-2">
                      <WindowRange window={window} zone={zone} now={now} />
                      <span className="text-xs text-muted-foreground">
                        {formatDuration(latestIn(window, now) - earliestIn(window))}
                        {index === windows.length - 1 && data.enabled && stream
                          ? ", still growing"
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing to restore to yet. A window opens once a base backup has finished and the
                log after it is archived.
              </p>
            )}
          </SettingsRow>
          <SettingsRow
            label="Restore to a point in time"
            description="The newest base backup before the moment is restored, then the archived log is replayed up to it."
          >
            <div className="md:flex md:justify-end">
              {locked ? (
                <LockedButton variant="secondary" reason={locked}>
                  Restore to a point in time…
                </LockedButton>
              ) : (
                <Button
                  variant="secondary"
                  disabled={windows.length === 0}
                  onClick={() => setOpen(true)}
                >
                  <HistoryIcon />
                  Restore to a point in time…
                </Button>
              )}
            </div>
          </SettingsRow>
          {windows.length > 0 ? (
            <PitrRestoreDialog
              key={`${windows.length}:${windows[0]!.from}`}
              service={service}
              environment={environment}
              environments={environments}
              windows={windows}
              zone={zone}
              open={open}
              onOpenChange={setOpen}
              onStarted={onStarted}
            />
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}
