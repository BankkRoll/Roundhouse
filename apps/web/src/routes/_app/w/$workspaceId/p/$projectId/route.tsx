import { createFileRoute } from "@tanstack/react-router";
import { ProjectLayout } from "../../../../../../features/projects/project-layout";

/** Search params shared by every page of a project. */
export interface ProjectSearch {
  /** Environment slug; production when absent. */
  env?: string;
  /** The project page's view; the canvas when absent. */
  view?: "list";
  /** A change set to open in review on the project page (agents link here). */
  review?: string;
}

/** Project layout: loads the project and holds its realtime socket. */
export const Route = createFileRoute("/_app/w/$workspaceId/p/$projectId")({
  validateSearch: (search: Record<string, unknown>): ProjectSearch => ({
    env: typeof search.env === "string" && search.env ? search.env : undefined,
    view: search.view === "list" ? "list" : undefined,
    review: typeof search.review === "string" && search.review ? search.review : undefined,
  }),
  component: ProjectRoute,
});

function ProjectRoute() {
  const { workspaceId, projectId } = Route.useParams();
  return <ProjectLayout workspaceId={workspaceId} projectId={projectId} />;
}
