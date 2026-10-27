import { createFileRoute } from "@tanstack/react-router";
import { RunsTab } from "../../../../../../../../features/services/cron/runs-tab";

/** A cron service's schedule state and runs. */
export const Route = createFileRoute("/_app/w/$workspaceId/p/$projectId/s/$serviceId/runs")({
  staticData: { title: "Runs" },
  component: RunsRoute,
});

function RunsRoute() {
  const { workspaceId, projectId, serviceId } = Route.useParams();
  return <RunsTab workspaceId={workspaceId} projectId={projectId} serviceId={serviceId} />;
}
