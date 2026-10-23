import { createFileRoute } from "@tanstack/react-router";
import { DataTab } from "../../../../../../../../features/databases/data-tab";

/** A database service's read-only data browser. */
export const Route = createFileRoute("/_app/w/$workspaceId/p/$projectId/s/$serviceId/data")({
  staticData: { title: "Data" },
  component: DataRoute,
});

function DataRoute() {
  const { workspaceId, projectId, serviceId } = Route.useParams();
  return <DataTab workspaceId={workspaceId} projectId={projectId} serviceId={serviceId} />;
}
