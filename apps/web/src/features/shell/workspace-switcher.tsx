import {
  Avatar,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@roundhouse/ui";
import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDownIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { canCreateWorkspace, usePermissions } from "../../lib/permissions";
import { useMe } from "../../queries/me";
import { useMembers } from "../../queries/members";
import { CreateWorkspaceDialog } from "./create-workspace-dialog";

/**
 * Sidebar card showing the current workspace with a menu to switch workspaces, and to
 * create one for owners and admins (the only people the API lets create workspaces).
 *
 * @param props - The current workspace id.
 * @returns The switcher.
 */
export function WorkspaceSwitcher({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const { data: me } = useMe();
  const permissions = usePermissions(workspaceId);
  const members = useMembers(workspaceId, permissions.can("members:read"));
  const [creating, setCreating] = useState(false);

  const current = me?.workspaces.find((workspace) => workspace.id === workspaceId);
  const name = current?.name ?? "Workspace";
  const count = members.data?.length;
  const detail =
    count !== undefined ? `${count} ${count === 1 ? "member" : "members"}` : (current?.role ?? "");

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface px-2.5 py-2 text-left outline-none transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Workspace: ${name}. Switch workspace`}
        >
          <Avatar name={name} seed={workspaceId} shape="square" size={26} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground">{name}</span>
            <span className="block truncate font-mono text-[10px] text-muted-foreground">
              {detail}
            </span>
          </span>
          <ChevronsUpDownIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={workspaceId}
            onValueChange={(id) =>
              void navigate({ to: "/w/$workspaceId", params: { workspaceId: id } })
            }
          >
            {me?.workspaces.map((workspace) => (
              <DropdownMenuRadioItem key={workspace.id} value={workspace.id}>
                <Avatar name={workspace.name} seed={workspace.id} shape="square" size={18} />
                <span className="truncate">{workspace.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {canCreateWorkspace(me) ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setCreating(true)}>
                <PlusIcon />
                New workspace
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateWorkspaceDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
