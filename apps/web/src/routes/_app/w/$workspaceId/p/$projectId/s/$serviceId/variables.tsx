import { createFileRoute } from "@tanstack/react-router";
import { VariablesTab } from "../../../../../../../../features/services/variables/variables-tab";

/** A service's variables. */
export const Route = createFileRoute("/_app/w/$workspaceId/p/$projectId/s/$serviceId/variables")({
  staticData: { title: "Variables" },
  component: VariablesRoute,
});

function VariablesRoute() {
  const { workspaceId, projectId, serviceId } = Route.useParams();
  return <VariablesTab workspaceId={workspaceId} projectId={projectId} serviceId={serviceId} />;
}
