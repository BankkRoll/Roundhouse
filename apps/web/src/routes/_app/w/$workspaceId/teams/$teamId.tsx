import { createFileRoute } from "@tanstack/react-router";
import { TeamDetailPage } from "../../../../../features/members/team-detail-page";

/** One team with its members. */
export const Route = createFileRoute("/_app/w/$workspaceId/teams/$teamId")({
  staticData: { title: "Teams" },
  component: TeamRoute,
});

function TeamRoute() {
  const { workspaceId, teamId } = Route.useParams();
  return <TeamDetailPage workspaceId={workspaceId} teamId={teamId} />;
}
