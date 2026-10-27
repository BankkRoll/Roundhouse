import { Button, EmptyState } from "@roundhouse/ui";
import { PlusIcon, ServerIcon } from "lucide-react";
import { ErrorState } from "../../components/error-state";
import { PageHeader } from "../../components/page-header";
import { errorMessage } from "../../lib/api/client";
import { usePermissions } from "../../lib/permissions";
import { useNodes } from "../../queries/nodes";
import { useNodeProvisions } from "../../queries/providers";
import { useShellActions } from "../shell/shell-actions";
import { CapacitySection } from "./capacity-section";
import { pendingProvisions } from "./cloud-offers";
import {
  COST_ESTIMATE_NOTE,
  type CostTotal,
  costTotals,
  formatCostEstimate,
} from "./cost-estimate";
import { fleetHeadline, summarizeFleet } from "./node-metrics";
import { ServerGrid, ServerGridSkeleton } from "./server-grid";
import { ServersNav } from "./servers-nav";

/** The workspace's estimated monthly cloud spend, one figure per currency. */
function CostSummary({ totals }: { totals: CostTotal[] }) {
  return (
    <p className="mt-3 text-xs text-muted-foreground" title={COST_ESTIMATE_NOTE}>
      Estimated cloud cost:{" "}
      {totals.map((total, index) => (
        <span key={total.currency}>
          {index > 0 ? " + " : null}
          <span className="text-foreground tabular-nums">{formatCostEstimate(total)}</span> (
          {total.servers} {total.servers === 1 ? "server" : "servers"})
        </span>
      ))}
      . Provider catalogue prices when each server was created, not your bill.
    </p>
  );
}

/**
 * Servers overview: live cards for every node, servers still being created at a cloud
 * provider, the estimated monthly cost of provisioned ones, and capacity planning.
 *
 * @param props - Workspace id.
 * @returns The page.
 */
export function ServersPage({ workspaceId }: { workspaceId: string }) {
  const nodes = useNodes(workspaceId);
  const { can } = usePermissions(workspaceId);
  const { openAddServer } = useShellActions();
  const canManage = can("nodes:manage");
  const provisions = useNodeProvisions(workspaceId, can("nodes:read"));
  const pending = nodes.data ? pendingProvisions(provisions.data ?? [], nodes.data) : [];
  const totals = nodes.data ? costTotals(nodes.data) : [];

  const addButton = canManage ? (
    <Button variant="primary" onClick={openAddServer}>
      <PlusIcon />
      Add server
    </Button>
  ) : null;

  return (
    <>
      <PageHeader
        title="Servers"
        subline={nodes.data ? fleetHeadline(summarizeFleet(nodes.data)) : undefined}
        actions={addButton}
      />
      <ServersNav workspaceId={workspaceId} />
      {nodes.isPending ? (
        <ServerGridSkeleton />
      ) : nodes.isError ? (
        <ErrorState message={errorMessage(nodes.error)} onRetry={() => void nodes.refetch()} />
      ) : nodes.data.length === 0 && pending.length === 0 ? (
        <EmptyState
          icon={<ServerIcon />}
          title="No servers yet"
          description="Add a Linux server and the agent will connect it to this workspace. Apps you deploy run there."
          action={addButton}
          className="py-16"
        />
      ) : (
        <>
          <ServerGrid workspaceId={workspaceId} nodes={nodes.data} provisions={pending} />
          {totals.length > 0 ? <CostSummary totals={totals} /> : null}
          <CapacitySection nodes={nodes.data} />
        </>
      )}
    </>
  );
}
