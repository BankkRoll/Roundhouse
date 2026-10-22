import { createFileRoute } from "@tanstack/react-router";
import { NodeDetailPage } from "../../../../../features/servers/node-detail-page";

/** One server's detail page. */
export const Route = createFileRoute("/_app/w/$workspaceId/servers/$nodeId")({
  staticData: { title: "Servers" },
  component: NodeDetailRoute,
});

function NodeDetailRoute() {
  const { workspaceId, nodeId } = Route.useParams();
  return <NodeDetailPage workspaceId={workspaceId} nodeId={nodeId} />;
}
