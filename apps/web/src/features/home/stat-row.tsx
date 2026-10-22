import { Meter, Skeleton, StatCard } from "@openrail/ui";
import { EMPTY, formatPercent } from "../../lib/format";
import { useNodes } from "../../queries/nodes";
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
 * Home page stat cards. Only the fleet card has data in Phase 0; the rest render calm
 * empty states rather than placeholder numbers.
 *
 * @param props - Workspace id.
 * @returns The stat row.
 */
export function StatRow({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <FleetStat workspaceId={workspaceId} />
      <StatCard label="This month" value={EMPTY} sub="Cost estimates arrive with Usage" />
      <StatCard label="Deploys · 7d" value={EMPTY} sub="No deploys yet" />
      <StatCard label="Incidents" value={EMPTY} sub="Nothing to report" />
    </div>
  );
}
