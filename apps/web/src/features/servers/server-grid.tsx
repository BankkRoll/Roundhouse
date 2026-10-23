import { PROVIDERS } from "@roundhouse/providers";
import { ServerCard, Skeleton, Spinner } from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import { TriangleAlertIcon } from "lucide-react";
import type { NodeProvision } from "../../lib/api/providers-types";
import type { Node } from "../../lib/api/types";
import { formatAgentVersion, formatRelativeTime } from "../../lib/format";
import { useNow } from "../../lib/use-now";
import { provisionStepLabel } from "./cloud-offers";
import { COST_ESTIMATE_NOTE, formatCostEstimate } from "./cost-estimate";
import { nodeMeterRows, nodeSubtitle } from "./node-metrics";
import { managedProvider, ProviderBadges } from "./provider-badge";

/**
 * List row for one node, linking to its detail page.
 *
 * @param props - Workspace id, node, and the current time for "seen" labels.
 * @returns The card.
 */
export function NodeCard({
  workspaceId,
  node,
  now,
}: {
  workspaceId: string;
  node: Node;
  now: number;
}) {
  return (
    <ServerCard
      title={
        <Link
          to="/w/$workspaceId/servers/$nodeId"
          params={{ workspaceId, nodeId: node.id }}
          className="outline-none hover:underline focus-visible:underline"
        >
          {node.name}
        </Link>
      }
      layout="row"
      meta={
        managedProvider(node) ? (
          <span className="inline-flex max-w-full items-center gap-1.5">
            <ProviderBadges node={node} />
            <span className="truncate">{nodeSubtitle(node)}</span>
          </span>
        ) : (
          nodeSubtitle(node)
        )
      }
      status={node.status}
      metrics={nodeMeterRows(node)}
      footer={
        <>
          0 services · agent {formatAgentVersion(node.agent_version) ?? "not reporting"}
          {managedProvider(node) && node.estimated_monthly_cost ? (
            <span title={COST_ESTIMATE_NOTE}>
              {" "}
              · {formatCostEstimate(node.estimated_monthly_cost)} (estimate)
            </span>
          ) : null}
        </>
      }
      footerAside={
        node.last_heartbeat_at === null
          ? "never connected"
          : `seen ${formatRelativeTime(node.last_heartbeat_at, now)}`
      }
    />
  );
}

const PROVISION_STATUS_LABELS: Record<NodeProvision["status"], string> = {
  queued: "Queued",
  creating: "Creating server",
  booting: "Booting",
  joined: "Joined",
  failed: "Failed",
  cancelled: "Cancelled",
  cleanup_failed: "Cleanup failed",
};

/**
 * List row for a server still being created at a cloud provider, or one whose failed run
 * may have left a billing server behind.
 *
 * @param props - The provisioning run.
 * @returns The row.
 */
export function ProvisionRow({ provision }: { provision: NodeProvision }) {
  const provider = PROVIDERS[provision.provider].displayName;
  const leaked = provision.status === "cleanup_failed";
  const step = leaked ? null : provisionStepLabel(provision.step);
  return (
    <article
      aria-label={`${provision.name} (${PROVISION_STATUS_LABELS[provision.status].toLowerCase()})`}
      className="grid gap-x-8 gap-y-1 py-4 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:items-center"
    >
      <div className="min-w-0">
        <h3 className="truncate font-mono text-sm font-semibold text-foreground">
          {provision.name}
        </h3>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {provider} · {provision.plan} · {provision.region}
        </p>
      </div>
      {leaked ? (
        <p className="flex items-start gap-2 text-xs text-warning">
          <TriangleAlertIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>
            Creating it failed and so did the cleanup. The server may still exist at {provider} and
            keep billing{provision.server_id ? ` (server ${provision.server_id})` : ""}.
          </span>
        </p>
      ) : (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <Spinner className="text-accent-text" />
          <span className="text-foreground">{PROVISION_STATUS_LABELS[provision.status]}</span>
          {step ? <span>· {step}</span> : null}
        </p>
      )}
    </article>
  );
}

/**
 * Every node as a list row: identity, CPU, RAM and disk, and when it was last seen.
 * Servers still being created at a cloud provider are listed first.
 *
 * @param props - Workspace id, nodes, and runs to show as pending rows.
 * @returns The grid.
 */
export function ServerGrid({
  workspaceId,
  nodes,
  provisions = [],
}: {
  workspaceId: string;
  nodes: readonly Node[];
  provisions?: readonly NodeProvision[];
}) {
  const now = useNow(5000);
  return (
    <ul className="divide-y divide-border/70 border-y border-border/70" aria-label="Servers">
      {provisions.map((provision) => (
        <li key={provision.id}>
          <ProvisionRow provision={provision} />
        </li>
      ))}
      {nodes.map((node) => (
        <li key={node.id}>
          <NodeCard workspaceId={workspaceId} node={node} now={now} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Loading placeholder matching {@link ServerGrid}'s layout.
 *
 * @returns Three skeleton cards.
 */
export function ServerGridSkeleton() {
  return (
    <div className="grid gap-3" role="status" aria-busy="true" aria-label="Loading servers">
      {[0, 1, 2].map((key) => (
        <Skeleton key={key} className="h-16 rounded-lg" />
      ))}
    </div>
  );
}
