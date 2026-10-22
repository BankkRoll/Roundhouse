import { createFileRoute } from "@tanstack/react-router";
import { ServiceSettingsTab } from "../../../../../../../../features/services/settings/service-settings-tab";

/** A service's config: every change writes a new version. */
export const Route = createFileRoute("/_app/w/$workspaceId/p/$projectId/s/$serviceId/settings")({
  staticData: { title: "Settings" },
  component: SettingsRoute,
});

function SettingsRoute() {
  const { workspaceId, projectId, serviceId } = Route.useParams();
  return (
    <ServiceSettingsTab workspaceId={workspaceId} projectId={projectId} serviceId={serviceId} />
  );
}
