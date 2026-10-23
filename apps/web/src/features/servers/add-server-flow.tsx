import { JOIN_TOKEN_TTL_MS } from "@roundhouse/shared";
import { Button, CodeBlock, Spinner } from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import { CircleCheckIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/api/client";
import { formatCountdown } from "../../lib/format";
import { useNow } from "../../lib/use-now";
import { NODE_POLL_INTERVAL_MS, useCreateJoinToken, useNodes } from "../../queries/nodes";

/** Props for {@link AddServerFlow}. */
export interface AddServerFlowProps {
  /** Workspace the new server joins. */
  workspaceId: string;
  /** How often to poll for the new node. */
  pollIntervalMs?: number;
  /** Label of the button shown after the server connects. Defaults to "Done". */
  doneLabel?: string;
  /** Called when the user finishes, after a server connected. */
  onDone: () => void;
}

/**
 * Mints a join token, shows the install one-liner with an expiry countdown, and waits
 * for a node that was not there when the flow started. Used by the add-server dialog and
 * the last step of the setup wizard.
 *
 * @param props - Workspace, polling interval and completion callback.
 * @returns The flow.
 */
export function AddServerFlow({
  workspaceId,
  pollIntervalMs = NODE_POLL_INTERVAL_MS,
  doneLabel = "Done",
  onDone,
}: AddServerFlowProps) {
  const createToken = useCreateJoinToken(workspaceId);
  const nodes = useNodes(workspaceId, pollIntervalMs);
  const [baseline, setBaseline] = useState<ReadonlySet<string> | null>(null);
  const now = useNow(1000);
  const requested = useRef(false);
  const { mutate } = createToken;

  // NOTE: StrictMode runs mount effects twice in development. Guard so each opening mints
  // exactly one token instead of leaving an orphaned one behind.
  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    mutate();
  }, [mutate]);

  useEffect(() => {
    if (baseline === null && nodes.data) setBaseline(new Set(nodes.data.map((node) => node.id)));
  }, [baseline, nodes.data]);

  const joined = baseline ? nodes.data?.find((node) => !baseline.has(node.id)) : undefined;

  if (joined) {
    return (
      <div className="grid gap-4">
        <div
          role="status"
          className="flex items-start gap-3 rounded-md border border-success/30 bg-success/10 p-3"
        >
          <CircleCheckIcon className="mt-0.5 size-4 text-success" aria-hidden="true" />
          <div>
            <p className="text-sm font-medium text-foreground">
              <span className="font-mono">{joined.name}</span> connected
            </p>
            <p className="text-xs text-muted-foreground">
              The agent registered with the control plane. Usage appears after its first heartbeat.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button asChild variant="secondary">
            <Link
              to="/w/$workspaceId/servers/$nodeId"
              params={{ workspaceId, nodeId: joined.id }}
              onClick={onDone}
            >
              View server
            </Link>
          </Button>
          <Button variant="primary" onClick={onDone}>
            {doneLabel}
          </Button>
        </div>
      </div>
    );
  }

  if (createToken.isError) {
    return (
      <div role="alert" className="grid gap-3">
        <p className="text-sm text-danger">{errorMessage(createToken.error)}</p>
        <div>
          <Button variant="secondary" onClick={() => createToken.mutate()}>
            <RefreshCwIcon />
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const token = createToken.data;
  if (!token) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Spinner /> Generating a join token
      </p>
    );
  }

  // NOTE: `now` can predate the token by up to a tick; clamp so it never reads 15:01.
  const remaining = Math.min(token.expires_at - now, JOIN_TOKEN_TTL_MS);
  const expired = remaining <= 0;

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        Run this on a fresh Linux server with root access. It installs Docker if needed, then the
        agent, which connects back here.
      </p>
      <CodeBlock code={token.install_command} label="Install command" prompt />
      <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] text-muted-foreground">
        <span>Single use</span>
        {expired ? (
          <span className="text-danger">Token expired</span>
        ) : (
          <span>
            Expires in{" "}
            <span className="tabular-nums text-foreground">{formatCountdown(remaining)}</span>
          </span>
        )}
      </div>
      {expired ? (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border p-3">
          <p className="text-sm text-muted-foreground">This token can no longer be used.</p>
          <Button variant="secondary" size="sm" onClick={() => createToken.mutate()}>
            Generate new token
          </Button>
        </div>
      ) : (
        <p
          role="status"
          className="flex items-center gap-2 rounded-md border border-dashed border-border-strong p-3 text-sm text-muted-foreground"
        >
          <Spinner className="text-accent-text" />
          Waiting for the server to connect…
        </p>
      )}
    </div>
  );
}
