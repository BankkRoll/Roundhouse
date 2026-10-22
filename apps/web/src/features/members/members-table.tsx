import { ROLES } from "@openrail/shared";
import {
  Avatar,
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@openrail/ui";
import { useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { errorMessage } from "../../lib/api/client";
import type { Member } from "../../lib/api/types";
import { formatRelativeTime, formatTimestamp } from "../../lib/format";
import { assignableRoles, usePermissions } from "../../lib/permissions";
import { useMe } from "../../queries/me";
import { useRemoveMember, useUpdateMemberRole } from "../../queries/members";
import { RoleSelect, roleLabel } from "./role-select";

/**
 * Members table with inline role changes and removal for managers.
 *
 * Managers cannot edit themselves (to avoid locking themselves out), and only owners can
 * edit owners.
 *
 * @param props - Workspace id and members.
 * @returns The table.
 */
export function MembersTable({ workspaceId, members }: { workspaceId: string; members: Member[] }) {
  const { data: me } = useMe();
  const { role, can } = usePermissions(workspaceId);
  const canManage = can("members:manage");
  const allowed = assignableRoles(role, ROLES);
  const updateRole = useUpdateMemberRole(workspaceId);
  const remove = useRemoveMember(workspaceId);
  const [removing, setRemoving] = useState<Member | null>(null);

  const editable = (member: Member) =>
    canManage && member.user_id !== me?.user.id && (member.role !== "owner" || role === "owner");

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Joined</TableHead>
            {canManage ? (
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => (
            <TableRow key={member.id}>
              <TableCell>
                <div className="flex items-center gap-2.5">
                  <Avatar name={member.name || member.email} seed={member.user_id} size={24} />
                  <div className="min-w-0">
                    <p className="truncate text-sm text-foreground">
                      {member.name || member.email}
                      {member.user_id === me?.user.id ? (
                        <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>
                      ) : null}
                    </p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {member.email}
                    </p>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                {editable(member) ? (
                  <RoleSelect
                    aria-label={`Role for ${member.name || member.email}`}
                    value={member.role}
                    allowed={allowed}
                    disabled={updateRole.isPending}
                    onValueChange={(next) =>
                      updateRole.mutate(
                        { memberId: member.id, role: next },
                        {
                          onSuccess: () =>
                            toast({
                              title: `${member.name || member.email} is now ${roleLabel(next).toLowerCase()}`,
                              tone: "success",
                            }),
                          onError: (error) =>
                            toast({
                              title: "Could not change role",
                              description: errorMessage(error),
                              tone: "error",
                            }),
                        },
                      )
                    }
                  />
                ) : (
                  <Badge tone={member.role === "owner" ? "accent" : "neutral"}>{member.role}</Badge>
                )}
              </TableCell>
              <TableCell className="font-mono text-xs text-muted-foreground">
                <span title={formatTimestamp(member.created_at)}>
                  {formatRelativeTime(member.created_at)}
                </span>
              </TableCell>
              {canManage ? (
                <TableCell className="text-right">
                  {editable(member) ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRemoving(member)}
                      aria-label={`Remove ${member.name || member.email}`}
                    >
                      Remove
                    </Button>
                  ) : null}
                </TableCell>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(null);
            remove.reset();
          }
        }}
        title={`Remove ${removing?.name || removing?.email || "member"}?`}
        description="They lose access to this workspace immediately. You can invite them again later."
        confirmLabel="Remove member"
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() => {
          if (!removing) return;
          remove.mutate(removing.id, {
            onSuccess: () => {
              toast({ title: `${removing.name || removing.email} removed`, tone: "success" });
              setRemoving(null);
            },
          });
        }}
      />
    </>
  );
}
