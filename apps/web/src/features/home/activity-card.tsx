import { ActivityItem, Card, CardContent, CardHeader, CardTitle, Skeleton } from "@openrail/ui";
import { Link } from "@tanstack/react-router";
import { formatAgo, formatTimestamp } from "../../lib/format";
import { usePermissions } from "../../lib/permissions";
import { useNow } from "../../lib/use-now";
import { useRecentActivity } from "../../queries/audit";
import { actorLabel, describeAction } from "../audit/describe-action";

/**
 * Recent activity from the audit log. Roles without `audit:read` get a short note
 * instead, since the feed is the audit log.
 *
 * @param props - Workspace id.
 * @returns The card.
 */
export function ActivityCard({ workspaceId }: { workspaceId: string }) {
  const { can } = usePermissions(workspaceId);
  const allowed = can("audit:read");
  const activity = useRecentActivity(workspaceId, 8, allowed);
  const now = useNow(30_000);

  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle>Activity</CardTitle>
        {allowed ? (
          <Link
            to="/w/$workspaceId/audit"
            params={{ workspaceId }}
            className="font-mono text-[11px] text-accent-text outline-none hover:underline focus-visible:underline"
          >
            Audit log →
          </Link>
        ) : null}
      </CardHeader>
      <CardContent>
        {!allowed ? (
          <p className="py-2 text-sm text-muted-foreground">
            Activity is visible to owners and admins.
          </p>
        ) : activity.isPending ? (
          <div className="grid gap-2 py-2">
            <Skeleton className="h-5" />
            <Skeleton className="h-5" />
            <Skeleton className="h-5" />
          </div>
        ) : activity.isError || activity.data.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            {activity.isError ? "Could not load activity." : "Nothing has happened yet."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {activity.data.map((entry) => {
              const { verb, target, icon: Icon } = describeAction(entry);
              return (
                <ActivityItem
                  key={entry.id}
                  icon={<Icon aria-hidden="true" />}
                  actor={actorLabel(entry)}
                  action={verb}
                  target={target ?? undefined}
                  time={formatAgo(entry.created_at, now)}
                  timestamp={formatTimestamp(entry.created_at)}
                />
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
