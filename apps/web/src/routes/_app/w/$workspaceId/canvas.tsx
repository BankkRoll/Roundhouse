import { createFileRoute } from "@tanstack/react-router";
import { ComingSoon } from "../../../../features/shell/coming-soon";

/** Canvas placeholder until projects ship. */
export const Route = createFileRoute("/_app/w/$workspaceId/canvas")({
  staticData: { title: "Canvas" },
  component: () => <ComingSoon feature="canvas" />,
});
