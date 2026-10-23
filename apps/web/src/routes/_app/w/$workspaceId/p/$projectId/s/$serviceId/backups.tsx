import { createFileRoute } from "@tanstack/react-router";
import { BackupsTab } from "../../../../../../../../features/databases/backups-tab";

/** A database service's backup policy, backups and restores. */
export const Route = createFileRoute("/_app/w/$workspaceId/p/$projectId/s/$serviceId/backups")({
  staticData: { title: "Backups" },
  component: BackupsRoute,
});

function BackupsRoute() {
  const { workspaceId, projectId, serviceId } = Route.useParams();
  return <BackupsTab workspaceId={workspaceId} projectId={projectId} serviceId={serviceId} />;
}
