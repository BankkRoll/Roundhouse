import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  KbdHint,
} from "@openrail/ui";
import { useMatches } from "@tanstack/react-router";
import { BellIcon, MenuIcon, SearchIcon } from "lucide-react";
import { isApplePlatform } from "../../lib/platform";
import { useMembership } from "../../queries/me";

/**
 * Top bar: breadcrumbs, command palette trigger and notifications.
 *
 * @param props - Workspace id and handlers for the palette and mobile menu.
 * @returns The top bar.
 */
export function TopBar({
  workspaceId,
  onOpenPalette,
  onOpenMenu,
}: {
  workspaceId: string;
  onOpenPalette: () => void;
  onOpenMenu: () => void;
}) {
  const workspace = useMembership(workspaceId);
  const title = useMatches({
    select: (matches) =>
      [...matches].reverse().find((match) => match.staticData.title)?.staticData.title,
  });

  return (
    <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur md:px-6">
      <Button
        variant="ghost"
        size="icon-sm"
        className="md:hidden"
        onClick={onOpenMenu}
        aria-label="Open navigation"
      >
        <MenuIcon />
      </Button>
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex items-center gap-1.5 text-sm">
          <li className="truncate text-muted-foreground">{workspace?.name ?? "Workspace"}</li>
          {title ? (
            <>
              <li aria-hidden="true" className="text-subtle-foreground">
                /
              </li>
              <li className="truncate font-medium text-foreground" aria-current="page">
                {title}
              </li>
            </>
          ) : null}
        </ol>
      </nav>
      <button
        type="button"
        onClick={onOpenPalette}
        className="hidden h-8 w-72 items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-sm text-subtle-foreground outline-none transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring sm:flex"
      >
        <SearchIcon className="size-3.5" aria-hidden="true" />
        <span className="flex-1 text-left">Search or run a command</span>
        <KbdHint keys={[isApplePlatform() ? "⌘" : "Ctrl", "K"]} />
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="sm:hidden"
        onClick={onOpenPalette}
        aria-label="Search or run a command"
      >
        <SearchIcon />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Notifications">
            <BellIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Notifications</DropdownMenuLabel>
          <p className="px-2 pb-3 text-sm text-muted-foreground">You are all caught up.</p>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
