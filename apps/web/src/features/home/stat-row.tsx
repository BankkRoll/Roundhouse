import { Meter, Skeleton, StatCard } from "@roundhouse/ui";
import { useQueries } from "@tanstack/react-query";
import { EMPTY, formatPercent } from "../../lib/format";
import { useNodes } from "../../queries/nodes";
import {
  latestDeploymentQueryOptions,
  pickEnvironment,
  projectQueryOptions,
  useProjects,
} from "../../queries/projects";
import { summarizeFleet } from "../servers/node-metrics";

function FleetStat({ workspaceId }: { workspaceId: string }) {
  const nodes = useNodes(workspaceId);
  if (nodes.isPending) return <Skeleton className="h-[118px] rounded-lg" />;
  if (nodes.isError) return <StatCard label="Fleet" value={EMPTY} sub="Could not load servers" />;

  const fleet = summarizeFleet(nodes.data);
  const notes: string[] = [];
  if (fleet.attention > 0) notes.push(`${fleet.attention} need attention`);
  if (fleet.offline > 0) notes.push(`${fleet.offline} offline`);
  if (fleet.memPercent !== null) notes.push(`${formatPercent(fleet.memPercent)} RAM used`);

  return (
    <StatCard
      label="Fleet"
      value={fleet.total === 0 ? "No servers" : `${fleet.online} online`}
      sub={
        notes.length > 0
          ? notes.join(" · ")
          : fleet.total === 0
            ? "Add one to get started"
            : "Waiting for usage"
      }
    >
      <Meter value={fleet.memPercent} label="Fleet memory usage" />
    </StatCard>
  );
}

/**
 * Counts services across every project and how many are live, deploying or failing,
 * from each service's newest production deployment.
 */
function useServiceTotals(workspaceId: string) {
  const projects = useProjects(workspaceId);
  const details = useQueries({
    queries: (projects.data ?? []).map((project) => ({
      ...projectQueryOptions(project.id),
      staleTime: 30_000,
    })),
  });
  const services = details.flatMap((detail) => {
    if (!detail.data) return [];
    const production = pickEnvironment(detail.data.environments);
    return production
      ? detail.data.services.map((service) => ({ service, environmentId: production.id }))
      : [];
  });
  const latest = useQueries({
    queries: services.map(({ service, environmentId }) => ({
      ...latestDeploymentQueryOptions(service.id, environmentId),
      staleTime: 15_000,
    })),
  });
  const statuses = latest.map((query) => query.data?.status);
  const failing = services.filter((_, index) =>
    ["failed", "crashed"].includes(statuses[index] ?? ""),
  );
  return {
    isPending: projects.isPending || details.some((detail) => detail.isPending),
    isError: projects.isError,
    projects: projects.data?.length ?? 0,
    services: services.length,
    live: statuses.filter((status) => status === "active").length,
    deploying: statuses.filter((s) => s === "queued" || s === "building" || s === "deploying")
      .length,
    failing: failing.map(({ service }) => service.name),
  };
}

function ServicesStats({ workspaceId }: { workspaceId: string }) {
  const totals = useServiceTotals(workspaceId);
  if (totals.isPending) {
    return (
      <>
        <Skeleton className="h-[118px] rounded-lg" />
        <Skeleton className="h-[118px] rounded-lg" />
      </>
    );
  }
  if (totals.isError) {
    return (
      <>
        <StatCard label="Services" value={EMPTY} sub="Could not load projects" />
        <StatCard label="Incidents" value={EMPTY} sub="Could not load projects" />
      </>
    );
  }
  const notes = [`${totals.live} live`];
  if (totals.deploying > 0) notes.push(`${totals.deploying} deploying`);
  return (
    <>
      <StatCard
        label="Services"
        value={totals.services === 0 ? "None yet" : `${totals.services}`}
        sub={
          totals.services === 0
            ? `${totals.projects} ${totals.projects === 1 ? "project" : "projects"}`
            : `${notes.join(" · ")} · ${totals.projects} ${totals.projects === 1 ? "project" : "projects"}`
        }
      />
      <StatCard
        label="Incidents"
        value={totals.failing.length === 0 ? EMPTY : `${totals.failing.length} failing`}
        sub={totals.failing.length === 0 ? "Nothing to report" : totals.failing.join(", ")}
      />
    </>
  );
}

/**
 * Home page stat cards, all from real data: the fleet, services and their newest
 * deployments. Cost stays empty until Usage ships rather than showing a guess.
 *
 * @param props - Workspace id.
 * @returns The stat row.
 */
export function StatRow({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <FleetStat workspaceId={workspaceId} />
      <StatCard label="This month" value={EMPTY} sub="Cost estimates arrive with Usage" />
      <ServicesStats workspaceId={workspaceId} />
    </div>
  );
}
