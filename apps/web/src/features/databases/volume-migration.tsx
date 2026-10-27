/**
 * Moving a volume to another node (ADR 0004, "Volume migration between nodes"): the
 * dialog that picks an eligible target, shows the expected downtime and asks for the
 * typed slug; the progress of a running move, phase by phase; and the recent moves.
 *
 * @module
 */
import { Badge, SettingsRow, Skeleton, Spinner, toast } from "@roundhouse/ui";
import { CheckIcon, CircleIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { errorMessage } from "../../lib/api/client";
import type { MigrationTargets, Volume, VolumeMigration } from "../../lib/api/data-client";
import type { Service } from "../../lib/api/deploy-types";
import { formatBytes, formatDuration, formatRelativeTime, formatTimestamp } from "../../lib/format";
import {
  migrationInFlight,
  useMigrateVolume,
  useMigrationTargets,
  useVolumeMigration,
} from "../../queries/databases";
import { actionError } from "./backups-tab";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

/** Resolves a node id to its name; the id itself when the node is unknown. */
export type NodeName = (nodeId: string | null) => string;

const QUOTA: Record<NonNullable<MigrationTargets["targets"][number]["quota_mode"]>, string> = {
  xfs_project: "XFS quota",
  ext4_project: "ext4 quota",
  loop: "loop-file quota",
  none: "quota not enforced",
};

const STATUS: Record<VolumeMigration["status"], { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Moving", tone: "info" },
  succeeded: { label: "Moved", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

/** The forward phases in order, each with what happens in it. */
const STEPS: readonly {
  phase: VolumeMigration["phase"];
  label: (source: string, target: string, service: string) => string;
}[] = [
  { phase: "preparing_target", label: (_, target) => `Create the volume on ${target}` },
  { phase: "stopping", label: (_s, _t, service) => `Stop ${service}` },
  { phase: "copying_out", label: (source) => `Copy the data out of ${source}` },
  { phase: "copying_in", label: (_, target) => `Copy it into ${target} and verify it` },
  { phase: "starting", label: (_, target) => `Start on ${target}` },
];

// -----------------------------------------------------------------------------
// Dialog
// -----------------------------------------------------------------------------

/** Props for {@link MoveVolumeDialog}. */
export interface MoveVolumeDialogProps {
  service: Service;
  volume: Volume;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the started migration. */
  onStarted: (migration: VolumeMigration) => void;
}

/**
 * Picks the node to move a volume to. Ineligible nodes are listed, disabled, with the
 * reason; the expected downtime and the fact that the service is down for the whole
 * copy are stated before the typed slug.
 *
 * @param props - The service, its volume, open state and handlers.
 * @returns The dialog.
 */
export function MoveVolumeDialog({
  service,
  volume,
  open,
  onOpenChange,
  onStarted,
}: MoveVolumeDialogProps) {
  const targets = useMigrationTargets(volume.id, open);
  const migrate = useMigrateVolume();
  const [chosen, setChosen] = useState<string | null>(null);
  const list = targets.data?.targets ?? [];
  const eligible = list.filter((target) => target.eligible);
  const targetId = chosen ?? eligible[0]?.node_id ?? null;
  const target = list.find((row) => row.node_id === targetId);
  const source = volume.node_name ?? "its current server";

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          migrate.reset();
          setChosen(null);
        }
      }}
      title={`Move ${service.name}'s volume?`}
      description={`Copies ${volume.mount_path} from ${source} to another server through the backup bucket, then runs ${service.name} there.`}
      confirmLabel="Move volume"
      confirmText={service.slug}
      confirmDisabled={!target?.eligible}
      pending={migrate.isPending}
      error={migrate.isError ? actionError(migrate.error) : null}
      onConfirm={() => {
        if (!targetId) return;
        migrate.mutate(
          { volume, targetNodeId: targetId, confirm: service.slug },
          {
            onSuccess: (migration) => {
              onOpenChange(false);
              setChosen(null);
              onStarted(migration);
              toast({ title: `Moving ${service.name}'s volume`, tone: "success" });
            },
          },
        );
      }}
    >
      {targets.isPending ? (
        <Skeleton className="h-24" aria-busy="true" />
      ) : targets.isError ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(targets.error)}
        </p>
      ) : (
        <>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium text-foreground">Move to</legend>
            {list.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                There is no other server in this workspace.
              </p>
            ) : null}
            {list.map((row) => (
              <label
                key={row.node_id}
                className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-background px-3 py-2 transition-colors has-[:checked]:border-accent-text has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
              >
                <input
                  type="radio"
                  name="migration-target"
                  value={row.node_id}
                  checked={row.node_id === targetId}
                  disabled={!row.eligible}
                  onChange={() => setChosen(row.node_id)}
                  className="mt-0.5 size-3.5 shrink-0 accent-accent-text focus-visible:ring-2 focus-visible:ring-ring"
                />
                <span className="grid gap-0.5">
                  <span className="text-sm text-foreground">{row.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {row.eligible
                      ? row.quota_mode
                        ? QUOTA[row.quota_mode]
                        : "Eligible"
                      : row.reason}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          {list.length > 0 && eligible.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No server can take this volume right now.
            </p>
          ) : null}
          <div
            role="note"
            className="grid gap-1 rounded-lg border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-sm text-foreground"
          >
            <p className="flex items-center gap-2 font-medium">
              <TriangleAlertIcon className="size-4 shrink-0 text-danger" aria-hidden="true" />
              {service.name} is stopped for the whole copy
            </p>
            <p className="text-[13px] text-muted-foreground">
              Expected downtime: about{" "}
              <span className="text-foreground tabular-nums">
                {targets.data ? formatDuration(targets.data.estimated_downtime_ms) : "…"}
              </span>
              . Connections fail until it starts on {target?.name ?? "the new server"}. If anything
              fails before then, it starts again on {source}.
            </p>
          </div>
        </>
      )}
    </ConfirmDialog>
  );
}

