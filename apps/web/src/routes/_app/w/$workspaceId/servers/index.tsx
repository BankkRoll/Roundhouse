import { createFileRoute } from "@tanstack/react-router";
import { ServersPage } from "../../../../../features/servers/servers-page";

/** Servers overview. */
export const Route = createFileRoute("/_app/w/$workspaceId/servers/")({
  staticData: { title: "Servers" },
  component: ServersRoute,
});

function ServersRoute() {
  const { workspaceId } = Route.useParams();
  return <ServersPage workspaceId={workspaceId} />;
}
