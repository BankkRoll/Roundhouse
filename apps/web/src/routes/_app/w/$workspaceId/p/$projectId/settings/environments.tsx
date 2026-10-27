import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentProtectionPage } from "../../../../../../../features/access/environment-protection-page";

/** Protection of a project's environments. */
export const Route = createFileRoute("/_app/w/$workspaceId/p/$projectId/settings/environments")({
  staticData: { title: "Environments" },
  component: EnvironmentsRoute,
});

function EnvironmentsRoute() {
  const { workspaceId, projectId } = Route.useParams();
  return <EnvironmentProtectionPage workspaceId={workspaceId} projectId={projectId} />;
}