// -----------------------------------------------------------------------------
// Progress
// -----------------------------------------------------------------------------

/** Props for {@link MigrationProgress}. */
export interface MigrationProgressProps {
  migrationId: string;
  serviceName: string;
  nodeName: NodeName;
}

/**
 * A volume move as it runs: each phase checked off in order, the bytes copied, and how
 * it ended, rolled back with the error when it failed.
 *
 * @param props - The migration id, the service's name and a node-name lookup.
 * @returns A settings row, or nothing while it loads.
 */
export function MigrationProgress({ migrationId, serviceName, nodeName }: MigrationProgressProps) {
  const query = useVolumeMigration(migrationId);
  const migration = query.data;
  if (!migration) return null;
  const source = nodeName(migration.source_node_id);
  const target = nodeName(migration.target_node_id);
  const status = STATUS[migration.status];
  const done = migration.status === "succeeded";
  const failed = migration.status === "failed" || migration.phase === "rolling_back";
  const current = STEPS.findIndex((step) => step.phase === migration.phase);

  return (
    <SettingsRow
      label={
        <span className="flex items-center gap-2">
          Moving to {target}
          <Badge tone={failed ? "danger" : status.tone}>
            {migration.phase === "rolling_back" ? "Rolling back" : status.label}
          </Badge>
        </span>
      }
      description={
        failed
          ? `${migration.error ?? "The move failed."} ${
              migration.status === "failed"
                ? `${serviceName} runs on ${source} again.`
                : `Putting ${serviceName} back on ${source}…`
            }`
          : done
            ? `${serviceName} runs on ${target}. The copy left on ${source} is removed ${
                migration.cleanup_after
                  ? `after ${formatTimestamp(migration.cleanup_after)}`
                  : "later"
              }.`
            : `${serviceName} is down until it starts on ${target}.`
      }
      control="wide"
    >
      {failed ? null : (
        <ol aria-label="Move progress" className="grid gap-1.5 text-sm">
          {STEPS.map((step, index) => {
            const state =
              done || index < current ? "done" : index === current ? "current" : "pending";
            return (
              <li
                key={step.phase}
                aria-current={state === "current" ? "step" : undefined}
                className={
                  state === "pending"
                    ? "flex items-center gap-2 text-muted-foreground"
                    : "flex items-center gap-2 text-foreground"
                }
              >
                {state === "done" ? (
                  <CheckIcon className="size-3.5 shrink-0 text-success" aria-label="Done" />
                ) : state === "current" ? (
                  <Spinner className="text-info" label="In progress" />
                ) : (
                  <CircleIcon className="size-3.5 shrink-0" aria-hidden="true" />
                )}
                {step.label(source, target, serviceName)}
                {state === "current" &&
                (step.phase === "copying_out" || step.phase === "copying_in") &&
                migration.copied_bytes !== null ? (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {formatBytes(migration.copied_bytes)} copied
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </SettingsRow>
  );
}

// -----------------------------------------------------------------------------
// History
// -----------------------------------------------------------------------------

/** Props for {@link MigrationHistory}. */
export interface MigrationHistoryProps {
  migrations: readonly VolumeMigration[];
  nodeName: NodeName;
}

/**
 * The volume's recent moves as one row: from and to, outcome, when and how long it took.
 * Nothing when it has never moved.
 *
 * @param props - The migrations, newest first, and a node-name lookup.
 * @returns A settings row, or nothing.
 */
export function MigrationHistory({ migrations, nodeName }: MigrationHistoryProps) {
  const finished = migrations.filter((row) => !migrationInFlight(row)).slice(0, 5);
  if (finished.length === 0) return null;
  return (
    <SettingsRow label="Recent moves" control="wide">
      <ul aria-label="Recent moves" className="divide-y divide-border/70">
        {finished.map((row) => (
          <li
            key={row.id}
            className="grid gap-x-4 gap-y-0.5 py-2 text-sm first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"
          >
            <span className="min-w-0 truncate text-foreground">
              {nodeName(row.source_node_id)} → {nodeName(row.target_node_id)}
              {row.error ? (
                <span className="ml-2 text-xs text-muted-foreground">{row.error}</span>
              ) : null}
            </span>
            <Badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Badge>
            <span
              className="text-xs text-muted-foreground tabular-nums"
              title={formatTimestamp(row.created_at)}
            >
              {formatRelativeTime(row.created_at)}
              {row.started_at !== null && row.finished_at !== null
                ? ` · ${formatDuration(row.finished_at - row.started_at)}`
                : null}
            </span>
          </li>
        ))}
      </ul>
    </SettingsRow>
  );
}
