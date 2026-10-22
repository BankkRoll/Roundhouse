import { Button, EmptyState } from "@openrail/ui";
import { PlusIcon, ServerIcon } from "lucide-react";
import { ErrorState } from "../../components/error-state";
import { PageHeader } from "../../components/page-header";
import { errorMessage } from "../../lib/api/client";
import { usePermissions } from "../../lib/permissions";
import { useNodes } from "../../queries/nodes";
import { useShellActions } from "../shell/shell-actions";
import { CapacitySection } from "./capacity-section";
import { fleetHeadline, summarizeFleet } from "./node-metrics";
import { ServerGrid, ServerGridSkeleton } from "./server-grid";

/**
 * Servers overview: live cards for every node plus capacity planning.
 *
 * @param props - Workspace id.
 * @returns The page.
 */
export function ServersPage({ workspaceId }: { workspaceId: string }) {
  const nodes = useNodes(workspaceId);
  const { can } = usePermissions(workspaceId);
  const { openAddServer } = useShellActions();
  const canManage = can("nodes:manage");

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
      {nodes.isPending ? (
        <ServerGridSkeleton />
      ) : nodes.isError ? (
        <ErrorState message={errorMessage(nodes.error)} onRetry={() => void nodes.refetch()} />
      ) : nodes.data.length === 0 ? (
        <EmptyState
          icon={<ServerIcon />}
          title="No servers yet"
          description="Add a Linux server and the agent will connect it to this workspace. Apps you deploy run there."
          action={addButton}
          className="py-16"
        />
      ) : (
        <>
          <ServerGrid workspaceId={workspaceId} nodes={nodes.data} />
          <CapacitySection nodes={nodes.data} />
        </>
      )}
    </>
  );
}
