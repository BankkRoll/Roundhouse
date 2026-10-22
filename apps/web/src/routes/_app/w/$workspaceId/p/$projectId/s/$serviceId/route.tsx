import { createFileRoute } from "@tanstack/react-router";
import { ServiceLayout } from "../../../../../../../../features/services/service-layout";

/** Service layout: header, deploy action and tabs. */
export const Route = createFileRoute("/_app/w/$workspaceId/p/$projectId/s/$serviceId")({
  component: ServiceRoute,
});

function ServiceRoute() {
  const { workspaceId, projectId, serviceId } = Route.useParams();
  return <ServiceLayout workspaceId={workspaceId} projectId={projectId} serviceId={serviceId} />;
}
