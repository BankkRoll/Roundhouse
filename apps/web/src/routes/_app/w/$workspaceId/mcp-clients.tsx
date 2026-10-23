import { createFileRoute } from "@tanstack/react-router";
import { McpClientsPage } from "../../../../features/settings/mcp-clients-page";

/** The signed-in user's connected MCP clients. */
export const Route = createFileRoute("/_app/w/$workspaceId/mcp-clients")({
  staticData: { title: "MCP clients" },
  component: McpClientsRoute,
});

function McpClientsRoute() {
  const { workspaceId } = Route.useParams();
  return <McpClientsPage workspaceId={workspaceId} />;
}
