import {
  CommandPalette,
  Dialog,
  DialogTitle,
  isOverlayOpen,
  SheetContent,
  useCommandPaletteHotkey,
} from "@openrail/ui";
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePermissions } from "../../lib/permissions";
import { useTheme } from "../../lib/use-theme";
import { useSignOut } from "../../queries/me";
import { InviteMemberDialog } from "../members/invite-member-dialog";
import { AddServerDialog } from "../servers/add-server-dialog";
import { buildCommands } from "./commands";
import type { NavPath } from "./nav";
import { type ShellActions, ShellActionsContext } from "./shell-actions";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";
import { useGoShortcuts } from "./use-go-shortcuts";

/**
 * Moves focus to `target` after client-side navigation, so screen readers announce the
 * new page instead of staying on the link that was followed. Skips the first render.
 *
 * @param target - Element to focus, usually `<main>`.
 */
function useFocusOnNavigation(target: RefObject<HTMLElement | null>): void {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    target.current?.focus({ preventScroll: true });
  }, [pathname, target]);
}

/**
 * Authenticated layout for a workspace: sidebar, top bar, page outlet, command palette,
 * keyboard shortcuts, and the shell-owned dialogs (add server, invite member).
 *
 * @param props - The workspace from the URL.
 * @returns The shell.
 */
export function AppShell({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const permissions = usePermissions(workspaceId);
  const theme = useTheme();
  const signOut = useSignOut();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [addServerOpen, setAddServerOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const main = useRef<HTMLElement>(null);

  const go = useCallback(
    (to: NavPath) => void navigate({ to, params: { workspaceId } }),
    [navigate, workspaceId],
  );

  useGoShortcuts(go);
  useFocusOnNavigation(main);
  useCommandPaletteHotkey(() => {
    // NOTE: Read before toggling, because an open palette is itself an overlay.
    const blocked = isOverlayOpen();
    setPaletteOpen((open) => (open ? false : !blocked));
  });

  const actions = useMemo<ShellActions>(
    () => ({
      openAddServer: () => setAddServerOpen(true),
      openInviteMember: () => setInviteOpen(true),
    }),
    [],
  );

  const commands = buildCommands({
    navigate: go,
    can: permissions.can,
    openAddServer: actions.openAddServer,
    openInviteMember: actions.openInviteMember,
    toggleTheme: theme.toggle,
    signOut: () => signOut.mutate(),
    openLanding: () => void navigate({ to: "/" }),
  });

  return (
    <ShellActionsContext.Provider value={actions}>
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-surface-raised px-3 py-2 text-sm text-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <div className="flex min-h-dvh bg-background">
        <aside className="sticky top-0 hidden h-dvh w-[230px] shrink-0 border-r border-border md:block">
          <Sidebar workspaceId={workspaceId} />
        </aside>
        <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
          <SheetContent>
            <DialogTitle className="sr-only">Navigation</DialogTitle>
            <Sidebar workspaceId={workspaceId} onNavigate={() => setMenuOpen(false)} />
          </SheetContent>
        </Dialog>
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar
            workspaceId={workspaceId}
            onOpenPalette={() => setPaletteOpen(true)}
            onOpenMenu={() => setMenuOpen(true)}
          />
          <main
            id="main"
            ref={main}
            tabIndex={-1}
            className="mx-auto w-full max-w-[1260px] flex-1 px-4 py-8 outline-none md:px-8"
          >
            <Outlet />
          </main>
        </div>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
      <AddServerDialog
        workspaceId={workspaceId}
        open={addServerOpen}
        onOpenChange={setAddServerOpen}
      />
      <InviteMemberDialog
        workspaceId={workspaceId}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
      />
    </ShellActionsContext.Provider>
  );
}
