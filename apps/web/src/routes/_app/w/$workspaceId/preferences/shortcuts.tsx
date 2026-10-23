import { createFileRoute } from "@tanstack/react-router";
import { ShortcutsPage } from "../../../../../features/preferences/preferences-pages";

/** Preferences: the keyboard shortcuts. */
export const Route = createFileRoute("/_app/w/$workspaceId/preferences/shortcuts")({
  staticData: { title: "Keyboard shortcuts" },
  component: PreferencesRoute,
});

function PreferencesRoute() {
  const { workspaceId } = Route.useParams();
  return <ShortcutsPage workspaceId={workspaceId} />;
}
