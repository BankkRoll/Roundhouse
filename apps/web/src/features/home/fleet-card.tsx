import { Card, CardContent, CardHeader, CardTitle, Meter, Skeleton, StatusDot } from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import { formatPercent, percentOf } from "../../lib/format";
import { useNodes } from "../../queries/nodes";

/**
 * Compact per-server RAM overview for the home page.
 *
 * @param props - Workspace id.
 * @returns The card.
 */
export function FleetCard({ workspaceId }: { workspaceId: string }) {
  const nodes = useNodes(workspaceId);

  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle>Fleet</CardTitle>
        <Link
          to="/w/$workspaceId/servers"
          params={{ workspaceId }}
          className="font-mono text-[11px] text-accent-text outline-none hover:underline focus-visible:underline"
        >
          All servers →
        </Link>
      </CardHeader>
      <CardContent>
        {nodes.isPending ? (
          <Skeleton className="my-2 h-12" />
        ) : nodes.isError ? (
          <p className="py-2 text-sm text-muted-foreground">Could not load servers.</p>
        ) : nodes.data.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">No servers connected yet.</p>
        ) : (
          <>
            <ul className="grid gap-3 py-2">
              {nodes.data.map((node) => {
                const percent = percentOf(node.mem_used, node.mem_total);
                return (
                  <li
                    key={node.id}
                    className="grid grid-cols-[minmax(0,7rem)_1fr_2.75rem] items-center gap-3"
                  >
                    <span className="flex min-w-0 items-center gap-1.5">
                      <StatusDot status={node.status} />
                      <span className="truncate font-mono text-xs text-foreground">
                        {node.name}
                      </span>
                    </span>
                    <Meter value={percent} label={`${node.name} RAM used`} />
                    <span className="text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                      {formatPercent(percent)}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-1 font-mono text-[10px] text-subtle-foreground">Bars show RAM used.</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
