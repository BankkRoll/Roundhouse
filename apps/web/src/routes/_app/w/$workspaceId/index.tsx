import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "../../../../features/home/home-page";

/** Workspace home. */
export const Route = createFileRoute("/_app/w/$workspaceId/")({
  staticData: { title: "Home" },
  component: HomeRoute,
});

function HomeRoute() {
  const { workspaceId } = Route.useParams();
  return <HomePage workspaceId={workspaceId} />;
}
