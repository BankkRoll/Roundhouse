import type { AuditAction } from "@openrail/shared";
import { Badge, type BadgeProps, Skeleton } from "@openrail/ui";
import { Link } from "@tanstack/react-router";
import { SectionHeader, sectionLinkClasses } from "../../components/section-header";
import { formatAgo, formatTimestamp } from "../../lib/format";
import { usePermissions } from "../../lib/permissions";
import { useNow } from "../../lib/use-now";
import { useRecentActivity } from "../../queries/audit";
import { actorLabel, describeAction } from "../audit/describe-action";

/** Entries the home feed shows. */
const FEED_SIZE = 6;

/**
 * The kind of thing an audit action touched, shown as the row's tag. Failed deploys
 * and lost servers are tinted; everything else is neutral.
 *
 * @param action - Audit action, e.g. `deployment.failed`.
 * @returns The tag's label and tone.
 */
export function activityTag(action: AuditAction | string): {
  label: string;
  tone: BadgeProps["tone"];
} {
  if (action === "deployment.failed") return { label: "Deploy", tone: "danger" };
  if (action === "deployment.succeeded") return { label: "Deploy", tone: "success" };
  const [kind] = action.split(".");
  switch (kind) {
    case "deployment":
      return { label: "Deploy", tone: "neutral" };
    case "node":
      return { label: "Server", tone: action === "node.went_offline" ? "warning" : "neutral" };
    case "member":
    case "invite":
      return { label: "Member", tone: "neutral" };
    case "project":
      return { label: "Project", tone: "neutral" };
    case "service":
    case "variables":
      return { label: "Service", tone: "neutral" };
    case "token":
      return { label: "Token", tone: "neutral" };
    case "github":
      return { label: "GitHub", tone: "neutral" };
    default:
      return { label: "Settings", tone: "neutral" };
  }
}

/**
 * The newest entries of the audit log as a feed: a tag for what was touched, the
 * sentence, and how long ago. Roles without `audit:read` get a short note instead, since
 * the feed is the audit log.
 *
 * @param props - Workspace id.
 * @returns The block.
 */
export function ActivityCard({ workspaceId }: { workspaceId: string }) {
  const { can } = usePermissions(workspaceId);
  const allowed = can("audit:read");
  const activity = useRecentActivity(workspaceId, FEED_SIZE, allowed);
  const now = useNow(30_000);

  return (
    <section aria-labelledby="activity-heading">
      <SectionHeader
        id="activity-heading"
        title="Activity"
        action={
          allowed ? (
            <Link
              to="/w/$workspaceId/audit"
              params={{ workspaceId }}
              className={sectionLinkClasses}
            >
              Audit log
            </Link>
          ) : null
        }
      />
      {!allowed ? (
        <p className="text-sm text-muted-foreground">Activity is visible to owners and admins.</p>
      ) : activity.isPending ? (
        <div className="grid gap-3">
          <Skeleton className="h-5" />
          <Skeleton className="h-5" />
          <Skeleton className="h-5" />
        </div>
      ) : activity.isError || activity.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {activity.isError ? "Could not load activity." : "Nothing has happened yet."}
        </p>
      ) : (
        <ul className="divide-y divide-border/70 border-y border-border/70">
          {activity.data.map((entry) => {
            const { verb, target } = describeAction(entry);
            const tag = activityTag(entry.action);
            return (
              <li key={entry.id} className="flex items-start gap-3 py-2.5 text-sm">
                <Badge tone={tag.tone} className="mt-px w-16 justify-center">
                  {tag.label}
                </Badge>
                <p className="min-w-0 flex-1 leading-snug text-muted-foreground">
                  <span className="font-medium text-foreground">{actorLabel(entry)}</span> {verb}
                  {target ? (
                    <>
                      {" "}
                      <span className="break-all text-foreground">{target}</span>
                    </>
                  ) : null}
                </p>
                <time
                  className="shrink-0 pt-px text-xs text-muted-foreground tabular-nums"
                  dateTime={new Date(entry.created_at).toISOString()}
                  title={formatTimestamp(entry.created_at)}
                >
                  {formatAgo(entry.created_at, now)}
                </time>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
