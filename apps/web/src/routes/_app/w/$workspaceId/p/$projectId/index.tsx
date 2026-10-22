import { createFileRoute } from "@tanstack/react-router";
import { ProjectPage } from "../../../../../../features/projects/project-page";

/** A project's services. */
export const Route = createFileRoute("/_app/w/$workspaceId/p/$projectId/")({
  staticData: { title: "Services" },
  component: ProjectIndexRoute,
});

function ProjectIndexRoute() {
  const { workspaceId, projectId } = Route.useParams();
  return <ProjectPage workspaceId={workspaceId} projectId={projectId} />;
}
