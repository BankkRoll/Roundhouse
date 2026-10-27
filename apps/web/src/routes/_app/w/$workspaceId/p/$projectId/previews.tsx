import { createFileRoute } from "@tanstack/react-router";
import { PreviewsPage } from "../../../../../../features/previews/previews-page";

/** A project's pull request previews and their settings. GitHub commit statuses link here. */
export const Route = createFileRoute("/_app/w/$workspaceId/p/$projectId/previews")({
  staticData: { title: "Previews" },
  component: PreviewsRoute,
});

function PreviewsRoute() {
  const { workspaceId, projectId } = Route.useParams();
  return <PreviewsPage workspaceId={workspaceId} projectId={projectId} />;
}
