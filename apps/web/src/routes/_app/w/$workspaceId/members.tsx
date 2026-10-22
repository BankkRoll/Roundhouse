import { createFileRoute } from "@tanstack/react-router";
import { MembersPage } from "../../../../features/members/members-page";

/** Workspace members and pending invites. */
export const Route = createFileRoute("/_app/w/$workspaceId/members")({
  staticData: { title: "Members" },
  component: MembersRoute,
});

function MembersRoute() {
  const { workspaceId } = Route.useParams();
  return <MembersPage workspaceId={workspaceId} />;
}
