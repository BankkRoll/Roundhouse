import { createFileRoute } from "@tanstack/react-router";
import { DeploymentDetailPage } from "../../../../../../../../../features/services/deployments/deployment-detail-page";

/** One deployment's timeline and replicas. */
export const Route = createFileRoute(
  "/_app/w/$workspaceId/p/$projectId/s/$serviceId/deployments/$deploymentId",
)({
  staticData: { title: "Deployment" },
  component: DeploymentRoute,
});

function DeploymentRoute() {
  const { workspaceId, projectId, serviceId, deploymentId } = Route.useParams();
  return (
    <DeploymentDetailPage
      workspaceId={workspaceId}
      projectId={projectId}
      serviceId={serviceId}
      deploymentId={deploymentId}
    />
  );
}
