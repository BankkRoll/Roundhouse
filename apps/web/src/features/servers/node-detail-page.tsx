import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  MeterRow,
  Skeleton,
  StatusBadge,
  toast,
} from "@roundhouse/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, ServerOffIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorState } from "../../components/error-state";
import { SectionHeader } from "../../components/section-header";
import { errorMessage, isApiError } from "../../lib/api/client";
import type { Node } from "../../lib/api/types";
import {
  EMPTY,
  formatAgentVersion,
  formatBytes,
  formatPlatform,
  formatRelativeTime,
  formatTimestamp,
} from "../../lib/format";
import { usePermissions } from "../../lib/permissions";
import { useNow } from "../../lib/use-now";
import { forgetNode, useDeleteNode, useNode } from "../../queries/nodes";
import { COST_ESTIMATE_NOTE, formatCostEstimate } from "./cost-estimate";
import { NodeLabelsSection } from "./node-labels-section";
import { nodeMeterRows, nodeSubtitle } from "./node-metrics";
import { managedProvider, ProviderBadges } from "./provider-badge";

function BackLink({ workspaceId }: { workspaceId: string }) {
  return (
    <Link
      to="/w/$workspaceId/servers"
      params={{ workspaceId }}
      className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
    >
      <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
      Servers
    </Link>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 border-b border-border/70 py-2.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-sm text-foreground tabular-nums">{children}</dd>
    </div>
  );
}

function Capability({ name, enabled }: { name: string; enabled: boolean | undefined }) {
  return (
    <Badge tone={enabled ? "success" : "neutral"}>
      {name}
      <span className="sr-only">{enabled ? " available" : " unavailable"}</span>
      <span aria-hidden="true">{enabled ? " · yes" : " · no"}</span>
    </Badge>
  );
}

function NodeFacts({ node, now }: { node: Node; now: number }) {
  const managed = managedProvider(node);
  return (
    <dl className="grid border-t border-border/70 md:grid-cols-2 md:gap-x-10">
      <Fact label="Hostname">
        <span className="font-mono">{node.hostname ?? EMPTY}</span>
      </Fact>
      <Fact label="Public IP">
        <span className="font-mono">{node.public_ip ?? EMPTY}</span>
      </Fact>
      <Fact label="Provider">{managed ? managed.displayName : node.provider}</Fact>
      {managed ? (
        <Fact label="Server ID">
          <span className="font-mono">{node.provider_server_id}</span>
        </Fact>
      ) : null}
      {managed && node.estimated_monthly_cost ? (
        <Fact label="Estimated cost">
          <span title={COST_ESTIMATE_NOTE}>
            {formatCostEstimate(node.estimated_monthly_cost)}{" "}
            <span className="text-muted-foreground">(estimate)</span>
          </span>
        </Fact>
      ) : null}
      <Fact label="Region">{node.region ?? EMPTY}</Fact>
      <Fact label="Platform">{formatPlatform(node.os, node.arch)}</Fact>
      <Fact label="Kernel">
        <span className="font-mono">{node.kernel ?? EMPTY}</span>
      </Fact>
      <Fact label="Docker">{node.docker_version ?? EMPTY}</Fact>
      <Fact label="Agent">{formatAgentVersion(node.agent_version) ?? EMPTY}</Fact>
      <Fact label="CPU">{node.cpu_total ? `${node.cpu_total} vCPU` : EMPTY}</Fact>
      <Fact label="Memory">{formatBytes(node.mem_total)}</Fact>
      <Fact label="Disk">{formatBytes(node.disk_total)}</Fact>
      <Fact label="Registered">
        <span title={formatTimestamp(node.created_at)}>
          {formatRelativeTime(node.created_at, now)}
        </span>
      </Fact>
      <Fact label="Last heartbeat">
        <span title={formatTimestamp(node.last_heartbeat_at)}>
          {formatRelativeTime(node.last_heartbeat_at, now)}
        </span>
      </Fact>
    </dl>
  );
}

function removeErrorMessage(error: unknown, provider: string | undefined): string {
  if (isApiError(error, "provider_not_connected") && provider) {
    return `${errorMessage(error)} Reconnect ${provider} under Add server → Cloud provider, or keep the server.`;
  }
  return errorMessage(error);
}

/**
 * Detail view for one server: usage, hardware facts, capabilities, labels and removal.
 *
 * @param props - Workspace and node ids.
 * @returns The page.
 */
