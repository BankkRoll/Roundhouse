import {
  Button,
  EmptyState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@openrail/ui";
import { HistoryIcon, LockIcon } from "lucide-react";
import { ErrorState } from "../../components/error-state";
import { errorMessage } from "../../lib/api/client";
import { EMPTY, formatAgo, formatTimestamp } from "../../lib/format";
import { usePermissions } from "../../lib/permissions";
import { useNow } from "../../lib/use-now";
import { useAuditLog } from "../../queries/audit";
import { SettingsFrame } from "../settings/settings-frame";
import { actorLabel } from "./describe-action";

/**
 * Cursor-paginated audit log as a table that stacks into two-line rows on phones.
 *
 * @param props - Workspace id.
 * @returns The page.
 */
export function AuditPage({ workspaceId }: { workspaceId: string }) {
  const { can } = usePermissions(workspaceId);
  const allowed = can("audit:read");
  const log = useAuditLog(workspaceId, allowed);
  const now = useNow(30_000);
  const rows = log.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <SettingsFrame
      workspaceId={workspaceId}
      title="Audit log"
      description="Every change made in this workspace, newest first."
    >
      {!allowed ? (
        <EmptyState
          icon={<LockIcon />}
          title="The audit log is limited to admins"
          description="Ask a workspace owner or admin if you need to review changes."
        />
      ) : log.isPending ? (
        <Skeleton className="h-64" />
      ) : log.isError ? (
        <ErrorState message={errorMessage(log.error)} onRetry={() => void log.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<HistoryIcon />}
          title="No activity yet"
          description="Changes show up here as they happen."
        />
      ) : (
        <>
          <Table stack>
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>IP</TableHead>
                <TableHead className="text-right">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell cell="primary" className="font-mono text-xs text-foreground">
                    {entry.action}
                  </TableCell>
                  <TableCell className="text-sm">
                    <span className="text-foreground">{actorLabel(entry)}</span>
                    <span className="ml-1.5 text-xs text-muted-foreground">{entry.actor_type}</span>
                  </TableCell>
                  <TableCell className="max-w-64 truncate font-mono text-xs text-muted-foreground">
                    {entry.target_type ? `${entry.target_type}/${entry.target_id ?? EMPTY}` : EMPTY}
                  </TableCell>
                  <TableCell cell="hide-mobile" className="font-mono text-xs text-muted-foreground">
                    {entry.ip ?? EMPTY}
                  </TableCell>
                  <TableCell
                    cell="action"
                    className="text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums"
                  >
                    <time
                      dateTime={new Date(entry.created_at).toISOString()}
                      title={formatTimestamp(entry.created_at)}
                    >
                      {formatAgo(entry.created_at, now)}
                    </time>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="mt-6 flex justify-center">
            {log.hasNextPage ? (
              <Button
                variant="secondary"
                onClick={() => void log.fetchNextPage()}
                loading={log.isFetchingNextPage}
              >
                Load older entries
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">End of audit log</p>
            )}
          </div>
        </>
      )}
    </SettingsFrame>
  );
}
