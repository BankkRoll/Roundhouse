import { createFileRoute } from "@tanstack/react-router";
import { ProjectSettingsPage } from "../../../../../../../features/projects/project-settings-page";

/** Project name, description and deletion. */
export const Route = createFileRoute("/_app/w/$workspaceId/p/$projectId/settings/")({
  staticData: { title: "Project settings" },
  component: ProjectSettingsRoute,
});

function ProjectSettingsRoute() {
  const { workspaceId, projectId } = Route.useParams();
  return <ProjectSettingsPage workspaceId={workspaceId} projectId={projectId} />;
}
