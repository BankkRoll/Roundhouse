import { PROVIDERS } from "@roundhouse/providers";
import { Button, cn, Spinner } from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { errorMessage } from "../../lib/api/client";
import type { NodeProvision } from "../../lib/api/providers-types";
import { PROVISION_POLL_INTERVAL_MS, useNodeProvision } from "../../queries/providers";
import { PROVISION_STAGES, provisionProgress, provisionStepLabel } from "./cloud-offers";

/** Props for {@link ProvisionStatus}. */
export interface ProvisionStatusProps {
  /** Workspace the server joins. */
  workspaceId: string;
  /** The run to follow. */
  provisionId: string;
  /** Label of the button shown after the server joined. */
  doneLabel: string;
  /** Called when the user finishes after the server joined. */
  onDone: () => void;
  /** Called to go back to the form after a failure. */
  onRetry: () => void;
  /** Poll interval while in flight (tests). */
  pollIntervalMs?: number;
}

function Stepper({ provision }: { provision: NodeProvision }) {
  const { current, failed } = provisionProgress(provision);
  const step = provisionStepLabel(provision.step);
  return (
    <ol className="grid gap-0 border-y border-border/70" aria-label="Provisioning progress">
      {PROVISION_STAGES.map((label, index) => {
        const done = index < current;
        const active = index === current;
        const state = done ? "done" : active ? (failed ? "failed" : "active") : "pending";
        return (
          <li
            key={label}
            aria-current={active ? "step" : undefined}
            data-state={state}
            className="flex items-start gap-3 border-b border-border/70 py-2.5 last:border-b-0"
          >
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
              {state === "done" ? (
                <CircleCheckIcon className="size-4 text-success" aria-hidden="true" />
              ) : state === "failed" ? (
                <CircleXIcon className="size-4 text-danger" aria-hidden="true" />
              ) : state === "active" ? (
                <Spinner className="text-accent-text" />
              ) : (
                <CircleDashedIcon className="size-4 text-subtle-foreground" aria-hidden="true" />
              )}
            </span>
            <span className="grid min-w-0 gap-0.5">
              <span
                className={cn(
                  "text-sm",
                  state === "pending" ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {label}
                <span className="sr-only">
                  {state === "done" ? " (done)" : state === "failed" ? " (failed)" : ""}
                </span>
              </span>
              {active && !failed && step ? (
                <span className="text-xs text-muted-foreground">{step}</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Follows a provisioning run, polling until it joins or fails: a three-stage stepper
 * (Creating server → Booting → Joined) with the adapter's current step, the failure and
 * what to do about it, or a link to the new server.
 *
 * @param props - Workspace, run id and completion handlers.
 * @returns The status view.
 */
export function ProvisionStatus({
  workspaceId,
  provisionId,
  doneLabel,
  onDone,
  onRetry,
  pollIntervalMs = PROVISION_POLL_INTERVAL_MS,
}: ProvisionStatusProps) {
  const query = useNodeProvision(workspaceId, provisionId, pollIntervalMs);

  if (query.isError) {
    return (
      <div role="alert" className="grid justify-items-start gap-3">
        <p className="text-sm text-danger">{errorMessage(query.error)}</p>
        <Button variant="secondary" onClick={() => void query.refetch()}>
          <RefreshCwIcon />
          Try again
        </Button>
      </div>
    );
  }
  const run = query.data;
  if (!run) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Spinner /> Starting
      </p>
    );
  }

  const provider = PROVIDERS[run.provider].displayName;
  const failed = run.status === "failed" || run.status === "cleanup_failed";
  return (
    <div className="grid gap-4">
      <div className="grid gap-0.5">
        <p className="text-sm text-foreground">
          <span className="font-mono">{run.name}</span> at {provider}
        </p>
        <p className="font-mono text-xs text-muted-foreground">
          {run.plan} · {run.region}
          {run.ipv4 ? ` · ${run.ipv4}` : ""}
          {run.builder ? " · builder" : ""}
        </p>
      </div>

      <Stepper provision={run} />

      {run.status === "joined" ? (
        <>
          <p
            role="status"
            className="flex items-start gap-2 rounded-md border border-success/30 bg-success/10 p-3 text-sm text-foreground"
          >
            <CircleCheckIcon className="mt-0.5 size-4 text-success" aria-hidden="true" />
            <span>
              <span className="font-mono">{run.name}</span> joined. Usage appears after its first
              heartbeat.
            </span>
          </p>
          <div className="flex justify-end gap-2">
            {run.node_id ? (
              <Button asChild variant="secondary">
                <Link
                  to="/w/$workspaceId/servers/$nodeId"
                  params={{ workspaceId, nodeId: run.node_id }}
                  onClick={onDone}
                >
                  View server
                </Link>
              </Button>
            ) : null}
            <Button variant="primary" onClick={onDone}>
              {doneLabel}
            </Button>
          </div>
        </>
      ) : failed ? (
        <>
          <div role="alert" className="grid gap-1 rounded-md border border-danger/30 p-3 text-sm">
            <p className="font-medium text-danger">
              Couldn't create the server
              {run.failure_reason ? (
                <span className="font-mono text-xs font-normal"> ({run.failure_reason})</span>
              ) : null}
            </p>
            {run.failure_message ? (
              <p className="text-muted-foreground">{run.failure_message}</p>
            ) : null}
          </div>
          {run.status === "cleanup_failed" ? (
            <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-foreground">
              <TriangleAlertIcon
                className="mt-0.5 size-4 shrink-0 text-warning"
                aria-hidden="true"
              />
              <span>
                The server may still exist at {provider} and keep billing. Check the {provider}{" "}
                console
                {run.server_id ? (
                  <>
                    {" "}
                    for server <span className="font-mono">{run.server_id}</span>
                  </>
                ) : null}{" "}
                and delete it there.
              </span>
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          This takes a minute or two. You can close this dialog; the server keeps joining and shows
          up under Servers.
        </p>
      )}
    </div>
  );
}
