import { METRICS_RANGES, type MetricsRange } from "@roundhouse/shared";
import { createFileRoute } from "@tanstack/react-router";
import {
  type MetricsGroup,
  MetricsTab,
} from "../../../../../../../../features/metrics/metrics-tab";

/** Search params of the metrics tab; the defaults (1 h, whole service) stay out of the URL. */
export interface MetricsSearch {
  range?: MetricsRange;
  group?: "replica";
}

function isRange(value: unknown): value is MetricsRange {
  return typeof value === "string" && Object.hasOwn(METRICS_RANGES, value);
}

/** A service's CPU, memory, network, disk and restart charts. */
export const Route = createFileRoute("/_app/w/$workspaceId/p/$projectId/s/$serviceId/metrics")({
  staticData: { title: "Metrics" },
  validateSearch: (search: Record<string, unknown>): MetricsSearch => ({
    range: isRange(search.range) && search.range !== "1h" ? search.range : undefined,
    group: search.group === "replica" ? "replica" : undefined,
  }),
  component: MetricsRoute,
});

function MetricsRoute() {
  const { workspaceId, projectId, serviceId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <MetricsTab
      workspaceId={workspaceId}
      projectId={projectId}
      serviceId={serviceId}
      range={search.range ?? "1h"}
      group={search.group ?? "service"}
      onChange={(next: { range?: MetricsRange; group?: MetricsGroup }) =>
        void navigate({
          search: (previous): MetricsSearch => ({
            range:
              "range" in next ? (next.range === "1h" ? undefined : next.range) : previous.range,
            group:
              "group" in next ? (next.group === "replica" ? "replica" : undefined) : previous.group,
          }),
          replace: true,
        })
      }
    />
  );
}
