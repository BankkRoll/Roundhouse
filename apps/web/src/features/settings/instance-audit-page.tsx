import { type AuditAction, INSTANCE_AUDIT_ACTIONS } from "@roundhouse/shared";
import {
  Button,
  EmptyState,
  Label,
  Select,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@roundhouse/ui";
import {
  CircleCheckIcon,
  HistoryIcon,
  LinkIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldIcon,
} from "lucide-react";
import { useId, useState } from "react";
import { ErrorState } from "../../components/error-state";
import { errorMessage } from "../../lib/api/client";
import type { AuditChainVerification } from "../../lib/api/security-types";
import { EMPTY, formatAgo, formatTimestamp } from "../../lib/format";
import { canManageInstance } from "../../lib/permissions";
import { useNow } from "../../lib/use-now";
import {
  type InstanceAuditFilters,
  useInstanceAuditLog,
  useVerifyAuditChain,
} from "../../queries/instance";
import { useMe } from "../../queries/me";
import { actorLabel } from "../audit/describe-action";
import { SettingsFrame } from "./settings-frame";

function VerificationResult({ result }: { result: AuditChainVerification }) {
  const pending =
    result.unsealed > 0 ? ` ${result.unsealed} newer entries are not sealed yet.` : "";
  return result.ok ? (
    <p
      role="status"
      className="mb-6 flex items-start gap-2 rounded-md border border-success/30 bg-success/10 p-3 text-sm text-foreground"
    >
      <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
      <span>
        Chain intact: {result.checked} entries checked up to #{result.head_seq}, against{" "}
        {result.checkpoints} checkpoint{result.checkpoints === 1 ? "" : "s"} kept outside the
        database.{pending}
      </span>
    </p>
  ) : (
    <p
      role="alert"
      className="mb-6 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/10 p-3 text-sm text-foreground"
    >
      <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
      <span>
        <strong className="font-medium">The audit log was changed.</strong> The chain breaks at
        entry #{result.broken_at_seq}: an entry there or after it was edited, removed or reordered
        outside the control plane. Treat everything from that entry on as untrustworthy and
        investigate who has database access.
      </span>
    </p>
  );
}

/**
 * The instance audit log (ADR 0014): what happened outside any workspace (setup,
 * instance settings, instance admins, keys, the GitHub App, sign-ins and
 * re-authentication), newest first, filterable by action, with on-demand verification
 * of the log's hash chain. Instance admins only.
 *
 * @param props - Workspace id, for the settings frame.
 * @returns The page.
 */
export function InstanceAuditPage({ workspaceId }: { workspaceId: string }) {
  const { data: me } = useMe();
  const allowed = canManageInstance(me);
  const [action, setAction] = useState<AuditAction | "">("");
  const filters: InstanceAuditFilters = action ? { action } : {};
  const log = useInstanceAuditLog(filters, allowed);
  const verify = useVerifyAuditChain();
  const now = useNow(30_000);
  const actionId = useId();
  const rows = log.data?.pages.flatMap((page) => page.entries) ?? [];

  return (
    <SettingsFrame
      workspaceId={workspaceId}
      title="Instance audit log"
      description="Sign-ins, instance settings, admins, keys and the GitHub App, newest first. Every entry is hash-chained, so changes made behind the control plane's back show up."
      actions={
        allowed ? (
          <Button variant="secondary" loading={verify.isPending} onClick={() => verify.mutate()}>
            <LinkIcon />
            Verify chain
          </Button>
        ) : undefined
      }
    >
      {!allowed ? (
        <EmptyState
          icon={<ShieldIcon />}
          title="The instance audit log is for instance admins"
          description="Workspace activity is in each workspace's own audit log."
        />
      ) : (
        <>
          {verify.data ? <VerificationResult result={verify.data} /> : null}
          {verify.isError ? (
            <p role="alert" className="mb-6 text-sm text-danger">
              {errorMessage(verify.error)}
            </p>
          ) : null}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Label htmlFor={actionId} className="text-sm text-muted-foreground">
              Action
            </Label>
            <Select
              id={actionId}
              className="w-auto min-w-56"
              value={action}
              onChange={(event) => setAction(event.target.value as AuditAction | "")}
            >
              <option value="">All actions</option>
              {INSTANCE_AUDIT_ACTIONS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </div>
          {log.isPending ? (
            <Skeleton className="h-64" />
          ) : log.isError ? (
            <ErrorState message={errorMessage(log.error)} onRetry={() => void log.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<HistoryIcon />}
              title={action ? "Nothing recorded for this action" : "No activity yet"}
              description="Instance-level changes and sign-ins show up here as they happen."
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
                    <TableHead>Entry</TableHead>
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
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {entry.actor_type}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-64 truncate font-mono text-xs text-muted-foreground">
                        {entry.target_type
                          ? `${entry.target_type}/${entry.target_id ?? EMPTY}`
                          : EMPTY}
                      </TableCell>
                      <TableCell
                        cell="hide-mobile"
                        className="font-mono text-xs text-muted-foreground"
                      >
                        {entry.ip ?? EMPTY}
                      </TableCell>
                      <TableCell
                        cell="hide-mobile"
                        className="font-mono text-xs whitespace-nowrap text-muted-foreground"
                      >
                        <span className="inline-flex items-center gap-1">
                          #{entry.seq}
                          {entry.hash ? (
                            <CircleCheckIcon
                              className="size-3.5 text-success"
                              aria-label="Sealed"
                              role="img"
                            />
                          ) : null}
                        </span>
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
        </>
      )}
    </SettingsFrame>
  );
}
