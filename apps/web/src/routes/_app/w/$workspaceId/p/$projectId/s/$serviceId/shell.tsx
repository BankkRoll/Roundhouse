import { createFileRoute } from "@tanstack/react-router";
import { ShellTab } from "../../../../../../../../features/services/shell/shell-tab";

/** An interactive shell in one of the service's running replicas. */
export const Route = createFileRoute("/_app/w/$workspaceId/p/$projectId/s/$serviceId/shell")({
  staticData: { title: "Shell" },
  component: ShellRoute,
});

function ShellRoute() {
  const { workspaceId, projectId, serviceId } = Route.useParams();
  return <ShellTab workspaceId={workspaceId} projectId={projectId} serviceId={serviceId} />;
}
