import {
  Avatar,
  cn,
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
export function WorkspaceSwitcher({
  workspaceId,
  compact = false,
}: {
  workspaceId: string;
  /** In the icon rail (768-1279px) only the avatar shows; the name stays accessible. */
  compact?: boolean;
}) {
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
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
            compact && "justify-center xl:justify-start",
          )}
        >
          <Avatar name={name} seed={workspaceId} shape="square" size={26} />
          <span className={cn("min-w-0 flex-1", compact && "sr-only xl:not-sr-only")}>
            <span className="block truncate text-sm font-medium text-foreground">{name}</span>{" "}
            <span className="block truncate text-xs text-muted-foreground">{detail}</span>
            {/* NOTE: Named by its content rather than aria-label, so the name contains the
                visible text (WCAG 2.5.3) without counting the avatar initials. */}
            <span className="sr-only">, switch workspace</span>
          </span>
          <ChevronsUpDownIcon
            className={cn("size-3.5 text-muted-foreground", compact && "hidden xl:block")}
            aria-hidden="true"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-(--radix-dropdown-menu-trigger-width) min-w-60"
        >
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