export function NodeDetailPage({ workspaceId, nodeId }: { workspaceId: string; nodeId: string }) {
  const node = useNode(workspaceId, nodeId);
  const remove = useDeleteNode(workspaceId);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { can } = usePermissions(workspaceId);
  const now = useNow(5000);
  const [confirming, setConfirming] = useState(false);
  const [keepServer, setKeepServer] = useState(false);
  const keepId = useId();

  if (node.isPending) {
    return (
      <>
        <BackLink workspaceId={workspaceId} />
        <Skeleton className="mb-6 h-10 w-64" />
        <div className="grid gap-6">
          <Skeleton className="h-20" />
          <Skeleton className="h-64" />
        </div>
      </>
    );
  }

  if (node.isError) {
    return (
      <>
        <BackLink workspaceId={workspaceId} />
        {isApiError(node.error, 404) ? (
          <EmptyState
            icon={<ServerOffIcon />}
            title="Server not found"
            description="It may have been removed from this workspace."
          />
        ) : (
          <ErrorState message={errorMessage(node.error)} onRetry={() => void node.refetch()} />
        )}
      </>
    );
  }

  const data = node.data;
  const managed = managedProvider(data);
  const gone = data.provider_server_missing_at !== null;
  const destroys = managed !== null && !gone && !keepServer;

  function confirmRemove() {
    remove.mutate(
      { nodeId: data.id, keepServer: managed !== null && keepServer },
      {
        onSuccess: async () => {
          setConfirming(false);
          toast({ title: `${data.name} removed`, tone: "success" });
          // NOTE: Leave first. Dropping the cached node while this page is mounted makes it
          // refetch, get a 404, and flash "Server not found" on the way out.
          await navigate({ to: "/w/$workspaceId/servers", params: { workspaceId } });
          forgetNode(queryClient, workspaceId, data.id);
        },
      },
    );
  }

  return (
    <>
      <BackLink workspaceId={workspaceId} />
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">
              {data.name}
            </h1>
            <StatusBadge status={data.status} />
            <ProviderBadges node={data} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{nodeSubtitle(data)}</p>
        </div>
        {can("nodes:manage") ? (
          <Button variant="danger-outline" onClick={() => setConfirming(true)}>
            <Trash2Icon />
            Remove server
          </Button>
        ) : null}
      </div>

      {managed && gone ? (
        <p
          role="status"
          className="-mt-4 mb-8 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm text-foreground"
        >
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <span>
            {managed.displayName} no longer has this server (noticed{" "}
            {formatRelativeTime(data.provider_server_missing_at, now)}). Remove it here to stop
            waiting for its agent.
          </span>
        </p>
      ) : null}

      <div className="grid gap-12">
        <section aria-labelledby="usage-heading">
          <SectionHeader
            id="usage-heading"
            title="Usage"
            meta={`load ${data.load1 === null ? EMPTY : data.load1.toFixed(2)}`}
          />
          <div className="grid gap-x-10 gap-y-5 border-y border-border/70 py-5 sm:grid-cols-3">
            {nodeMeterRows(data).map((row) => (
              <MeterRow key={row.label} {...row} />
            ))}
          </div>
          {data.last_heartbeat_at === null ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Waiting for the first heartbeat from the agent.
            </p>
          ) : null}
        </section>
        <section aria-labelledby="details-heading">
          <SectionHeader id="details-heading" title="Details" />
          <NodeFacts node={data} now={now} />
          <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
            <h3 className="text-sm text-muted-foreground">Capabilities</h3>
            {data.capabilities ? (
              <div className="flex flex-wrap gap-2">
                <Capability name="docker" enabled={data.capabilities.docker} />
                <Capability name="gvisor" enabled={data.capabilities.gvisor} />
                <Capability name="builder" enabled={data.capabilities.builder} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Not reported yet.</p>
            )}
          </div>
        </section>
        <NodeLabelsSection workspaceId={workspaceId} node={data} canEdit={can("nodes:manage")} />
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) {
            remove.reset();
            setKeepServer(false);
          }
        }}
        title={`Remove ${data.name}?`}
        description={
          !managed
            ? "The server is removed from this workspace and its agent can no longer connect. To add it back you will need a new join token."
            : gone
              ? `${managed.displayName} already deleted this server, so this only removes it from the workspace.`
              : destroys
                ? `This destroys the server at ${managed.displayName}: its disk and everything on it are deleted and billing stops. The node is removed from this workspace.`
                : `The server keeps running, and billing, at ${managed.displayName}. Only the node is removed from this workspace, and its agent can no longer connect.`
        }
        confirmLabel={destroys ? "Destroy server" : "Remove server"}
        onConfirm={confirmRemove}
        pending={remove.isPending}
        error={remove.isError ? removeErrorMessage(remove.error, managed?.displayName) : null}
      >
        {managed && !gone ? (
          <div className="flex items-start gap-2">
            <Checkbox
              id={keepId}
              checked={keepServer}
              onChange={(event) => setKeepServer(event.target.checked)}
              className="mt-0.5"
            />
            <label htmlFor={keepId} className="cursor-pointer text-sm text-foreground">
              Keep the server at {managed.displayName}
              <span className="block text-xs text-muted-foreground">
                Server <span className="font-mono">{data.provider_server_id}</span> stays running;
                delete it there yourself later.
              </span>
            </label>
          </div>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
