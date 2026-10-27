import {
  Button,
  EmptyState,
  SettingsSection,
  SettingsStack,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@roundhouse/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { LockIcon, PlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";
import { ErrorState } from "../../components/error-state";
import { errorMessage } from "../../lib/api/client";
import { formatRelativeTime, formatTimestamp } from "../../lib/format";
import { usePermissions } from "../../lib/permissions";
import { useTeams } from "../../queries/access";
import { useMembers } from "../../queries/members";
import { SettingsFrame } from "../settings/settings-frame";
import { CreateTeamDialog } from "./create-team-dialog";

/**
 * The workspace's teams: a dense table linking to each team, and team creation for
 * roles with `members:manage`. Roles without `members:read` see why the list is hidden.
 *
 * @param props - Workspace id.
 * @returns The page.
 */
export function TeamsPage({ workspaceId }: { workspaceId: string }) {
  const { can } = usePermissions(workspaceId);
  const canRead = can("members:read");
  const canManage = can("members:manage");
  const teams = useTeams(workspaceId, canRead);
  const members = useMembers(workspaceId, canManage);
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  return (
    <SettingsFrame
      workspaceId={workspaceId}
      title="Teams"
      description="Groups of members that projects and environment protection can name at once."
      actions={
        canManage ? (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <PlusIcon />
            New team
          </Button>
        ) : null
      }
    >
      {!canRead ? (
        <EmptyState
          icon={<LockIcon />}
          title="Teams are hidden for your role"
          description="Ask a workspace admin if you need to see who belongs to which team."
        />
      ) : teams.isPending ? (
        <Skeleton className="h-40" />
      ) : teams.isError ? (
        <ErrorState message={errorMessage(teams.error)} onRetry={() => void teams.refetch()} />
      ) : teams.data.length === 0 ? (
        <EmptyState
          icon={<UsersIcon />}
          title="No teams yet"
          description={
            canManage
              ? "Create a team to grant a group of people access to a project in one step."
              : "Workspace admins can create teams to grant groups access to projects."
          }
        />
      ) : (
        <SettingsStack>
          <SettingsSection
            title="All teams"
            description="A member's project role is the highest of their default role, their own grant and the grants of every team they're in."
          >
            <Table stack>
              <TableHeader>
                <TableRow>
                  <TableHead>Team</TableHead>
                  <TableHead className="text-right">Members</TableHead>
                  <TableHead className="text-right">Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {teams.data.map((team) => (
                  <TableRow key={team.id}>
                    <TableCell cell="primary">
                      <Link
                        to="/w/$workspaceId/teams/$teamId"
                        params={{ workspaceId, teamId: team.id }}
                        className="text-sm text-foreground outline-none hover:underline focus-visible:underline"
                      >
                        {team.name}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">
                        <span className="font-mono">@{team.slug}</span>
                        {team.description ? ` · ${team.description}` : null}
                      </p>
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      <span className="sm:hidden">Members </span>
                      {team.member_count}
                    </TableCell>
                    <TableCell className="text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                      <span title={formatTimestamp(team.created_at)}>
                        <span className="sm:hidden">Created </span>
                        {formatRelativeTime(team.created_at)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </SettingsSection>
        </SettingsStack>
      )}
      {canManage ? (
        <CreateTeamDialog
          workspaceId={workspaceId}
          open={creating}
          onOpenChange={setCreating}
          members={members.data ?? []}
          onCreated={(team) =>
            void navigate({
              to: "/w/$workspaceId/teams/$teamId",
              params: { workspaceId, teamId: team.id },
            })
          }
        />
      ) : null}
    </SettingsFrame>
  );
}
