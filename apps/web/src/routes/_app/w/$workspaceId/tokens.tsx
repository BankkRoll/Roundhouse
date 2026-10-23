import { createFileRoute } from "@tanstack/react-router";
import { ApiTokensPage } from "../../../../features/settings/api-tokens-page";

/** Workspace API tokens. */
export const Route = createFileRoute("/_app/w/$workspaceId/tokens")({
  staticData: { title: "API tokens" },
  component: TokensRoute,
});

function TokensRoute() {
  const { workspaceId } = Route.useParams();
  return <ApiTokensPage workspaceId={workspaceId} />;
}
