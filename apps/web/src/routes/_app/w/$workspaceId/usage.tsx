import { createFileRoute } from "@tanstack/react-router";
import { ComingSoon } from "../../../../features/shell/coming-soon";

/** Usage placeholder until the cost estimator ships. */
export const Route = createFileRoute("/_app/w/$workspaceId/usage")({
  staticData: { title: "Usage" },
  component: () => <ComingSoon feature="usage" />,
});
