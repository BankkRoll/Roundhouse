import { Kpi, KpiStrip, Meter, Skeleton } from "@roundhouse/ui";
import { EMPTY, formatPercent, formatRelativeTime } from "../../lib/format";
import { usePermissions } from "../../lib/permissions";
import { useNow } from "../../lib/use-now";
import { DEPLOY_HISTORY_DAYS, useDeployHistory } from "../../queries/audit";
import { useNodes } from "../../queries/nodes";
import { useProjectSummaries } from "../../queries/projects";
import { summarizeFleet } from "../servers/node-metrics";

// NOTE: A function, not a component, so the loading cell and the loaded cell are the same
// <Kpi> element and React keeps its node; screen readers and tests hold on to one region.
function loading(label: string) {
  return (
    <Kpi label={label} value={<Skeleton className="mt-1 h-6 w-12" />} sub={<span>&nbsp;</span>} />
  );
}

function FleetKpi({ workspaceId }: { workspaceId: string }) {
  const nodes = useNodes(workspaceId);
  if (nodes.isPending) return loading("Servers online");
  if (nodes.isError) {
    return <Kpi label="Servers online" value={EMPTY} sub="Could not load servers" />;
  }

  const fleet = summarizeFleet(nodes.data);
  const notes: string[] = [];
  if (fleet.attention > 0) notes.push(`${fleet.attention} need attention`);
  if (fleet.offline > 0) notes.push(`${fleet.offline} offline`);
  if (fleet.memPercent !== null) notes.push(`${formatPercent(fleet.memPercent)} RAM used`);

  return (
    <Kpi
      label="Servers online"
      value={fleet.online}
      unit={fleet.total === 0 ? "no servers yet" : `of ${fleet.total}`}
      sub={
        notes.length > 0
          ? notes.join(" · ")
          : fleet.total === 0
            ? "Add one to get started"
            : "Waiting for usage"
      }
    >
      <Meter value={fleet.memPercent} label="Fleet memory usage" />
    </Kpi>
  );
}

/**
 * Counts services across every project and how many are live, deploying or failing,
 * from each service's newest production deployment in the workspace's summaries.
 */
function useServiceTotals(workspaceId: string) {
  const summaries = useProjectSummaries(workspaceId);
  const services = (summaries.data ?? []).flatMap((project) => project.services);
  const statuses = services.map((entry) => entry.latest_deployment?.status);
  return {
    isPending: summaries.isPending,
    isError: summaries.isError,
    projects: summaries.data?.length ?? 0,
    services: services.length,
    live: statuses.filter((status) => status === "active").length,
    deploying: statuses.filter((s) => s === "queued" || s === "building" || s === "deploying")
      .length,
    failing: services
      .filter((_, index) => statuses[index] === "failed" || statuses[index] === "crashed")
      .map((entry) => entry.service.name),
  };
}

function ServicesKpi({ workspaceId }: { workspaceId: string }) {
  const totals = useServiceTotals(workspaceId);
  if (totals.isPending) return loading("Services");
  if (totals.isError) return <Kpi label="Services" value={EMPTY} sub="Could not load projects" />;
  const projects = `${totals.projects} ${totals.projects === 1 ? "project" : "projects"}`;
  const notes = [`${totals.live} live`];
  if (totals.deploying > 0) notes.push(`${totals.deploying} deploying`);
  return (
    <Kpi
      label="Services"
      value={totals.services}
      sub={totals.services === 0 ? projects : `${notes.join(" · ")} · ${projects}`}
    />
  );
}

function IncidentsKpi({ workspaceId }: { workspaceId: string }) {
  const totals = useServiceTotals(workspaceId);
  if (totals.isPending) return loading("Incidents");
  if (totals.isError) return <Kpi label="Incidents" value={EMPTY} sub="Could not load projects" />;
  const failing = totals.failing;
  return (
    <Kpi
      label="Incidents"
      value={failing.length}
      unit={failing.length > 0 ? "failing" : undefined}
      alert={failing.length > 0}
      sub={failing.length === 0 ? "Nothing to report" : failing.join(", ")}
    />
  );
}

function DeploysKpi({ workspaceId }: { workspaceId: string }) {
  const { can } = usePermissions(workspaceId);
  const allowed = can("audit:read");
  const history = useDeployHistory(workspaceId, allowed);
  const now = useNow(60_000);
  const label = `Deploys, last ${DEPLOY_HISTORY_DAYS} days`;
  if (!allowed) return <Kpi label={label} value={EMPTY} sub="Visible to owners and admins" />;
  if (history.isPending) return loading(label);
  if (history.isError)
    return <Kpi label={label} value={EMPTY} sub="Could not load the audit log" />;
  const { total, lastAt, partial, days } = history.data;
  const failed = days.reduce((sum, day) => sum + day.failed, 0);
  const notes: string[] = [];
  if (failed > 0) notes.push(`${failed} failed`);
  notes.push(lastAt ? `last ${formatRelativeTime(lastAt, now)}` : "None this week");
  return <Kpi label={label} value={partial ? `${total}+` : total} sub={notes.join(" · ")} />;
}

/**
 * The home page's headline figures, all from real data: servers online and fleet
 * memory, services and their newest deployments, deploys this week from the audit log,
 * and failing services. Nothing is estimated.
 *
 * @param props - Workspace id.
 * @returns The KPI strip.
 */
export function StatRow({ workspaceId }: { workspaceId: string }) {
  return (
    <KpiStrip label="Workspace at a glance">
      <FleetKpi workspaceId={workspaceId} />
      <ServicesKpi workspaceId={workspaceId} />
      <DeploysKpi workspaceId={workspaceId} />
      <IncidentsKpi workspaceId={workspaceId} />
    </KpiStrip>
  );
}
