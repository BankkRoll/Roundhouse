import { createFileRoute } from "@tanstack/react-router";
import { InvitePage } from "../features/auth/invite-page";

/** Invite landing page (public). */
export const Route = createFileRoute("/invite/$token")({
  staticData: { title: "Join a workspace" },
  component: InviteRoute,
});

function InviteRoute() {
  const { token } = Route.useParams();
  return <InvitePage token={token} />;
}
