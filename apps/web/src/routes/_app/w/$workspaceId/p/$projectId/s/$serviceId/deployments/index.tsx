import { createFileRoute } from "@tanstack/react-router";
import { DeploymentsTab } from "../../../../../../../../../features/services/deployments/deployments-tab";

/** A service's deployments. */
export const Route = createFileRoute("/_app/w/$workspaceId/p/$projectId/s/$serviceId/deployments/")(
  {
    staticData: { title: "Deployments" },
    component: DeploymentsRoute,
  },
);

function DeploymentsRoute() {
  const { workspaceId, projectId, serviceId } = Route.useParams();
  return <DeploymentsTab workspaceId={workspaceId} projectId={projectId} serviceId={serviceId} />;
}
