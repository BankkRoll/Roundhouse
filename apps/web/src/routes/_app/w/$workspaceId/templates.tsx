import { createFileRoute } from "@tanstack/react-router";
import { ComingSoon } from "../../../../features/shell/coming-soon";

/** Templates placeholder until templates ship. */
export const Route = createFileRoute("/_app/w/$workspaceId/templates")({
  staticData: { title: "Templates" },
  component: () => <ComingSoon feature="templates" />,
});
