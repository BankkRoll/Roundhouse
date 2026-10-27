import { MAX_VOLUME_MB } from "@roundhouse/shared";
import {
  Badge,
  Button,
  Input,
  Meter,
  SettingsRow,
  SettingsSection,
  Skeleton,
  toast,
} from "@roundhouse/ui";
import { TriangleAlertIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { errorMessage } from "../../lib/api/client";
import type { Volume } from "../../lib/api/data-client";
import type { Environment, Service } from "../../lib/api/deploy-types";
import { formatBytes, formatDuration, formatTimestamp } from "../../lib/format";
import {
  migrationInFlight,
  useDeleteVolume,
  useResizeVolume,
  useUndeleteVolume,
  useVolume,
  useVolumeMigrations,
} from "../../queries/databases";
import { useNodes } from "../../queries/nodes";
import { useEnvironmentGate } from "../access/environment-gate";
import { MigrationHistory, MigrationProgress, MoveVolumeDialog } from "./volume-migration";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const STATUS: Record<Volume["status"], { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "neutral" },
  ready: { label: "Ready", tone: "success" },
  migrating: { label: "Moving", tone: "info" },
  degraded: { label: "Degraded", tone: "warning" },
  pending_deletion: { label: "Pending deletion", tone: "danger" },
  deleted: { label: "Deleted", tone: "neutral" },
  abandoned: { label: "Abandoned", tone: "neutral" },
  error: { label: "Error", tone: "danger" },
};

const QUOTA: Record<NonNullable<Volume["quota_mode"]>, string> = {
  xfs_project: "Enforced by an XFS project quota",
  ext4_project: "Enforced by an ext4 project quota",
  loop: "Enforced by a loop-mounted file",
  none: "Not enforced",
};

/** Statuses in which the volume can be grown or deleted: not while it moves. */
const EDITABLE: readonly Volume["status"][] = ["pending", "ready", "degraded"];
/** Statuses the API moves a volume from. */
const MOVABLE: readonly Volume["status"][] = ["ready", "degraded"];
const MiB = 1024 * 1024;

/** Parses a size in GiB (up to two decimals) into MiB. */
function parseGib(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 1024);
}

const gib = (mb: number) => String(Math.round((mb / 1024) * 100) / 100);

