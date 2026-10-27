/**
 * The workspace's web shell sessions (ADR 0012 "Web shell"), for audit readers: who
 * opened a shell in which replica, when, for how long, how it ended, and whether it was
 * recorded. Recorded sessions play back in {@link RecordingPlayer}, behind a password
 * confirmation when the session isn't fresh.
 *
 * @module
 */
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@roundhouse/ui";
import { LockIcon, PlayIcon, TerminalIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { ErrorState } from "../../components/error-state";
import { errorMessage } from "../../lib/api/client";
import type { ShellSession } from "../../lib/api/shell-client";
import { EMPTY, formatAgo, formatDuration, formatTimestamp } from "../../lib/format";
import { usePermissions } from "../../lib/permissions";
import { useNow } from "../../lib/use-now";
import { useMembers } from "../../queries/members";
import { useProjectSummaries } from "../../queries/projects";
import { useShellSessions } from "../../queries/shell";
import { describeExitReason } from "../services/shell/shell-connection";
import { SettingsFrame } from "../settings/settings-frame";
import { RecordingPlayer } from "./recording-player";

const RECORDING_BADGES: Record<
  ShellSession["recording"],
  { label: string; tone: "success" | "neutral" | "danger" | "info" } | null
> = {
  stored: { label: "Recorded", tone: "success" },
  recording: { label: "Recording", tone: "info" },
  failed: { label: "Not saved", tone: "danger" },
  none: null,
};

function endLabel(session: ShellSession): string {
  if (session.ended_at === null) return "Open";
  if (session.end_reason === "terminated") return "Terminated";
  return describeExitReason(session.end_reason ?? "closed");
}

/**
 * The page.
 *
 * @param props - Workspace id.
 * @returns The page.
 */
export function ShellSessionsPage({ workspaceId }: { workspaceId: string }) {
  const { can } = usePermissions(workspaceId);
  const allowed = can("audit:read");
  const sessions = useShellSessions(workspaceId, allowed);
  const members = useMembers(workspaceId, allowed && can("members:read"));
  const projects = useProjectSummaries(workspaceId, allowed);
  const now = useNow(30_000);
  const [playing, setPlaying] = useState<ShellSession | null>(null);
  const rows = sessions.data?.pages.flatMap((page) => page.sessions) ?? [];

  const users = useMemo(
    () => new Map((members.data ?? []).map((m) => [m.user_id, m.name || m.email])),
    [members.data],
  );
  const services = useMemo(() => {
    const map = new Map<string, { name: string; project: string }>();
    for (const project of projects.data ?? []) {
      for (const { service } of project.services) {
        map.set(service.id, { name: service.name, project: project.name });
      }
    }
    return map;
  }, [projects.data]);

  const serviceName = (session: ShellSession) =>
    services.get(session.service_id)?.name ?? "A service";
  const userName = (session: ShellSession) =>
    session.user_id ? (users.get(session.user_id) ?? "A former member") : EMPTY;

  return (
    <SettingsFrame
      workspaceId={workspaceId}
      title="Shell sessions"
      description="Every web shell opened in this workspace, newest first. Recorded sessions can be played back by audit readers who may also open the shell."
    >
      {!allowed ? (
        <EmptyState
          icon={<LockIcon />}
          title="Shell sessions are limited to admins"
          description="Ask a workspace owner or admin if you need to review who opened a shell."
        />
      ) : sessions.isPending ? (
        <Skeleton className="h-64" />
      ) : sessions.isError ? (
        <ErrorState
          message={errorMessage(sessions.error)}
          onRetry={() => void sessions.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<TerminalIcon />}
          title="No shell sessions yet"
          description="Shells opened from a service's Shell tab or the CLI show up here."
        />
      ) : (
        <>
          <Table stack>
            <TableHeader>
              <TableRow>
                <TableHead>Service</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Ended</TableHead>
                <TableHead>Recording</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((session) => {
                const badge = RECORDING_BADGES[session.recording];
                const service = services.get(session.service_id);
                return (
                  <TableRow key={session.id}>
                    <TableCell cell="primary" className="text-sm">
                      <span className="text-foreground">{serviceName(session)}</span>
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {service ? `${service.project} · ` : ""}replica {session.replica}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-foreground">{userName(session)}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                      <time
                        dateTime={new Date(session.started_at).toISOString()}
                        title={formatTimestamp(session.started_at)}
                      >
                        {formatAgo(session.started_at, now)}
                      </time>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground tabular-nums">
                      {formatDuration((session.ended_at ?? now) - session.started_at)}
                    </TableCell>
                    <TableCell cell="hide-mobile" className="text-xs text-muted-foreground">
                      {endLabel(session)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {badge ? <Badge tone={badge.tone}>{badge.label}</Badge> : EMPTY}
                    </TableCell>
                    <TableCell cell="action" className="text-right">
                      {session.recording === "stored" ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setPlaying(session)}
                          aria-label={`Play the recording of ${serviceName(session)}, replica ${session.replica}, ${formatTimestamp(session.started_at)}`}
                        >
                          <PlayIcon aria-hidden="true" />
                          Play
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <div className="mt-6 flex justify-center">
            {sessions.hasNextPage ? (
              <Button
                variant="secondary"
                onClick={() => void sessions.fetchNextPage()}
                loading={sessions.isFetchingNextPage}
              >
                Load older sessions
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">End of shell sessions</p>
            )}
          </div>
        </>
      )}
      <Dialog
        open={playing !== null}
        onOpenChange={(open) => {
          if (!open) setPlaying(null);
        }}
      >
        {playing ? (
          <DialogContent className="max-w-5xl">
            <DialogHeader>
              <DialogTitle>
                {serviceName(playing)}, replica {playing.replica}
              </DialogTitle>
              <DialogDescription>
                {userName(playing)} · {formatTimestamp(playing.started_at)} · {endLabel(playing)}.
                Viewing a recording is recorded in the audit log.
              </DialogDescription>
            </DialogHeader>
            <RecordingPlayer
              sessionId={playing.id}
              label={`Recording of ${serviceName(playing)}, replica ${playing.replica}`}
            />
          </DialogContent>
        ) : null}
      </Dialog>
    </SettingsFrame>
  );
}
