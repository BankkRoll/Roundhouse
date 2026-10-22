import { createFileRoute } from "@tanstack/react-router";
import { PlatformPage } from "../../../../features/settings/platform-page";

/** Install-wide settings: apps domain, TLS mode and the GitHub App. */
export const Route = createFileRoute("/_app/w/$workspaceId/platform")({
  staticData: { title: "Platform" },
  component: PlatformRoute,
});

function PlatformRoute() {
  const { workspaceId } = Route.useParams();
  return <PlatformPage workspaceId={workspaceId} />;
}
