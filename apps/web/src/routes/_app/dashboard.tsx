import { createFileRoute, redirect } from "@tanstack/react-router";
import { NoWorkspacePage } from "../../features/shell/no-workspace-page";

/** App entry point: opens the first workspace, or explains how to join one. */
export const Route = createFileRoute("/_app/dashboard")({
  staticData: { title: "Dashboard" },
  beforeLoad: ({ context }) => {
    const first = context.me.workspaces[0];
    if (first) throw redirect({ to: "/w/$workspaceId", params: { workspaceId: first.id } });
  },
  component: NoWorkspacePage,
});
