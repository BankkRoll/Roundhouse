import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "../../../../features/shell/app-shell";
import { requireMembership } from "../../../../lib/route-guards";

/** Workspace layout: checks membership and renders the app shell. */
export const Route = createFileRoute("/_app/w/$workspaceId")({
  beforeLoad: async ({ context, params }) => {
    const membership = await requireMembership(context.queryClient, context.me, params.workspaceId);
    return { membership };
  },
  component: WorkspaceLayout,
});

function WorkspaceLayout() {
  const { workspaceId } = Route.useParams();
  return <AppShell workspaceId={workspaceId} />;
}
