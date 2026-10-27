import { createFileRoute } from "@tanstack/react-router";
import { TeamsPage } from "../../../../../features/members/teams-page";

/** The workspace's teams. */
export const Route = createFileRoute("/_app/w/$workspaceId/teams/")({
  staticData: { title: "Teams" },
  component: TeamsRoute,
});

function TeamsRoute() {
  const { workspaceId } = Route.useParams();
  return <TeamsPage workspaceId={workspaceId} />;
}
