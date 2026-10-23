import { createFileRoute } from "@tanstack/react-router";
import { InstanceAuditPage } from "../../../../features/settings/instance-audit-page";

/** The instance audit log: instance-level entries and chain verification. */
export const Route = createFileRoute("/_app/w/$workspaceId/instance-audit")({
  staticData: { title: "Instance audit log" },
  component: InstanceAuditRoute,
});

function InstanceAuditRoute() {
  const { workspaceId } = Route.useParams();
  return <InstanceAuditPage workspaceId={workspaceId} />;
}
