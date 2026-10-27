import { isValidCron, nextCronRuns } from "@roundhouse/shared";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Input,
  Label,
  SaveBar,
  Select,
  SettingsRow,
  SettingsSection,
  SettingsStack,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@roundhouse/ui";
import { Switch } from "@roundhouse/ui/controls";
import { Link } from "@tanstack/react-router";
import {
  ArchiveIcon,
  DatabaseIcon,
  DownloadIcon,
  HardDriveUploadIcon,
  PinIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorState } from "../../components/error-state";
import { SettingsField } from "../../components/settings-field";
import type { Backup, BackupPolicy, RestoreBody } from "../../lib/api/backups-client";
import { errorMessage, isApiError } from "../../lib/api/client";
import type { Environment, Service } from "../../lib/api/deploy-types";
import { formatBytes, formatDuration, formatRelativeTime, formatTimestamp } from "../../lib/format";
import { canManageInstance } from "../../lib/permissions";
import {
  useBackupDownload,
  useBackupPolicy,
  useBackupStorage,
  useBackups,
  useCreateBackup,
  useDeleteBackup,
  useRestore,
  useRestoreBackup,
  useSaveBackupPolicy,
} from "../../queries/backups";
import { useMe } from "../../queries/me";
import { useEnvironmentGate } from "../access/environment-gate";
import { findService, useProjectEnvironment } from "../projects/use-project-environment";
import type { ServicePageProps } from "../services/service-layout";
import { defaultRestoreSlug } from "./database-meta";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const STATUS: Record<Backup["status"], { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "info" },
  succeeded: { label: "Succeeded", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  deleted: { label: "Deleted", tone: "neutral" },
};

const TRIGGER: Record<Backup["trigger"], string> = {
  schedule: "Scheduled",
  manual: "Manual",
  pre_restore: "Before restore",
  migration: "Migration",
};

/** The 409 every backup route answers until an instance admin sets a bucket. */
export const STORAGE_NOT_CONFIGURED = "backup_storage_not_configured";

/**
 * The message for a failed action, with the re-authentication hint the dashboard gives
 * wherever the API wants a fresh session.
 *
 * @param error - The caught error.
 * @returns A user-facing message.
 */
export function actionError(error: unknown): string {
  return isApiError(error, "reauth_required")
    ? `${errorMessage(error)} Sign in again, then retry.`
    : errorMessage(error);
}

