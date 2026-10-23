import { createFileRoute } from "@tanstack/react-router";
import { SecurityPage } from "../../../../features/account/security-page";

/** The signed-in user's two-factor authentication and sessions. */
export const Route = createFileRoute("/_app/w/$workspaceId/security")({
  staticData: { title: "Security" },
  component: SecurityRoute,
});

function SecurityRoute() {
  const { workspaceId } = Route.useParams();
  return <SecurityPage workspaceId={workspaceId} />;
}
