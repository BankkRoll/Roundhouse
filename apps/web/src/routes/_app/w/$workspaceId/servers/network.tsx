import { createFileRoute } from "@tanstack/react-router";
import { NetworkPage } from "../../../../../features/servers/network-page";

/** Servers → Network: the private WireGuard network between the workspace's servers. */
export const Route = createFileRoute("/_app/w/$workspaceId/servers/network")({
  staticData: { title: "Network" },
  component: NetworkRoute,
});

function NetworkRoute() {
  const { workspaceId } = Route.useParams();
  return <NetworkPage workspaceId={workspaceId} />;
}
