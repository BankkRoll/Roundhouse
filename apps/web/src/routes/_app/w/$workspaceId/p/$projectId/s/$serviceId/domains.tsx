import { createFileRoute } from "@tanstack/react-router";
import { DomainsTab } from "../../../../../../../../features/services/domains/domains-tab";

/** A service's domains. */
export const Route = createFileRoute("/_app/w/$workspaceId/p/$projectId/s/$serviceId/domains")({
  staticData: { title: "Domains" },
  component: DomainsRoute,
});

function DomainsRoute() {
  const { workspaceId, projectId, serviceId } = Route.useParams();
  return <DomainsTab workspaceId={workspaceId} projectId={projectId} serviceId={serviceId} />;
}
