import { ServerCard, Skeleton } from "@openrail/ui";
import { Link } from "@tanstack/react-router";
import type { Node } from "../../lib/api/types";
import { formatAgentVersion, formatRelativeTime } from "../../lib/format";
import { useNow } from "../../lib/use-now";
import { nodeMeterRows, nodeSubtitle } from "./node-metrics";

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
      meta={nodeSubtitle(node)}
      status={node.status}
      metrics={nodeMeterRows(node)}
      footer={`0 services · agent ${formatAgentVersion(node.agent_version) ?? "not reporting"}`}
      footerAside={
        node.last_heartbeat_at === null
          ? "never connected"
          : `seen ${formatRelativeTime(node.last_heartbeat_at, now)}`
      }
    />
  );
}

/**
 * Every node as a list row: identity, CPU, RAM and disk, and when it was last seen.
 *
 * @param props - Workspace id and nodes.
 * @returns The grid.
 */
export function ServerGrid({
  workspaceId,
  nodes,
}: {
  workspaceId: string;
  nodes: readonly Node[];
}) {
  const now = useNow(5000);
  return (
    <ul className="divide-y divide-border/70 border-y border-border/70" aria-label="Servers">
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
