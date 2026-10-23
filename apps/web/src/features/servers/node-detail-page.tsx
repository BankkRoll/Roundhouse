import { Badge, Button, EmptyState, MeterRow, Skeleton, StatusBadge, toast } from "@roundhouse/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, ServerOffIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useState } from "react";
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
import { nodeMeterRows, nodeSubtitle } from "./node-metrics";

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
  return (
    <dl className="grid border-t border-border/70 md:grid-cols-2 md:gap-x-10">
      <Fact label="Hostname">
        <span className="font-mono">{node.hostname ?? EMPTY}</span>
      </Fact>
      <Fact label="Public IP">
        <span className="font-mono">{node.public_ip ?? EMPTY}</span>
      </Fact>
      <Fact label="Provider">{node.provider}</Fact>
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

/**
 * Detail view for one server: usage, hardware facts, capabilities and removal.
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

  function confirmRemove() {
    remove.mutate(data.id, {
      onSuccess: async () => {
        setConfirming(false);
        toast({ title: `${data.name} removed`, tone: "success" });
        // NOTE: Leave first. Dropping the cached node while this page is mounted makes it
        // refetch, get a 404, and flash "Server not found" on the way out.
        await navigate({ to: "/w/$workspaceId/servers", params: { workspaceId } });
        forgetNode(queryClient, workspaceId, data.id);
      },
    });
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
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) remove.reset();
        }}
        title={`Remove ${data.name}?`}
        description="The server is removed from this workspace and its agent can no longer connect. To add it back you will need a new join token."
        confirmLabel="Remove server"
        onConfirm={confirmRemove}
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
      />
    </>
  );
}
