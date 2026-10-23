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
  Tooltip,
} from "@openrail/ui";
import { Link, useRouterState } from "@tanstack/react-router";
import { KeyboardIcon, LogOutIcon, MoonIcon, SlidersHorizontalIcon, SunIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Brand, LogoMark } from "../../components/brand";
import { useTheme } from "../../lib/use-theme";
import { useMe, useSignOut } from "../../queries/me";
import { activeNavId, NAV_ITEMS, type NavItem } from "./nav";
import { ProjectsNav } from "./projects-nav";
import { WorkspaceSwitcher } from "./workspace-switcher";

/**
 * How the sidebar draws itself. `responsive` is the desktop sidebar: an icon rail from
 * 768px and full labels from 1280px. `full` always shows labels (the mobile drawer).
 */
export type SidebarVariant = "responsive" | "full";

/** Hides an element in the icon rail; it shows again once the sidebar has labels. */
const railHidden = (variant: SidebarVariant) => (variant === "responsive" ? "hidden xl:flex" : "");

/** Visually hides a label in the icon rail while keeping it as the accessible name. */
const railLabel = (variant: SidebarVariant) =>
  variant === "responsive" ? "sr-only xl:not-sr-only" : "";

/** In the rail every icon gets a tooltip with its label; with labels shown it needs none. */
function RailTip({
  variant,
  label,
  children,
}: {
  variant: SidebarVariant;
  label: string;
  children: ReactNode;
}) {
  if (variant === "full") return <>{children}</>;
  return (
    <Tooltip content={label} side="right" className="xl:hidden">
      {children}
    </Tooltip>
  );
}

function NavLink({
  item,
  workspaceId,
  active,
  variant,
  onNavigate,
}: {
  item: NavItem;
  workspaceId: string;
  active: boolean;
  variant: SidebarVariant;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  return (
    <li>
      <RailTip variant={variant} label={item.label}>
        <Link
          to={item.to}
          params={{ workspaceId }}
          onClick={onNavigate}
          // NOTE: Link marks itself current on any descendant route, which would keep Home
          // (the workspace root) current everywhere.
          activeOptions={{ exact: item.id === "home" }}
          aria-current={active ? "page" : undefined}
          data-active={active || undefined}
          className={cn(
            "group flex h-8 items-center gap-2.5 rounded-md px-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            variant === "responsive" && "justify-center xl:justify-start",
            active && "bg-muted text-foreground",
          )}
        >
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          <span className={cn("flex-1", railLabel(variant))}>{item.label}</span>
          {item.shortcut ? (
            <KbdHint
              keys={["G", item.shortcut.toUpperCase()]}
              className={cn(
                "opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
                railHidden(variant),
              )}
            />
          ) : null}
        </Link>
      </RailTip>
    </li>
  );
}

/**
 * Left navigation: product mark, workspace switcher, the workspace's sections, its
 * projects and the user menu. As an icon rail (768-1279px) it keeps the mark,
 * the icons with tooltips and the user's avatar; projects show again with labels.
 *
 * @param props - Current workspace, the variant, and a callback when a link is followed
 *   (closes the mobile drawer).
 * @returns The sidebar contents.
 */
export function Sidebar({
  workspaceId,
  variant = "full",
  onNavigate,
}: {
  workspaceId: string;
  variant?: SidebarVariant;
  onNavigate?: () => void;
}) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const active = activeNavId(pathname);
  const rail = variant === "responsive";

  return (
    <div className={cn("flex h-full flex-col gap-4 py-3", rail ? "px-2 xl:px-3" : "px-3")}>
      <div
        className={cn("flex h-8 items-center px-1.5", rail && "justify-center xl:justify-start")}
      >
        {rail ? (
          <>
            <span className="xl:hidden">
              <LogoMark />
            </span>
            <span className="hidden xl:block">
              <Brand />
            </span>
          </>
        ) : (
          <Brand />
        )}
      </div>
      <WorkspaceSwitcher workspaceId={workspaceId} compact={rail} />
      <nav aria-label="Main">
        <ul className="grid gap-0.5">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.id}
              item={item}
              workspaceId={workspaceId}
              active={active === item.id}
              variant={variant}
              onNavigate={onNavigate}
            />
          ))}
        </ul>
      </nav>
      <div className={cn("min-h-0 flex-1", rail && "hidden xl:block")}>
        <ProjectsNav workspaceId={workspaceId} onNavigate={onNavigate} />
      </div>
      {rail ? <div className="flex-1 xl:hidden" /> : null}
      <UserBlock workspaceId={workspaceId} variant={variant} onNavigate={onNavigate} />
    </div>
  );
}

function UserBlock({
  workspaceId,
  variant,
  onNavigate,
}: {
  workspaceId: string;
  variant: SidebarVariant;
  onNavigate?: () => void;
}) {
  const { data: me } = useMe();
  const signOut = useSignOut();
  const theme = useTheme();
  const name = me?.user.name || me?.user.email || "Account";
  const rail = variant === "responsive";

  return (
    <div
      className={cn(
        "flex items-center gap-1 border-t border-border pt-3",
        rail && "flex-col xl:flex-row",
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
            rail && "justify-center xl:justify-start",
          )}
        >
          <Avatar name={name} seed={me?.user.id ?? name} size={24} />
          <span className={cn("truncate text-sm text-foreground", railLabel(variant))}>{name}</span>
          {/* NOTE: Named by its content, not aria-label; see the workspace switcher. */}
          <span className="sr-only">, account menu</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-60">
          <DropdownMenuLabel className="font-normal">
            <span className="block truncate text-sm text-foreground">{me?.user.name}</span>
            <span className="block truncate text-xs">{me?.user.email}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to="/w/$workspaceId/preferences" params={{ workspaceId }} onClick={onNavigate}>
              <SlidersHorizontalIcon />
              Preferences
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link
              to="/w/$workspaceId/preferences/shortcuts"
              params={{ workspaceId }}
              onClick={onNavigate}
            >
              <KeyboardIcon />
              Keyboard shortcuts
            </Link>
          </DropdownMenuItem>
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
