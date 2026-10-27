import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceCanvasPage } from "../../../../features/canvas/workspace-canvas-page";

/** Staged changes across the workspace's projects, and the projects' canvases. */
export const Route = createFileRoute("/_app/w/$workspaceId/canvas")({
  staticData: { title: "Canvas" },
  component: CanvasRoute,
});

function CanvasRoute() {
  const { workspaceId } = Route.useParams();
  return <WorkspaceCanvasPage workspaceId={workspaceId} />;
}
