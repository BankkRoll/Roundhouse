import { METRICS_RANGES, type MetricsRange } from "@roundhouse/shared";
import { EmptyState, Skeleton } from "@roundhouse/ui";
import { SegmentedControl } from "@roundhouse/ui/controls";
import { ActivityIcon } from "lucide-react";
import { ErrorState } from "../../components/error-state";
import { errorMessage } from "../../lib/api/client";
import { formatDuration } from "../../lib/format";
import { useServiceMetrics } from "../../queries/metrics";
import { useProjectEnvironment } from "../projects/use-project-environment";
import type { ServicePageProps } from "../services/service-layout";
import { MetricChart } from "./metric-chart";
import { hasSamples } from "./scale";
import { buildPanels } from "./series";

/** Range presets in picker order. */
export const RANGE_OPTIONS = Object.keys(METRICS_RANGES) as MetricsRange[];

/** Grouping of the Metrics tab: the whole service, or one series per replica. */
export type MetricsGroup = "service" | "replica";

/** Props for {@link MetricsTab}. */
export interface MetricsTabProps extends ServicePageProps {
  range: MetricsRange;
  group: MetricsGroup;
  /** The range or grouping was changed; usually written to the URL. */
  onChange: (next: { range?: MetricsRange; group?: MetricsGroup }) => void;
}

const RANGE_WORDS: Record<MetricsRange, string> = {
  "1h": "hour",
  "6h": "6 hours",
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

function Note({ children, title }: { children: string; title: string }) {
  return (
    <span title={title} className="text-xs text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * A service's Metrics tab: a range picker (1 h to 30 d), a whole-service or per-replica
 * toggle, and charts for CPU (with its limit), memory (working set and limit), network,
 * disk and restarts. Refreshes once per step, never faster than every 30 s. Notes say
 * when the data is short-retention (no Analytics Engine token) or approximate (cgroup v1
 * hosts).
 *
 * Only container resource usage is collected; request rates, errors and latency have
 * no source yet, so there are no charts for them.
 *
 * @param props - Ids, the selected range and grouping, and the change handler.
 * @returns The tab.
 */
export function MetricsTab({ projectId, serviceId, range, group, onChange }: MetricsTabProps) {
  const { environment } = useProjectEnvironment(projectId);
  const metrics = useServiceMetrics(serviceId, environment?.id, range, group);
  const data = metrics.data;
  const panels = data ? buildPanels(data, group) : [];
  const empty = data ? !hasSamples(data.series) : false;

  return (
    <section aria-label="Metrics" className="min-w-0">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<MetricsRange>
            label="Time range"
            value={range}
            onValueChange={(next) => onChange({ range: next })}
            options={RANGE_OPTIONS.map((value) => ({ value, label: value }))}
          />
          <SegmentedControl<MetricsGroup>
            label="Group by"
            value={group}
            onValueChange={(next) => onChange({ group: next })}
            options={[
              { value: "service", label: "Service" },
              { value: "replica", label: "Per replica" },
            ]}
          />
        </div>
        {data ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {data.short_retention ? (
              <Note title="No Analytics Engine token is configured, so samples are kept in D1 for 48 hours.">
                short retention (48 h)
              </Note>
            ) : null}
            {data.approximate ? (
              <Note title="Some samples came from Docker stats on a cgroup v1 host.">
                approximate (cgroup v1)
              </Note>
            ) : null}
            <Note title="Each point averages the samples in one step.">
              {`${formatDuration(data.step_s * 1000)} steps`}
            </Note>
          </p>
        ) : null}
      </div>

      {metrics.isPending ? (
        <div className="grid gap-x-10 gap-y-8 lg:grid-cols-2" aria-busy="true">
          {["cpu", "memory", "network", "disk"].map((id) => (
            <Skeleton key={id} className="h-48" />
          ))}
        </div>
      ) : metrics.isError ? (
        <ErrorState
          title="Could not load metrics"
          message={errorMessage(metrics.error)}
          onRetry={() => void metrics.refetch()}
        />
      ) : empty || !data ? (
        <EmptyState
          icon={<ActivityIcon />}
          title="No metrics in this range"
          description={`Running replicas report CPU, memory, network and disk every 15 seconds. None reported in the last ${RANGE_WORDS[range]}.`}
          className="py-16"
        />
      ) : (
        <div className="grid gap-x-10 gap-y-8 lg:grid-cols-2">
          {panels.map((panel) => (
            <MetricChart
              key={panel.id}
              title={panel.title}
              series={panel.series}
              from={data.from}
              to={data.to}
              stepS={data.step_s}
              format={panel.format}
              binary={panel.binary}
              limit={panel.limit}
              kind={panel.kind}
              height={panel.kind === "bars" ? 120 : 168}
            />
          ))}
        </div>
      )}
    </section>
  );
}
