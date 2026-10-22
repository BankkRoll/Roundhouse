import { createFileRoute } from "@tanstack/react-router";
import { ProjectLayout } from "../../../../../../features/projects/project-layout";

/** Search params shared by every page of a project. */
export interface ProjectSearch {
  /** Environment slug; production when absent. */
  env?: string;
}

/** Project layout: loads the project and holds its realtime socket. */
export const Route = createFileRoute("/_app/w/$workspaceId/p/$projectId")({
  validateSearch: (search: Record<string, unknown>): ProjectSearch => ({
    env: typeof search.env === "string" && search.env ? search.env : undefined,
  }),
  component: ProjectRoute,
});

function ProjectRoute() {
  const { workspaceId, projectId } = Route.useParams();
  return <ProjectLayout workspaceId={workspaceId} projectId={projectId} />;
}
