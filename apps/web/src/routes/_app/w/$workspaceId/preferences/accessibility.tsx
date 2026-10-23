import { createFileRoute } from "@tanstack/react-router";
import { AccessibilityPage } from "../../../../../features/preferences/preferences-pages";

/** Preferences: motion. */
export const Route = createFileRoute("/_app/w/$workspaceId/preferences/accessibility")({
  staticData: { title: "Accessibility" },
  component: PreferencesRoute,
});

function PreferencesRoute() {
  const { workspaceId } = Route.useParams();
  return <AccessibilityPage workspaceId={workspaceId} />;
}
