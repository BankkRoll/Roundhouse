import {
  Avatar,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  KbdHint,
} from "@openrail/ui";
import { Link, useRouterState } from "@tanstack/react-router";
import { LogOutIcon, MoonIcon, SunIcon } from "lucide-react";
import { Brand } from "../../components/brand";
import { useTheme } from "../../lib/use-theme";
import { useMe, useSignOut } from "../../queries/me";
import { activeNavId, NAV_ITEMS } from "./nav";
import { ProjectsNav } from "./projects-nav";
import { WorkspaceSwitcher } from "./workspace-switcher";

/**
 * Left navigation: brand, workspace switcher, sections, projects and the user block.
 *
 * @param props - Current workspace and an optional callback when a link is followed
 *   (used to close the mobile drawer).
 * @returns The sidebar contents.
 */
export function Sidebar({
  workspaceId,
  onNavigate,
}: {
  workspaceId: string;
  onNavigate?: () => void;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = activeNavId(pathname);

  return (
    <div className="flex h-full flex-col gap-5 px-3 py-4">
      <div className="px-1.5">
        <Brand />
      </div>
      <WorkspaceSwitcher workspaceId={workspaceId} />
      <nav aria-label="Main">
        <ul className="grid gap-0.5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = active === item.id;
            return (
              <li key={item.id}>
                <Link
                  to={item.to}
                  params={{ workspaceId }}
                  onClick={onNavigate}
                  // NOTE: Link marks itself current on any descendant route, which would
                  // keep Home (the workspace root) current everywhere.
                  activeOptions={{ exact: item.id === "home" }}
                  aria-current={isActive ? "page" : undefined}
                  data-active={isActive || undefined}
                  className={cn(
                    "flex h-8 items-center gap-2.5 rounded-md border border-transparent px-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                    isActive && "border-accent-text bg-accent-subtle text-foreground",
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="flex-1">{item.label}</span>
                  {item.shortcut ? <KbdHint keys={["G", item.shortcut.toUpperCase()]} /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <ProjectsNav workspaceId={workspaceId} onNavigate={onNavigate} />
      <div className="mt-auto">
        <UserBlock />
      </div>
    </div>
  );
}

function UserBlock() {
  const { data: me } = useMe();
  const signOut = useSignOut();
  const theme = useTheme();
  const name = me?.user.name || me?.user.email || "Account";

  return (
    <div className="flex items-center gap-1 border-t border-border pt-3">
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Account menu for ${name}`}
        >
          <Avatar name={name} seed={me?.user.id ?? name} size={24} />
          <span className="truncate text-sm text-foreground">{name}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-56">
          <DropdownMenuLabel className="normal-case tracking-normal">
            <span className="block truncate font-sans text-xs text-foreground">
              {me?.user.name}
            </span>
            <span className="block truncate">{me?.user.email}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => signOut.mutate()}>
            <LogOutIcon />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={theme.toggle}
        aria-label={theme.resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      >
        {theme.resolved === "dark" ? <SunIcon /> : <MoonIcon />}
      </Button>
    </div>
  );
}
