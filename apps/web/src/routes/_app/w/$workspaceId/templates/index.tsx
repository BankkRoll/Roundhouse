import { createFileRoute } from "@tanstack/react-router";
import { TemplatesPage } from "../../../../../features/templates/templates-page";

/** Template gallery. */
export const Route = createFileRoute("/_app/w/$workspaceId/templates/")({
  staticData: { title: "Templates" },
  component: TemplatesRoute,
});

function TemplatesRoute() {
  const { workspaceId } = Route.useParams();
  return <TemplatesPage workspaceId={workspaceId} />;
}
