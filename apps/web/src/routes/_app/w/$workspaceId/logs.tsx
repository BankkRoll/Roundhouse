import { createFileRoute } from "@tanstack/react-router";
import { ComingSoon } from "../../../../features/shell/coming-soon";

/** Logs placeholder until log streaming ships. */
export const Route = createFileRoute("/_app/w/$workspaceId/logs")({
  staticData: { title: "Logs" },
  component: () => <ComingSoon feature="logs" />,
});
