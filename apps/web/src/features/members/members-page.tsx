import { Button, EmptyState, SettingsSection, SettingsStack, Skeleton } from "@openrail/ui";
import { LockIcon, UserPlusIcon } from "lucide-react";
import { ErrorState } from "../../components/error-state";
import { errorMessage } from "../../lib/api/client";
import { usePermissions } from "../../lib/permissions";
import { useMembers } from "../../queries/members";
import { SettingsFrame } from "../settings/settings-frame";
import { useShellActions } from "../shell/shell-actions";
import { MembersTable } from "./members-table";
import { PendingInvites } from "./pending-invites";

/**
 * Workspace members and pending invites. Management controls only render for roles with
 * `members:manage`; roles without `members:read` see an explanation instead of the list.
 *
 * @param props - Workspace id.
 * @returns The page.
 */
export function MembersPage({ workspaceId }: { workspaceId: string }) {
  const { can } = usePermissions(workspaceId);
  const canRead = can("members:read");
  const canManage = can("members:manage");
  const members = useMembers(workspaceId, canRead);
  const { openInviteMember } = useShellActions();

  return (
    <SettingsFrame
      workspaceId={workspaceId}
      title="Members"
      description={
        members.data
          ? `${members.data.length} ${members.data.length === 1 ? "member" : "members"} with access to this workspace.`
          : "People with access to this workspace."
      }
      actions={
        canManage ? (
          <Button variant="primary" onClick={openInviteMember}>
            <UserPlusIcon />
            Invite member
          </Button>
        ) : null
      }
    >
      {!canRead ? (
        <EmptyState
          icon={<LockIcon />}
          title="Members are hidden for your role"
          description="Ask a workspace admin if you need to see who has access."
        />
      ) : members.isPending ? (
        <Skeleton className="h-48" />
      ) : members.isError ? (
        <ErrorState message={errorMessage(members.error)} onRetry={() => void members.refetch()} />
      ) : (
        <SettingsStack>
          <SettingsSection
            title="People"
            description="Owners and admins manage members; members deploy; viewers only look."
          >
            <MembersTable workspaceId={workspaceId} members={members.data} />
          </SettingsSection>
          {canManage ? <PendingInvites workspaceId={workspaceId} /> : null}
        </SettingsStack>
      )}
    </SettingsFrame>
  );
}
