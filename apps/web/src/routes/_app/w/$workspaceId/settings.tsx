import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "../../../../features/settings/settings-page";

/** General workspace settings. */
export const Route = createFileRoute("/_app/w/$workspaceId/settings")({
  staticData: { title: "Settings" },
  component: SettingsRoute,
});

function SettingsRoute() {
  const { workspaceId } = Route.useParams();
  return <SettingsPage workspaceId={workspaceId} />;
}
