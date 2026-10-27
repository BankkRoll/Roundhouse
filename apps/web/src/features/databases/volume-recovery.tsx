/**
 * Recovering a volume whose server is lost (ADR 0004, `target_node_id` on an in-place
 * restore): the dialog that picks an eligible server and the latest succeeded backup and
 * says what is lost, and the status of the recovery as it runs.
 *
 * @module
 */
import { Skeleton, toast } from "@roundhouse/ui";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import type { Restore } from "../../lib/api/backups-client";
import { errorMessage } from "../../lib/api/client";
import type { Volume } from "../../lib/api/data-client";
import type { Service } from "../../lib/api/deploy-types";
import { formatRelativeTime, formatTimestamp } from "../../lib/format";
import { useBackups, useRestore, useRestoreBackup } from "../../queries/backups";
import { useMigrationTargets } from "../../queries/databases";
import { actionError } from "./backups-tab";

/** Volume statuses the API recovers, as in `lib/backups/recovery.ts`. */
export const RECOVERABLE: readonly Volume["status"][] = ["pending", "ready", "degraded", "error"];

/** Props for {@link RecoverVolumeDialog}. */
export interface RecoverVolumeDialogProps {
  service: Service;
  volume: Volume;
  /** Name of the lost server, for the explanation. */
  lostServer: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the started restore. */
  onStarted: (restore: Restore) => void;
}

/**
 * Picks the server to rebuild a lost volume on. The latest succeeded backup is what gets
 * restored; everything written after it is lost, which the dialog states before the
 * typed slug. Ineligible servers are listed, disabled, with the reason.
 *
 * @param props - The service, its volume, the lost server's name, open state and handlers.
 * @returns The dialog.
 */
export function RecoverVolumeDialog({
  service,
  volume,
  lostServer,
  open,
  onOpenChange,
  onStarted,
}: RecoverVolumeDialogProps) {
  const targets = useMigrationTargets(volume.id, open);
  const backups = useBackups(service.id, open ? volume.environment_id : undefined);
  const restore = useRestoreBackup(service.id, volume.environment_id, service.project_id);
  const [chosen, setChosen] = useState<string | null>(null);
  const list = (targets.data?.targets ?? []).filter((row) => row.node_id !== volume.node_id);
  const eligible = list.filter((row) => row.eligible);
  const targetId = chosen ?? eligible[0]?.node_id ?? null;
  const target = list.find((row) => row.node_id === targetId);
  const backup = backups.data?.backups.find((row) => row.status === "succeeded");
  const takenAt = backup ? (backup.finished_at ?? backup.created_at) : null;
  const loading = targets.isPending || backups.isPending;
  const loadError = targets.error ?? backups.error;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          restore.reset();
          setChosen(null);
        }
      }}
      title={`Recover ${service.name} on another server?`}
      description={`${lostServer} is unreachable, so its copy of ${volume.mount_path} can't be read. A new volume is created on the server you pick, ${service.name} is redeployed there, and its latest backup is restored into it.`}
      confirmLabel="Recover volume"
      confirmText={service.slug}
      confirmDisabled={!target?.eligible || !backup}
      pending={restore.isPending}
      error={restore.isError ? actionError(restore.error) : null}
      onConfirm={() => {
        if (!targetId || !backup) return;
        restore.mutate(
          {
            backupId: backup.id,
            body: { mode: "in_place", confirm: service.slug, target_node_id: targetId },
          },
          {
            onSuccess: (started) => {
              onOpenChange(false);
              setChosen(null);
              onStarted(started);
              toast({ title: `Recovering ${service.name}`, tone: "success" });
            },
          },
        );
      }}
    >
      {loading ? (
        <Skeleton className="h-24" aria-busy="true" />
      ) : loadError ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(loadError)}
        </p>
      ) : (
        <>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium text-foreground">Recover onto</legend>
            {list.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                There is no other server in this workspace. Add one first.
              </p>
            ) : null}
            {list.map((row) => (
              <label
                key={row.node_id}
                className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-background px-3 py-2 transition-colors has-[:checked]:border-accent-text has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
              >
                <input
                  type="radio"
                  name="recovery-target"
                  value={row.node_id}
                  checked={row.node_id === targetId}
                  disabled={!row.eligible}
                  onChange={() => setChosen(row.node_id)}
                  className="mt-0.5 size-3.5 shrink-0 accent-accent-text focus-visible:ring-2 focus-visible:ring-ring"
                />
                <span className="grid gap-0.5">
                  <span className="text-sm text-foreground">{row.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {row.eligible ? "Eligible" : row.reason}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <div
            role="note"
            className="grid gap-1 rounded-lg border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-sm text-foreground"
          >
            <p className="flex items-center gap-2 font-medium">
              <TriangleAlertIcon className="size-4 shrink-0 text-danger" aria-hidden="true" />
              {backup
                ? `Writes after ${formatTimestamp(takenAt)} are lost`
                : "There is no succeeded backup to recover from"}
            </p>
            <p className="text-[13px] text-muted-foreground">
              {backup
                ? `Restores backup ${backup.id}, taken ${formatRelativeTime(takenAt)}. No safety backup can be taken of the lost copy, which stays on ${lostServer} if it ever comes back. If the server is only briefly down, wait for it instead.`
                : `Take backups regularly so a lost server can be recovered. ${service.name} can still be redeployed with an empty volume.`}
            </p>
          </div>
        </>
      )}
    </ConfirmDialog>
  );
}

/**
 * A recovery as it runs, as a status line: the redeploy onto the new server, the
 * restore, and how it ended.
 *
 * @param props - The restore id, the service's name and the target server's name.
 * @returns The status line, or nothing while it loads.
 */
export function RecoveryStatus({
  restoreId,
  serviceName,
  serverName,
}: {
  restoreId: string;
  serviceName: string;
  serverName: string;
}) {
  const query = useRestore(restoreId);
  if (!query.data) return null;
  const { status, error } = query.data;
  const text = {
    queued: `Recovery onto ${serverName} queued`,
    running: `Recovering onto ${serverName}… ${serviceName} starts there with an empty volume, then takes the backup`,
    succeeded: `Recovered onto ${serverName}`,
    failed: `Recovery onto ${serverName} failed${error ? `: ${error}` : ""}`,
  }[status];
  const tone =
    status === "failed"
      ? "border-danger/40 bg-danger/10"
      : status === "succeeded"
        ? "border-success/40 bg-success/10"
        : "border-info/40 bg-info/10";
  return (
    <div role="status" className={`rounded-lg border px-3.5 py-2 text-sm text-foreground ${tone}`}>
      {text}
    </div>
  );
}
