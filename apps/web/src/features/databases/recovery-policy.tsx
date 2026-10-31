/**
 * Automatic recovery of a lost server's volume (ADR 0004), as rows of the volume
 * section: the switch and grace period, saved with a fresh session, and the policy's
 * live status in words, with the reason when it is blocked or failed.
 *
 * @module
 */
import { MAX_RECOVERY_GRACE_MINUTES, MIN_RECOVERY_GRACE_MINUTES } from "@roundhouse/shared";
import { Badge, Input, SaveBar, Select, SettingsRow, Skeleton, toast } from "@roundhouse/ui";
import { Switch } from "@roundhouse/ui/controls";
import { type FormEvent, useId, useState } from "react";
import type { RecoveryPolicy } from "../../lib/api/backups-client";
import { errorMessage, isApiError } from "../../lib/api/client";
import type { Environment, Service } from "../../lib/api/deploy-types";
import { formatRelativeTime, formatUntil } from "../../lib/format";
import { useRecoveryPolicy, useSaveRecoveryPolicy } from "../../queries/backups";
import { LockedButton, useEnvironmentGate } from "../access/environment-gate";
import { actionError, STORAGE_NOT_CONFIGURED } from "./backups-tab";
import { lockReason } from "./lock-reason";
import { formatInZone } from "./pitr-time";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

/** Everything turning automatic recovery on or off needs, as the API checks it. */
const RECOVERY_ACTIONS = ["backups:restore", "services:manage", "deployments:create"] as const;

const UNITS = { minutes: 1, hours: 60, days: 1_440 } as const;
type Unit = keyof typeof UNITS;

/** The largest unit that states a grace period exactly, so 120 reads "2 hours". */
function splitGrace(minutes: number): { amount: string; unit: Unit } {
  const unit: Unit =
    minutes % UNITS.days === 0 ? "days" : minutes % UNITS.hours === 0 ? "hours" : "minutes";
  return { amount: String(minutes / UNITS[unit]), unit };
}

/**
 * A grace period in words, e.g. "30 minutes" or "1 day".
 *
 * @param minutes - Grace period in minutes.
 * @returns The period.
 */
export function describeGrace(minutes: number): string {
  const { amount, unit } = splitGrace(minutes);
  return `${amount} ${amount === "1" ? unit.slice(0, -1) : unit}`;
}

function graceOrError(amount: string, unit: Unit): number | string {
  const n = Number(amount.trim());
  const minutes = n * UNITS[unit];
  return amount.trim() === "" ||
    !Number.isInteger(n) ||
    minutes < MIN_RECOVERY_GRACE_MINUTES ||
    minutes > MAX_RECOVERY_GRACE_MINUTES
    ? `Enter a whole number from ${describeGrace(MIN_RECOVERY_GRACE_MINUTES)} to ${describeGrace(MAX_RECOVERY_GRACE_MINUTES)}.`
    : minutes;
}

/** The moment a `watching` message names ("recovery starts at <ISO>"), if it names one. */
function dueAt(message: string | null): number | null {
  const iso = message?.match(/recovery starts at (\S+)/)?.[1];
  const ms = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(ms) ? null : ms;
}

/**
 * A recovery policy's status as a badge label, its tone, and a sentence a person can act
 * on. Blocked and failed carry the API's reason.
 *
 * @param policy - The policy.
 * @param serverName - Names a server by id.
 * @param holder - The server holding the volume now, for the idle sentence.
 * @returns Label, tone and sentence.
 */
export function describeRecovery(
  policy: Pick<
    RecoveryPolicy,
    "enabled" | "status" | "message" | "lost_node_id" | "triggered_at" | "grace_minutes"
  >,
  serverName: (nodeId: string | null) => string,
  holder: string | null,
): { label: string; tone: Tone; text: string } {
  const lost = serverName(policy.lost_node_id);
  if (!policy.enabled) {
    return {
      label: "Off",
      tone: "neutral",
      text: "A lost server's volume is only recovered when someone starts it.",
    };
  }
  switch (policy.status) {
    case "idle":
      return {
        label: "Standing by",
        tone: "success",
        text: `${holder ?? "The volume's server"} is online. If it stays offline for ${describeGrace(policy.grace_minutes)}, recovery starts on its own.`,
      };
    case "watching": {
      const due = dueAt(policy.message);
      return {
        label: "Server offline",
        tone: "warning",
        text: due
          ? `${lost} is offline. Recovery starts ${formatUntil(due)} (${formatInZone(due, "local")}) unless it comes back.`
          : (policy.message ?? `${lost} is offline; recovery starts after the grace period.`),
      };
    }
    case "recovering":
      return {
        label: "Recovering",
        tone: "info",
        text: `${lost} went offline, so the volume is being rebuilt on another server from the latest backup${policy.triggered_at ? ` (started ${formatRelativeTime(policy.triggered_at)})` : ""}.`,
      };
    case "recovered":
      return {
        label: "Recovered",
        tone: "success",
        text: `Recovered automatically${policy.triggered_at ? ` ${formatRelativeTime(policy.triggered_at)}` : ""} after ${lost} went offline. Writes after the backup it used are not in the new volume.`,
      };
    case "blocked":
      return {
        label: "Blocked",
        tone: "danger",
        text: `Can't recover: ${policy.message ?? "the reason was not recorded"}. It is retried every minute while ${lost} stays offline.`,
      };
    case "failed":
      return {
        label: "Failed",
        tone: "danger",
        text: `The last automatic recovery failed: ${policy.message ?? "the restore did not finish"}. Recover the volume by hand, or fix the cause and wait for the next outage.`,
      };
  }
}

