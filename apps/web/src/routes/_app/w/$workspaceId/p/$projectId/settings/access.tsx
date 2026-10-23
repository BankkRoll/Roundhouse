import { createFileRoute } from "@tanstack/react-router";
import { ProjectAccessPage } from "../../../../../../../features/access/project-access-page";

/** Who can open a project and what they may do there. */
export const Route = createFileRoute("/_app/w/$workspaceId/p/$projectId/settings/access")({
  staticData: { title: "Project access" },
  component: ProjectAccessRoute,
});

function ProjectAccessRoute() {
  const { workspaceId, projectId } = Route.useParams();
  return <ProjectAccessPage workspaceId={workspaceId} projectId={projectId} />;
}
