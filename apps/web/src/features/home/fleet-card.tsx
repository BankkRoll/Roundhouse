import { Meter, Skeleton, StatusDot } from "@openrail/ui";
import { Link } from "@tanstack/react-router";
import { SectionHeader, sectionLinkClasses } from "../../components/section-header";
import { formatPercent, percentOf } from "../../lib/format";
import { useNodes } from "../../queries/nodes";

/**
 * Per-server RAM for the home page: a status dot, the name, a bar at the true ratio and
 * the percentage, one row per server.
 *
 * @param props - Workspace id.
 * @returns The block.
 */
export function FleetCard({ workspaceId }: { workspaceId: string }) {
  const nodes = useNodes(workspaceId);

  return (
    <section aria-labelledby="fleet-heading">
      <SectionHeader
        id="fleet-heading"
        title="Fleet"
        meta="RAM used"
        action={
          <Link
            to="/w/$workspaceId/servers"
            params={{ workspaceId }}
            className={sectionLinkClasses}
          >
            All servers
          </Link>
        }
      />
      {nodes.isPending ? (
        <Skeleton className="h-16" />
      ) : nodes.isError ? (
        <p className="text-sm text-muted-foreground">Could not load servers.</p>
      ) : nodes.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No servers connected yet.</p>
      ) : (
        <ul className="divide-y divide-border/70 border-y border-border/70">
          {nodes.data.map((node) => {
            const percent = percentOf(node.mem_used, node.mem_total);
            return (
              <li
                key={node.id}
                className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_3rem] items-center gap-3 py-2.5"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <StatusDot status={node.status} />
                  <span className="truncate text-sm text-foreground">{node.name}</span>
                </span>
                <Meter value={percent} label={`${node.name} RAM used`} />
                <span className="text-right text-xs text-muted-foreground tabular-nums">
                  {formatPercent(percent)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
