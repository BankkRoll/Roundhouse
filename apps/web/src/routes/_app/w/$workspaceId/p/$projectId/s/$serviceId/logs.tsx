import { createFileRoute } from "@tanstack/react-router";
import { LogsTab } from "../../../../../../../../features/services/logs/logs-tab";

/** Search params of the logs tab. */
export interface LogsSearch {
  /** Deployment to show; the newest when absent. */
  deployment?: string;
  /** Build or runtime output. */
  source?: "build" | "runtime";
}

/** A service's build and runtime logs, live. */
export const Route = createFileRoute("/_app/w/$workspaceId/p/$projectId/s/$serviceId/logs")({
  staticData: { title: "Logs" },
  validateSearch: (search: Record<string, unknown>): LogsSearch => ({
    deployment: typeof search.deployment === "string" ? search.deployment : undefined,
    source: search.source === "build" || search.source === "runtime" ? search.source : undefined,
  }),
  component: LogsRoute,
});

function LogsRoute() {
  const { workspaceId, projectId, serviceId } = Route.useParams();
  const search = Route.useSearch();
  return (
    <LogsTab
      workspaceId={workspaceId}
      projectId={projectId}
      serviceId={serviceId}
      deploymentId={search.deployment}
      source={search.source}
    />
  );
}