function ResizeForm({ volume, disabled }: { volume: Volume; disabled: boolean }) {
  const resize = useResizeVolume();
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const value = draft ?? gib(volume.size_mb);
  const sizeMb = parseGib(value);
  const dirty = draft !== null && sizeMb !== volume.size_mb;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (sizeMb === null) {
      setError("Enter a size in GiB, like 10 or 7.5.");
      return;
    }
    if (sizeMb < volume.size_mb) {
      setError(`Volumes only grow; it is ${gib(volume.size_mb)} GiB.`);
      return;
    }
    if (sizeMb > MAX_VOLUME_MB) {
      setError(`At most ${gib(MAX_VOLUME_MB)} GiB.`);
      return;
    }
    setError(null);
    resize.mutate(
      { volumeId: volume.id, sizeMb },
      {
        onSuccess: (saved) => {
          setDraft(null);
          toast({ title: `Volume grown to ${gib(saved.size_mb)} GiB`, tone: "success" });
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Resize volume">
      <SettingsRow
        label="Size (GiB)"
        description="Grows online; the node applies the new quota with its next update. Volumes can't shrink."
        htmlFor={id}
      >
        <div className="flex items-start gap-2 md:justify-end">
          <div className="grid gap-1.5">
            <Input
              id={id}
              value={value}
              inputMode="decimal"
              disabled={disabled}
              onChange={(event) => setDraft(event.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${id}-error` : `${id}-description`}
              className="w-28 tabular-nums"
            />
            {error ? (
              <p id={`${id}-error`} className="text-xs text-danger">
                {error}
              </p>
            ) : null}
          </div>
          <Button type="submit" disabled={disabled || !dirty} loading={resize.isPending}>
            Grow
          </Button>
        </div>
      </SettingsRow>
    </form>
  );
}

/** Props for {@link VolumeSection}. */
export interface VolumeSectionProps {
  workspaceId: string;
  service: Service;
  environment: Environment | undefined;
}

/**
 * A service's volume in the selected environment, as settings rows: status, usage
 * against its size, a grow-only resize, how the node enforces the quota (with a warning
 * when it doesn't), and the node holding it, with a move to another node, its progress
 * and the recent moves. A deleted volume can be undeleted until its grace period ends.
 *
 * @param props - Workspace, the service and the selected environment.
 * @returns The section.
 */
export function VolumeSection({ workspaceId, service, environment }: VolumeSectionProps) {
  const { can } = useEnvironmentGate(workspaceId, service.project_id, environment);
  const volume = useVolume(service.id, environment?.id);
  const remove = useDeleteVolume();
  const undelete = useUndeleteVolume();
  const [confirming, setConfirming] = useState(false);
  const [moving, setMoving] = useState(false);
  const [startedId, setStartedId] = useState<string | null>(null);
  const canManage = can("services:manage");
  const canMove = canManage && can("deployments:create");
  const data = volume.data;
  const migrations = useVolumeMigrations(data?.id);
  const nodes = useNodes(workspaceId, false);
  const history = migrations.data?.migrations ?? [];
  const runningId = history.find(migrationInFlight)?.id ?? null;
  const progressId = runningId ?? startedId;
  const nodeName = (nodeId: string | null) =>
    nodeId === null
      ? "an unknown server"
      : (nodes.data?.find((node) => node.id === nodeId)?.name ??
        (nodeId === data?.node_id ? data.node_name : null) ??
        nodeId);

  return (
    <SettingsSection
      id="volume"
      title="Volume"
      description={
        data ? (
          <>
            Mounted at <code className="font-mono text-foreground">{data.mount_path}</code>. The
            data stays on its server across deploys and restarts.
          </>
        ) : (
          "Persistent storage on the server running this service."
        )
      }
      className="scroll-mt-20"
      actions={
        data ? <Badge tone={STATUS[data.status].tone}>{STATUS[data.status].label}</Badge> : null
      }
    >
      {volume.isPending ? (
        <Skeleton className="my-4 h-24" />
      ) : volume.isError ? (
        <SettingsRow label="Could not load the volume" description={errorMessage(volume.error)} />
      ) : !data ? (
        <SettingsRow
          label="No volume in this environment"
          description="A database gets one in every environment when it is added."
        />
      ) : (
        <>
          {data.status === "pending_deletion" ? (
            <SettingsRow
              label="Scheduled for deletion"
              description={
                data.delete_after
                  ? `Its data is removed from ${data.node_name ?? "its server"} in ${formatDuration(Math.max(0, data.delete_after - Date.now()))} (${formatTimestamp(data.delete_after)}). Undelete it to keep it.`
                  : "Its data is removed after the grace period. Undelete it to keep it."
              }
            >
              {canManage ? (
                <div className="md:flex md:justify-end">
                  <Button
                    variant="primary"
                    loading={undelete.isPending}
                    onClick={() =>
                      undelete.mutate(data.id, {
                        onSuccess: () => toast({ title: "Volume restored", tone: "success" }),
                        onError: (cause) =>
                          toast({
                            title: "Could not undelete the volume",
                            description: errorMessage(cause),
                            tone: "error",
                          }),
                      })
                    }
                  >
                    Undelete
                  </Button>
                </div>
              ) : undefined}
            </SettingsRow>
          ) : null}
          {data.status === "error" && data.message ? (
            <SettingsRow label="Server reported an error" description={data.message} />
          ) : null}
          <SettingsRow
            label="Usage"
            description={
              data.reported_at === null
                ? "Reported by the server once the volume is placed."
                : undefined
            }
          >
            <div className="grid gap-1.5">
              <p className="text-sm text-foreground tabular-nums md:text-right">
                {data.used_bytes === null
                  ? `${gib(data.size_mb)} GiB`
                  : `${formatBytes(data.used_bytes)} of ${gib(data.size_mb)} GiB`}
              </p>
              <Meter
                value={
                  data.used_bytes === null ? null : (data.used_bytes / (data.size_mb * MiB)) * 100
                }
                label="Volume usage"
              />
            </div>
          </SettingsRow>
          <ResizeForm volume={data} disabled={!canManage || !EDITABLE.includes(data.status)} />
          <SettingsRow
            label="Quota"
            description={
              data.quota_mode === "none"
                ? "This server's filesystem can't cap the volume, so it can grow past its size until the disk is full."
                : undefined
            }
          >
            <p className="flex items-center gap-1.5 text-sm text-foreground md:justify-end">
              {data.quota_mode === "none" ? (
                <TriangleAlertIcon className="size-3.5 text-warning" aria-hidden="true" />
              ) : null}
              {data.quota_mode ? QUOTA[data.quota_mode] : "Reported once placed"}
            </p>
          </SettingsRow>
          <SettingsRow
            label="Server"
            description={
              data.status === "migrating"
                ? "Moving to another server; the service is down until it starts there."
                : canMove && data.node_id
                  ? "Moving it stops the service for the whole copy."
                  : undefined
            }
          >
            <div className="flex items-center gap-3 md:justify-end">
              <p className="text-sm text-foreground">
                {data.node_name ?? "Placed on the first deploy"}
              </p>
              {canMove && data.node_id && MOVABLE.includes(data.status) && !runningId ? (
                <Button variant="secondary" size="sm" onClick={() => setMoving(true)}>
                  Move to server…
                </Button>
              ) : null}
            </div>
          </SettingsRow>
          {progressId ? (
            <MigrationProgress
              key={progressId}
              migrationId={progressId}
              serviceName={service.name}
              nodeName={nodeName}
            />
          ) : null}
          <MigrationHistory
            migrations={history.filter((row) => row.id !== progressId)}
            nodeName={nodeName}
          />
          {canManage && EDITABLE.includes(data.status) ? (
            <SettingsRow
              label="Delete volume"
              description="Its data is removed from the server after 72 hours unless you undelete it. Stop the service in this environment first."
            >
              <div className="md:flex md:justify-end">
                <Button variant="danger-outline" onClick={() => setConfirming(true)}>
                  Delete volume
                </Button>
              </div>
            </SettingsRow>
          ) : null}
          <MoveVolumeDialog
            service={service}
            volume={data}
            open={moving}
            onOpenChange={setMoving}
            onStarted={(migration) => setStartedId(migration.id)}
          />
          <ConfirmDialog
            open={confirming}
            onOpenChange={(open) => {
              setConfirming(open);
              if (!open) remove.reset();
            }}
            title={`Delete ${service.name}'s volume?`}
            description={`Every byte in ${data.mount_path} on ${data.node_name ?? "its server"} is removed after 72 hours. Until then you can undelete it.`}
            confirmLabel="Delete volume"
            confirmText={service.slug}
            pending={remove.isPending}
            error={remove.isError ? errorMessage(remove.error) : null}
            onConfirm={() =>
              remove.mutate(data.id, {
                onSuccess: () => {
                  setConfirming(false);
                  toast({ title: "Volume scheduled for deletion", tone: "success" });
                },
              })
            }
          />
        </>
      )}
    </SettingsSection>
  );
}
