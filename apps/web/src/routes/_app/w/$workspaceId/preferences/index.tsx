import { createFileRoute } from "@tanstack/react-router";
import { AppearancePage } from "../../../../../features/preferences/preferences-pages";

/** Preferences: theme and table density. */
export const Route = createFileRoute("/_app/w/$workspaceId/preferences/")({
  staticData: { title: "Appearance" },
  component: PreferencesRoute,
});

function PreferencesRoute() {
  const { workspaceId } = Route.useParams();
  return <AppearancePage workspaceId={workspaceId} />;
}
