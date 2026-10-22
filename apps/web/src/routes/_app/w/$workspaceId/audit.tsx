import { createFileRoute } from "@tanstack/react-router";
import { AuditPage } from "../../../../features/audit/audit-page";

/** Workspace audit log. */
export const Route = createFileRoute("/_app/w/$workspaceId/audit")({
  staticData: { title: "Audit log" },
  component: AuditRoute,
});

function AuditRoute() {
  const { workspaceId } = Route.useParams();
  return <AuditPage workspaceId={workspaceId} />;
}
