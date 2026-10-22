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
import { PageHeader } from "../../components/page-header";
import { errorMessage } from "../../lib/api/client";
import { EMPTY, formatAgo, formatTimestamp } from "../../lib/format";
import { usePermissions } from "../../lib/permissions";
import { useNow } from "../../lib/use-now";
import { useAuditLog } from "../../queries/audit";
import { SettingsTabs } from "../settings/settings-tabs";
import { actorLabel } from "./describe-action";

/**
 * Cursor-paginated audit log in a dense, log-style table.
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
    <>
      <PageHeader title="Settings" subline="Every change made in this workspace, newest first." />
      <SettingsTabs workspaceId={workspaceId} />
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
          <div className="rounded-lg border border-border bg-surface">
            <Table className="font-mono text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>IP</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      <time
                        dateTime={new Date(entry.created_at).toISOString()}
                        title={formatTimestamp(entry.created_at)}
                      >
                        {formatAgo(entry.created_at, now)}
                      </time>
                    </TableCell>
                    <TableCell className="font-sans text-sm">
                      <span className="text-foreground">{actorLabel(entry)}</span>
                      <span className="ml-1.5 font-mono text-[10px] text-subtle-foreground">
                        {entry.actor_type}
                      </span>
                    </TableCell>
                    <TableCell className="text-foreground">{entry.action}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {entry.target_type
                        ? `${entry.target_type}/${entry.target_id ?? EMPTY}`
                        : EMPTY}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{entry.ip ?? EMPTY}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="mt-4 flex justify-center">
            {log.hasNextPage ? (
              <Button
                variant="secondary"
                onClick={() => void log.fetchNextPage()}
                loading={log.isFetchingNextPage}
              >
                Load older entries
              </Button>
            ) : (
              <p className="font-mono text-[11px] text-subtle-foreground">End of audit log</p>
            )}
          </div>
        </>
      )}
    </>
  );
}