function RecoveryForm({
  service,
  environment,
  policy,
  lockedReason,
}: {
  service: Service;
  environment: Environment;
  policy: RecoveryPolicy;
  lockedReason: string | null;
}) {
  const save = useSaveRecoveryPolicy(service.id);
  const initial = splitGrace(policy.grace_minutes);
  const [enabled, setEnabled] = useState(policy.enabled);
  const [amount, setAmount] = useState(initial.amount);
  const [unit, setUnit] = useState<Unit>(initial.unit);
  const [error, setError] = useState<string | null>(null);
  const switchId = useId();
  const graceId = useId();
  const unitId = useId();
  const grace = graceOrError(amount, unit);
  const dirty = enabled !== policy.enabled || grace !== policy.grace_minutes;
  const canEdit = lockedReason === null;

  function reset() {
    setEnabled(policy.enabled);
    setAmount(initial.amount);
    setUnit(initial.unit);
    setError(null);
    save.reset();
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (typeof grace === "string") return;
    setError(null);
    save.mutate(
      { environment_id: environment.id, enabled, grace_minutes: grace },
      {
        onSuccess: (saved) =>
          toast({
            title: saved.enabled ? "Automatic recovery on" : "Automatic recovery off",
            tone: "success",
          }),
        onError: (cause) =>
          setError(
            isApiError(cause, STORAGE_NOT_CONFIGURED)
              ? "Backup storage is not configured, so there is nothing to recover from. An instance admin can set a bucket."
              : actionError(cause),
          ),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Automatic recovery">
      <SettingsRow
        label="Automatic recovery"
        description={`If the volume's server stays offline for the grace period, the volume is rebuilt on another server from the latest backup and ${service.name} is redeployed there. Writes after that backup are lost. It runs with the access of whoever turns it on, checked again each time.`}
        htmlFor={canEdit ? switchId : undefined}
        control="switch"
      >
        {canEdit ? (
          <Switch
            id={switchId}
            checked={enabled}
            onCheckedChange={setEnabled}
            aria-describedby={`${switchId}-description`}
          />
        ) : (
          <LockedButton size="sm" variant="secondary" reason={lockedReason}>
            {policy.enabled ? "Turn off" : "Turn on"}
          </LockedButton>
        )}
      </SettingsRow>
      <SettingsRow
        label="Grace period"
        description="How long the server must stay offline first. A server that is back sooner keeps its volume."
        htmlFor={canEdit ? graceId : undefined}
      >
        {canEdit ? (
          <div className="grid gap-1.5">
            <div className="flex gap-2 md:justify-end">
              <Input
                id={graceId}
                value={amount}
                inputMode="numeric"
                onChange={(event) => setAmount(event.target.value)}
                aria-invalid={typeof grace === "string" ? true : undefined}
                aria-describedby={
                  typeof grace === "string" ? `${graceId}-error` : `${graceId}-description`
                }
                className="w-24 tabular-nums"
              />
              <label htmlFor={unitId} className="sr-only">
                Grace period unit
              </label>
              <Select
                id={unitId}
                value={unit}
                onChange={(event) => setUnit(event.target.value as Unit)}
                className="w-28"
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
              </Select>
            </div>
            {typeof grace === "string" ? (
              <p id={`${graceId}-error`} className="text-xs text-danger md:text-right">
                {grace}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-foreground md:text-right">
            {describeGrace(policy.grace_minutes)}
          </p>
        )}
      </SettingsRow>
      {error ? (
        <p role="alert" className="pb-3 text-sm text-danger">
          {error}
        </p>
      ) : null}
      {canEdit && dirty ? (
        <SaveBar dirty={dirty} saving={save.isPending} onDiscard={reset} className="mb-3" />
      ) : null}
    </form>
  );
}

/** Props for {@link RecoveryPolicyRows}. */
export interface RecoveryPolicyRowsProps {
  workspaceId: string;
  service: Service;
  environment: Environment;
  /** Names a server by id, from the workspace's servers. */
  serverName: (nodeId: string | null) => string;
  /** The server holding the volume now, or `null` before it is placed. */
  holder: string | null;
}

/**
 * The volume's automatic recovery: its live status, then the switch and grace period.
 * Callers who can't change it (it needs permission to restore backups, change service
 * settings and deploy here) see the settings read-only and a locked button saying why.
 *
 * @param props - The service, environment and server names.
 * @returns The rows.
 */
export function RecoveryPolicyRows({
  workspaceId,
  service,
  environment,
  serverName,
  holder,
}: RecoveryPolicyRowsProps) {
  const gate = useEnvironmentGate(workspaceId, service.project_id, environment);
  const policy = useRecoveryPolicy(service.id, environment.id);
  if (policy.isPending) return <Skeleton className="my-4 h-16" aria-busy="true" />;
  if (policy.isError) {
    return (
      <SettingsRow
        label="Could not load automatic recovery"
        description={errorMessage(policy.error)}
      />
    );
  }
  const state = describeRecovery(policy.data, serverName, holder);
  return (
    <>
      <SettingsRow label="Recovery status">
        <div aria-live="polite" className="grid gap-1 md:justify-items-end">
          <Badge tone={state.tone}>{state.label}</Badge>
          <p className="text-[13px] leading-snug text-muted-foreground md:text-right">
            {state.text}
          </p>
        </div>
      </SettingsRow>
      <RecoveryForm
        key={`${policy.data.enabled}:${policy.data.grace_minutes}`}
        service={service}
        environment={environment}
        policy={policy.data}
        lockedReason={lockReason(gate, RECOVERY_ACTIONS, "Automatic recovery")}
      />
    </>
  );
}