function StorageNotice({ workspaceId, canFix }: { workspaceId: string; canFix: boolean }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 py-2 pr-2 pl-3.5 text-sm text-foreground"
    >
      <span className="flex items-center gap-2">
        <TriangleAlertIcon className="size-4 shrink-0 text-warning" aria-hidden="true" />
        Backup storage is not configured, so nothing can be backed up yet.
      </span>
      {canFix ? (
        <Button asChild size="sm">
          <Link to="/w/$workspaceId/platform" params={{ workspaceId }} hash="backup-storage">
            Set up storage
          </Link>
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground">An instance admin can set a bucket.</span>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Policy
// -----------------------------------------------------------------------------

function numberOrError(value: string, min: number, max: number): number | string {
  const n = Number(value.trim());
  return value.trim() === "" || !Number.isInteger(n) || n < min || n > max
    ? `Enter a whole number from ${min} to ${max}.`
    : n;
}

function PolicySection({
  service,
  environment,
  policy,
  canEdit,
  onStorageMissing,
}: {
  service: Service;
  environment: Environment;
  policy: BackupPolicy;
  canEdit: boolean;
  onStorageMissing: () => void;
}) {
  const save = useSaveBackupPolicy(service.id);
  const [enabled, setEnabled] = useState(policy.enabled);
  const [schedule, setSchedule] = useState(policy.schedule);
  const [keepLast, setKeepLast] = useState(String(policy.keep_last));
  const [maxAge, setMaxAge] = useState(
    policy.max_age_days === null ? "" : String(policy.max_age_days),
  );
  const [quiesce, setQuiesce] = useState(policy.quiesce === "stop");
  const [error, setError] = useState<string | null>(null);
  const enabledId = useId();
  const quiesceId = useId();

  const cron = schedule.trim();
  const cronOk = isValidCron(cron);
  const keep = numberOrError(keepLast, 1, 365);
  const age = maxAge.trim() === "" ? null : numberOrError(maxAge, 1, 3650);
  const preview = cronOk ? nextCronRuns(cron, Date.now(), 3) : [];
  const snapshot = policy.method === "snapshot";
  const dirty =
    enabled !== policy.enabled ||
    cron !== policy.schedule ||
    keep !== policy.keep_last ||
    age !== policy.max_age_days ||
    (snapshot && quiesce !== (policy.quiesce === "stop"));

  function reset() {
    setEnabled(policy.enabled);
    setSchedule(policy.schedule);
    setKeepLast(String(policy.keep_last));
    setMaxAge(policy.max_age_days === null ? "" : String(policy.max_age_days));
    setQuiesce(policy.quiesce === "stop");
    setError(null);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!cronOk || typeof keep === "string" || typeof age === "string") {
      setError("Fix the highlighted fields first.");
      return;
    }
    setError(null);
    save.mutate(
      {
        environment_id: environment.id,
        enabled,
        schedule: cron,
        keep_last: keep,
        max_age_days: age,
        ...(snapshot ? { quiesce: quiesce ? ("stop" as const) : ("none" as const) } : {}),
      },
      {
        onSuccess: () => toast({ title: "Backup policy saved", tone: "success" }),
        onError: (cause) => {
          if (isApiError(cause, STORAGE_NOT_CONFIGURED)) onStorageMissing();
          setError(actionError(cause));
        },
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Backup policy">
      <SettingsSection
        title="Schedule"
        description={`${snapshot ? "A snapshot of the volume" : "A logical dump of the database"}, compressed and encrypted to the project's key before it leaves ${environment.name}'s server.`}
        actions={
          <Badge tone={policy.enabled ? "success" : "neutral"}>
            {policy.enabled ? "On" : "Off"}
          </Badge>
        }
      >
        <fieldset disabled={!canEdit} className="min-w-0 divide-y divide-border/70">
          <SettingsRow
            label="Scheduled backups"
            description="Manual backups work either way."
            htmlFor={enabledId}
            control="switch"
          >
            <Switch id={enabledId} checked={enabled} onCheckedChange={setEnabled} />
          </SettingsRow>
          <SettingsField
            label="Schedule (cron, UTC)"
            description="Five fields: minute, hour, day of month, month, day of week."
            value={schedule}
            onChange={(event) => setSchedule(event.target.value)}
            error={cronOk ? null : "Enter a five-field cron expression, like 0 3 * * *."}
            hint={
              preview.length > 0
                ? `Next: ${preview.map((t) => formatTimestamp(t).slice(0, 16)).join(", ")}`
                : undefined
            }
            inputClassName="font-mono"
            spellCheck={false}
          />
          <SettingsField
            label="Keep the last"
            description="Scheduled backups beyond this many are deleted. Manual ones are kept until you delete them."
            value={keepLast}
            onChange={(event) => setKeepLast(event.target.value)}
            error={typeof keep === "string" ? keep : null}
            inputMode="numeric"
            inputClassName="w-28 tabular-nums"
          />
          <SettingsField
            label="Delete after (days)"
            description="Empty keeps them regardless of age."
            value={maxAge}
            onChange={(event) => setMaxAge(event.target.value)}
            error={typeof age === "string" ? age : null}
            inputMode="numeric"
            placeholder="No limit"
            inputClassName="w-28 tabular-nums"
          />
          {snapshot ? (
            <SettingsRow
              label="Stop the service while snapshotting"
              description="Consistent files at the cost of a short outage."
              htmlFor={quiesceId}
              control="switch"
            >
              <Switch id={quiesceId} checked={quiesce} onCheckedChange={setQuiesce} />
            </SettingsRow>
          ) : (
            <SettingsRow
              label="Method"
              description="The engine's own dump runs inside the container, so the database stays up."
            >
              <p className="text-sm text-foreground md:text-right">Logical dump</p>
            </SettingsRow>
          )}
        </fieldset>
      </SettingsSection>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {canEdit ? <SaveBar dirty={dirty} saving={save.isPending} onDiscard={reset} /> : null}
    </form>
  );
}

// -----------------------------------------------------------------------------
// Restore
// -----------------------------------------------------------------------------

type RestoreMode = RestoreBody["mode"];

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function ModeOption({
  mode,
  checked,
  disabled,
  title,
  description,
  onSelect,
}: {
  mode: RestoreMode;
  checked: boolean;
  disabled?: boolean;
  title: string;
  description: string;
  onSelect: (mode: RestoreMode) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border bg-background px-3 py-2 transition-colors has-[:checked]:border-accent-text has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
      <input
        type="radio"
        name="restore-mode"
        value={mode}
        checked={checked}
        disabled={disabled}
        onChange={() => onSelect(mode)}
        className="mt-0.5 size-3.5 shrink-0 accent-accent-text focus-visible:ring-2 focus-visible:ring-ring"
      />
      <span className="grid gap-0.5">
        <span className="text-sm text-foreground">{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

function RestoreDialog({
  service,
  environment,
  environments,
  backup,
  onOpenChange,
  onStarted,
}: {
  service: Service;
  environment: Environment;
  environments: readonly Environment[];
  backup: Backup | null;
  onOpenChange: (open: boolean) => void;
  onStarted: (restoreId: string) => void;
}) {
  const restore = useRestoreBackup(service.id, environment.id, service.project_id);
  const snapshot = backup?.method === "snapshot";
  const [chosen, setChosen] = useState<RestoreMode>("new_service");
  const mode: RestoreMode = snapshot ? "in_place" : chosen;
  const [skipSafety, setSkipSafety] = useState(false);
  const [slug, setSlug] = useState("");
  const [targetEnvId, setTargetEnvId] = useState(environment.id);
  const skipId = useId();
  const slugId = useId();
  const envId = useId();
  const placeholder = defaultRestoreSlug(service.slug, Date.now());
  const slugError =
    slug.trim() !== "" && !SLUG.test(slug.trim())
      ? "Lowercase letters, digits and dashes, starting and ending with a letter or digit."
      : null;
  const target = environments.find((env) => env.id === targetEnvId) ?? environment;

  function reset() {
    restore.reset();
    setChosen("new_service");
    setSkipSafety(false);
    setSlug("");
    setTargetEnvId(environment.id);
  }

  const body: RestoreBody =
    mode === "new_service"
      ? {
          mode,
          confirm: service.slug,
          ...(slug.trim() ? { slug: slug.trim() } : {}),
          ...(targetEnvId !== backup?.environment_id ? { target_environment_id: targetEnvId } : {}),
        }
      : { mode, confirm: service.slug, ...(skipSafety ? { skip_safety_backup: true } : {}) };

  return (
    <ConfirmDialog
      open={backup !== null}
      onOpenChange={(open) => {
        onOpenChange(open);
        if (!open) reset();
      }}
      title={`Restore ${service.name}?`}
      description={
        backup ? (
          <>
            From the {TRIGGER[backup.trigger].toLowerCase()} backup taken{" "}
            {formatTimestamp(backup.created_at)}.
          </>
        ) : null
      }
      confirmLabel={mode === "new_service" ? "Restore into a new service" : "Restore in place"}
      destructive={mode === "in_place"}
      confirmText={service.slug}
      confirmDisabled={mode === "new_service" && slugError !== null}
      pending={restore.isPending}
      error={restore.isError ? actionError(restore.error) : null}
      onConfirm={() => {
        if (!backup) return;
        restore.mutate(
          { backupId: backup.id, body },
          {
            onSuccess: (started) => {
              onOpenChange(false);
              reset();
              onStarted(started.id);
              toast({ title: "Restore started", tone: "success" });
            },
          },
        );
      }}
    >
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium text-foreground">Restore into</legend>
        <ModeOption
          mode="new_service"
          checked={mode === "new_service"}
          disabled={snapshot}
          title="A new service"
          description={
            snapshot
              ? "Only a dump can go into a new service: a snapshot carries the old passwords."
              : `Adds a database of the same engine and version with fresh credentials, then restores into it. ${service.name} keeps running untouched.`
          }
          onSelect={setChosen}
        />
        <ModeOption
          mode="in_place"
          checked={mode === "in_place"}
          title={`${service.name}, in place`}
          description={`Replaces everything in ${service.name} in ${environment.name}. The database is stopped while it restores.`}
          onSelect={setChosen}
        />
      </fieldset>
      {mode === "new_service" ? (
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={slugId}>New service slug</Label>
            <Input
              id={slugId}
              value={slug}
              placeholder={placeholder}
              onChange={(event) => setSlug(event.target.value)}
              aria-invalid={slugError ? true : undefined}
              aria-describedby={`${slugId}-hint`}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            <p
              id={`${slugId}-hint`}
              className={slugError ? "text-xs text-danger" : "text-xs text-muted-foreground"}
            >
              {slugError ?? "Leave empty for the name shown; a number is added if it is taken."}
            </p>
          </div>
          {environments.length > 1 ? (
            <div className="grid gap-1.5">
              <Label htmlFor={envId}>Environment</Label>
              <Select
                id={envId}
                value={targetEnvId}
                onChange={(event) => setTargetEnvId(event.target.value)}
              >
                {environments.map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            The new database is added and deployed in {target.name}, so this needs permission to
            manage services and variables and to deploy there.
          </p>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <Checkbox
            id={skipId}
            checked={skipSafety}
            onChange={(event) => setSkipSafety(event.target.checked)}
          />
          <Label htmlFor={skipId} className="grid gap-0.5 font-normal">
            <span className="text-sm text-foreground">Skip the safety backup</span>
            <span className="text-xs text-muted-foreground">
              By default the current data is backed up first, so the restore can be undone.
            </span>
          </Label>
        </div>
      )}
    </ConfirmDialog>
  );
}

function RestoreStatus({
  restoreId,
  workspaceId,
  projectId,
  services,
  environments,
}: {
  restoreId: string;
  workspaceId: string;
  projectId: string;
  services: readonly Service[];
  environments: readonly Environment[];
}) {
  const restore = useRestore(restoreId);
  if (!restore.data) return null;
  const { status, error, mode, target_service_id, target_environment_id } = restore.data;
  const tone =
    status === "failed"
      ? "border-danger/40 bg-danger/10"
      : status === "succeeded"
        ? "border-success/40 bg-success/10"
        : "border-info/40 bg-info/10";
  const created =
    mode === "new_service" ? services.find((row) => row.id === target_service_id) : undefined;
  const env = environments.find((row) => row.id === target_environment_id);
  const name = created?.name ?? "the new service";
  const text =
    mode === "new_service"
      ? {
          queued: "Restore queued",
          running: `Restoring into ${name}… it starts, turns healthy, then takes the data`,
          succeeded: `Restored into ${name}`,
          failed: `Restore into ${name} failed${error ? `: ${error}` : ""}`,
        }[status]
      : {
          queued: "Restore queued",
          running: "Restoring… the database is stopped until it finishes",
          succeeded: "Restore finished",
          failed: `Restore failed${error ? `: ${error}` : ""}`,
        }[status];
  return (
    <div
      role="status"
      className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border px-3.5 py-2 text-sm text-foreground ${tone}`}
    >
      <span>{text}</span>
      {mode === "new_service" && target_service_id ? (
        <Link
          to="/w/$workspaceId/p/$projectId/s/$serviceId"
          params={{ workspaceId, projectId, serviceId: target_service_id }}
          search={{ env: env && env.kind !== "production" ? env.slug : undefined }}
          className="font-medium text-accent-text underline-offset-2 hover:underline"
        >
          Open {created?.name ?? "new service"}
        </Link>
      ) : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// List
// -----------------------------------------------------------------------------

function BackupRow({
  backup,
  canRestore,
  canManage,
  onRestore,
  onDelete,
  onStorageMissing,
}: {
  backup: Backup;
  canRestore: boolean;
  canManage: boolean;
  onRestore: (backup: Backup) => void;
  onDelete: (backup: Backup) => void;
  onStorageMissing: () => void;
}) {
  const download = useBackupDownload();
  const status = STATUS[backup.status];
  const done = backup.status === "succeeded";
  const duration =
    backup.started_at !== null && backup.finished_at !== null
      ? formatDuration(backup.finished_at - backup.started_at)
      : "—";
  return (
    <TableRow>
      <TableCell cell="primary">
        <span className="text-foreground" title={formatTimestamp(backup.created_at)}>
          {formatRelativeTime(backup.created_at)}
        </span>
      </TableCell>
      <TableCell>
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          {TRIGGER[backup.trigger]}
          {backup.pinned ? (
            <PinIcon className="size-3" aria-label="Pinned: not removed by retention" />
          ) : null}
        </span>
      </TableCell>
      <TableCell>
        <Badge tone={status.tone} title={backup.error ?? undefined}>
          {status.label}
        </Badge>
        {backup.error ? (
          <span className="ml-2 hidden max-w-56 truncate align-middle text-xs text-muted-foreground lg:inline-block">
            {backup.error}
          </span>
        ) : null}
      </TableCell>
      <TableCell
        className="text-right tabular-nums"
        title={
          backup.bytes_raw !== null
            ? `${formatBytes(backup.bytes_raw)} before compression`
            : undefined
        }
      >
        {formatBytes(backup.bytes_stored)}
      </TableCell>
      <TableCell cell="hide-mobile" className="text-right tabular-nums text-muted-foreground">
        {duration}
      </TableCell>
      <TableCell cell="action" className="text-right">
        <div className="flex items-center justify-end gap-1">
          {canRestore && done ? (
            <>
              <Button size="sm" onClick={() => onRestore(backup)}>
                Restore
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Download backup from ${formatTimestamp(backup.created_at)}`}
                disabled={download.isPending}
                onClick={() =>
                  download.mutate(backup.id, {
                    onSuccess: (link) => {
                      window.open(link.url, "_blank", "noopener,noreferrer");
                      toast({
                        title: `Downloading ${link.filename}`,
                        description: "The file is age-encrypted; the link works for 15 minutes.",
                        tone: "success",
                      });
                    },
                    onError: (cause) => {
                      if (isApiError(cause, STORAGE_NOT_CONFIGURED)) onStorageMissing();
                      toast({
                        title: "Could not download",
                        description: actionError(cause),
                        tone: "error",
                      });
                    },
                  })
                }
              >
                <DownloadIcon />
              </Button>
            </>
          ) : null}
          {canManage && backup.status !== "queued" && backup.status !== "running" ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={`Delete backup from ${formatTimestamp(backup.created_at)}`}
              onClick={() => onDelete(backup)}
            >
              <Trash2Icon />
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

/**
 * A database service's Backups tab (ADR 0004): the scheduled-backup policy with a
 * next-runs preview, "Back up now", and the backups with their status, size and
 * duration, each restorable into a new service (the default) or in place (typed slug,
 * fresh session, progress until it finishes) and downloadable as an
 * encrypted file. Without backup storage it says so and links instance admins to the
 * setting.
 *
 * @param props - Workspace, project and service ids.
 * @returns The tab.
 */
export function BackupsTab({ workspaceId, projectId, serviceId }: ServicePageProps) {
  const { project, environment } = useProjectEnvironment(projectId);
  const service = findService(project.data, serviceId);
  const { can } = useEnvironmentGate(workspaceId, projectId, environment);
  const { data: me } = useMe();
  const admin = canManageInstance(me);
  const storage = useBackupStorage(admin);
  const policy = useBackupPolicy(serviceId, environment?.id);
  const backups = useBackups(serviceId, environment?.id);
  const create = useCreateBackup(serviceId, environment?.id ?? "");
  const remove = useDeleteBackup(serviceId, environment?.id ?? "");
  const [missingStorage, setMissingStorage] = useState(false);
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const [deleting, setDeleting] = useState<Backup | null>(null);
  const [restoreId, setRestoreId] = useState<string | null>(null);

  if (!service || !environment || policy.isPending) {
    return <Skeleton className="h-64" aria-busy="true" />;
  }
  if (!service.database) {
    return (
      <EmptyState
        icon={<DatabaseIcon />}
        title="Not a database"
        description="Backups are for database services."
        className="py-16"
      />
    );
  }
  if (policy.isError) {
    return (
      <ErrorState message={errorMessage(policy.error)} onRetry={() => void policy.refetch()} />
    );
  }

  const storageMissing = missingStorage || storage.data?.configured === false;
  const onStorageMissing = () => setMissingStorage(true);
  const canManage = can("backups:manage");
  const canRestore = can("backups:restore");
  const rows = backups.data?.backups ?? [];

  return (
    <section aria-label="Backups" className="grid min-w-0 gap-6">
      {storageMissing ? <StorageNotice workspaceId={workspaceId} canFix={admin} /> : null}
      {restoreId ? (
        <RestoreStatus
          restoreId={restoreId}
          workspaceId={workspaceId}
          projectId={projectId}
          services={project.data?.services ?? []}
          environments={project.data?.environments ?? []}
        />
      ) : null}
      <SettingsStack>
        <PolicySection
          key={`${environment.id}:${policy.data.id ?? "default"}`}
          service={service}
          environment={environment}
          policy={policy.data}
          canEdit={canManage}
          onStorageMissing={onStorageMissing}
        />
        <section aria-labelledby="backups-list" className="min-w-0">
          <header className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="backups-list" className="text-[15px] font-semibold text-foreground">
                Backups
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {policy.data.next_run_at
                  ? `Next scheduled ${formatTimestamp(policy.data.next_run_at)}.`
                  : "No scheduled backups."}
              </p>
            </div>
            {canManage ? (
              <Button
                variant="primary"
                loading={create.isPending}
                onClick={() =>
                  create.mutate(undefined, {
                    onSuccess: () => toast({ title: "Backup queued", tone: "success" }),
                    onError: (cause) => {
                      if (isApiError(cause, STORAGE_NOT_CONFIGURED)) onStorageMissing();
                      toast({
                        title: "Could not start a backup",
                        description: errorMessage(cause),
                        tone: "error",
                      });
                    },
                  })
                }
              >
                {create.isPending ? null : <HardDriveUploadIcon />}
                Back up now
              </Button>
            ) : null}
          </header>
          {backups.isPending ? (
            <Skeleton className="h-40" />
          ) : backups.isError ? (
            <ErrorState
              message={errorMessage(backups.error)}
              onRetry={() => void backups.refetch()}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<ArchiveIcon />}
              title="No backups yet"
              description={
                policy.data.enabled
                  ? "The first scheduled backup runs at the next slot."
                  : "Turn on scheduled backups or back up now."
              }
            />
          ) : (
            <Table stack aria-label="Backups">
              <TableHeader>
                <TableRow>
                  <TableHead>Created</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((backup) => (
                  <BackupRow
                    key={backup.id}
                    backup={backup}
                    canRestore={canRestore}
                    canManage={canManage}
                    onRestore={setRestoring}
                    onDelete={setDeleting}
                    onStorageMissing={onStorageMissing}
                  />
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </SettingsStack>
      <RestoreDialog
        service={service}
        environment={environment}
        environments={project.data?.environments ?? [environment]}
        backup={restoring}
        onOpenChange={(open) => {
          if (!open) setRestoring(null);
        }}
        onStarted={setRestoreId}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
            remove.reset();
          }
        }}
        title="Delete this backup?"
        description={
          deleting
            ? `The ${TRIGGER[deleting.trigger].toLowerCase()} backup from ${formatTimestamp(deleting.created_at)} is removed from the bucket. This can't be undone.`
            : null
        }
        confirmLabel="Delete backup"
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate(deleting.id, {
            onSuccess: () => {
              setDeleting(null);
              toast({ title: "Backup deleted", tone: "success" });
            },
          });
        }}
      />
    </section>
  );
}
