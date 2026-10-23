import {
  Badge,
  Button,
  Select,
  SettingsRow,
  SettingsSection,
  Skeleton,
  toast,
} from "@roundhouse/ui";
import { useId, useState } from "react";
import { ErrorState } from "../../components/error-state";
import { errorMessage, isApiError } from "../../lib/api/client";
import type { NodeSigningKeys, SigningKeyStatus } from "../../lib/api/deploy-types";
import { formatRelativeTime, formatTimestamp } from "../../lib/format";
import { useSigningKeyRollover, useSigningKeys } from "../../queries/instance";

const DELAYS = [
  { hours: 24, label: "24 hours" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
  { hours: 1, label: "1 hour" },
] as const;

const STATE_COPY: Record<
  NodeSigningKeys["state"],
  { label: string; tone: "success" | "warning" | "danger" | "neutral" }
> = {
  ready: { label: "Ready", tone: "success" },
  pending: { label: "Not announced yet", tone: "warning" },
  upgrade_required: { label: "Upgrade agent", tone: "danger" },
  rejoin_required: { label: "Re-join needed", tone: "danger" },
  unknown: { label: "Not connected yet", tone: "neutral" },
};

function failure(cause: unknown): string {
  return isApiError(cause, "reauth_required")
    ? `${errorMessage(cause)} Sign in again, then retry.`
    : errorMessage(cause);
}

function Kid({ kid }: { kid: string }) {
  return <span className="font-mono text-sm text-foreground">{kid}</span>;
}

function NodesBehind({ nodes }: { nodes: NodeSigningKeys[] }) {
  return (
    <ul aria-label="Servers not ready" className="divide-y divide-border/70">
      {nodes.map((node) => (
        <li
          key={node.id}
          className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0"
        >
          <span className="min-w-0 truncate text-sm text-foreground">{node.name}</span>
          <span className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">
              {node.pinned_kids?.join(", ") ?? "no keys reported"}
            </span>
            <Badge tone={STATE_COPY[node.state].tone}>{STATE_COPY[node.state].label}</Badge>
          </span>
        </li>
      ))}
    </ul>
  );
}

function RolloverControls({ status }: { status: SigningKeyStatus }) {
  const { schedule, complete, cancel } = useSigningKeyRollover();
  const [delay, setDelay] = useState<number>(DELAYS[0].hours);
  const [force, setForce] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const delayId = useId();
  const forceId = useId();
  const behind = status.nodes.filter((node) => node.state !== "ready");
  const busy = schedule.isPending || complete.isPending || cancel.isPending;
  const handlers = (title: string) => ({
    onSuccess: () => {
      setError(null);
      setForce(false);
      toast({ title, tone: "success" as const });
    },
    onError: (cause: unknown) => setError(failure(cause)),
  });

  const errorLine = error ? (
    <p role="alert" className="pb-4 text-sm text-danger">
      {error}
    </p>
  ) : null;

  if (!status.next) {
    return (
      <>
        <SettingsRow
          label="Roll over to a new key"
          description="Every connected server is told about the new key right away and the rest as they reconnect. Frames are signed with it once the delay passes. Not for a leaked key: if the key may be compromised, re-join every server instead."
          htmlFor={delayId}
        >
          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <Select
              id={delayId}
              aria-label="Switch after"
              value={String(delay)}
              onChange={(event) => setDelay(Number(event.target.value))}
            >
              {DELAYS.map((d) => (
                <option key={d.hours} value={d.hours}>
                  {d.label}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              loading={schedule.isPending}
              disabled={busy}
              onClick={() =>
                schedule.mutate({ delay_hours: delay }, handlers("Signing key rollover scheduled"))
              }
            >
              Schedule rollover
            </Button>
          </div>
        </SettingsRow>
        {errorLine}
      </>
    );
  }

  if (!status.next.due) {
    return (
      <>
        <SettingsRow
          label="Cancel the rollover"
          description="Possible until the new key is used. Servers forget it the next time they connect."
        >
          <div className="md:flex md:justify-end">
            <Button
              variant="danger-outline"
              loading={cancel.isPending}
              disabled={busy}
              onClick={() => cancel.mutate(undefined, handlers("Signing key rollover cancelled"))}
            >
              Cancel rollover
            </Button>
          </div>
        </SettingsRow>
        {errorLine}
      </>
    );
  }

  return (
    <>
      <SettingsRow
        label="Complete the rollover"
        description={
          behind.length
            ? `${behind.length} server${behind.length === 1 ? "" : "s"} can't verify the new key yet. Completing deletes the old key, so they will need to re-join.`
            : "Every server pins the new key. Completing deletes the old private key."
        }
        control="wide"
      >
        <div className="grid gap-3">
          {behind.length ? (
            <label htmlFor={forceId} className="flex items-center gap-2 text-sm text-foreground">
              <input
                id={forceId}
                type="checkbox"
                checked={force}
                onChange={(event) => setForce(event.target.checked)}
              />
              Complete anyway
            </label>
          ) : null}
          <div>
            <Button
              variant="primary"
              loading={complete.isPending}
              disabled={busy || (behind.length > 0 && !force)}
              onClick={() =>
                complete.mutate(
                  behind.length ? { force: true } : {},
                  handlers("Signing key rollover completed"),
                )
              }
            >
              Complete rollover
            </Button>
          </div>
        </div>
      </SettingsRow>
      {errorLine}
    </>
  );
}

function SigningKeysBody({ status }: { status: SigningKeyStatus }) {
  const behind = status.nodes.filter((node) => node.state !== "ready");
  return (
    <>
      <SettingsRow
        label="Current key"
        description={
          status.signing_kid === status.current.kid
            ? "Signs every frame sent to servers."
            : "Still signs frames to servers that don't pin the new key yet."
        }
      >
        <div className="md:text-right">
          <Kid kid={status.current.kid} />
        </div>
      </SettingsRow>
      <SettingsRow
        label="Next key"
        description={
          status.next
            ? status.next.due
              ? `In use since ${formatTimestamp(status.next.not_before)} for servers that pin it.`
              : `Used from ${formatTimestamp(status.next.not_before)}. Scheduled ${formatRelativeTime(status.next.scheduled_at)}.`
            : "No rollover scheduled."
        }
      >
        <div className="md:text-right">
          {status.next ? (
            <Kid kid={status.next.kid} />
          ) : (
            <span className="text-sm text-muted-foreground">None</span>
          )}
        </div>
      </SettingsRow>
      {status.retired ? (
        <SettingsRow
          label="Retired key"
          description={`Retired ${formatRelativeTime(status.retired.retired_at)}. Servers still pinned to it must re-join.`}
        >
          <div className="md:text-right">
            <span className="font-mono text-sm text-muted-foreground">{status.retired.kid}</span>
          </div>
        </SettingsRow>
      ) : null}
      <SettingsRow
        label="Servers"
        description={
          status.nodes.length === 0
            ? "No servers have joined yet."
            : behind.length === 0
              ? `All ${status.nodes.length} server${status.nodes.length === 1 ? "" : "s"} pin the key they are signed with.`
              : `${behind.length} of ${status.nodes.length} servers need attention.`
        }
        control={behind.length ? "wide" : "field"}
      >
        {behind.length ? <NodesBehind nodes={behind} /> : undefined}
      </SettingsRow>
      <RolloverControls status={status} />
    </>
  );
}

/**
 * The control-plane signing key servers verify every frame with, and its rollover:
 * current, next and retired kids, when the next key takes over, the servers that would
 * be left behind, and schedule, cancel and complete actions. Instance admins only.
 *
 * @returns The section.
 */
export function SigningKeysSection() {
  const keys = useSigningKeys();
  const badge = keys.data?.next ? (
    <Badge tone={keys.data.next.due ? "warning" : "info"}>
      {keys.data.next.due ? "Rollover due" : "Rollover scheduled"}
    </Badge>
  ) : undefined;
  return (
    <SettingsSection
      title="Signing keys"
      description="Servers check every instruction from the control plane against this Ed25519 key. A rollover replaces it without re-joining servers."
      actions={badge}
    >
      {keys.isPending ? (
        <Skeleton className="my-4 h-32 rounded-lg" />
      ) : keys.isError ? (
        <ErrorState message={errorMessage(keys.error)} onRetry={() => void keys.refetch()} />
      ) : (
        <SigningKeysBody status={keys.data} />
      )}
    </SettingsSection>
  );
}
