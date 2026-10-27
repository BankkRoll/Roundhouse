import { createFileRoute } from "@tanstack/react-router";
import { ShellSessionsPage } from "../../../../features/shell-sessions/shell-sessions-page";

/** The workspace's web shell sessions, with recording playback. */
export const Route = createFileRoute("/_app/w/$workspaceId/shell-sessions")({
  staticData: { title: "Shell sessions" },
  component: ShellSessionsRoute,
});

function ShellSessionsRoute() {
  const { workspaceId } = Route.useParams();
  return <ShellSessionsPage workspaceId={workspaceId} />;
}
