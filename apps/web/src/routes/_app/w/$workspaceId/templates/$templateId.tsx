import { createFileRoute } from "@tanstack/react-router";
import { TemplateDetailPage } from "../../../../../features/templates/template-detail-page";

/** One template: what it creates, and its deploy form. */
export const Route = createFileRoute("/_app/w/$workspaceId/templates/$templateId")({
  staticData: { title: "Templates" },
  component: TemplateDetailRoute,
});

function TemplateDetailRoute() {
  const { workspaceId, templateId } = Route.useParams();
  return <TemplateDetailPage workspaceId={workspaceId} templateId={templateId} />;
}
