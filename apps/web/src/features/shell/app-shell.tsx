import {
  CommandPalette,
  Dialog,
  DialogTitle,
  isOverlayOpen,
  SheetContent,
  toast,
  useCommandPaletteHotkey,
} from "@roundhouse/ui";
import { useQuery } from "@tanstack/react-query";
import { Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import {
  lazy,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { errorMessage } from "../../lib/api/client";
import { canManageInstance, usePermissions } from "../../lib/permissions";
import { useTheme } from "../../lib/use-theme";
import { useDeploy } from "../../queries/deployments";
import { useMe, useSignOut } from "../../queries/me";
import { pickEnvironment, projectQueryOptions, useProjects } from "../../queries/projects";
import { InviteMemberDialog } from "../members/invite-member-dialog";
import { AddServerDialog } from "../servers/add-server-dialog";
import { SERVICE_TAB_PATHS, type ServiceTab } from "../services/tabs";
import { buildCommands } from "./commands";
import { KEEP_FOCUS_ATTRIBUTE } from "./focus";
import type { NavPath } from "./nav";
import { type ShellActions, ShellActionsContext } from "./shell-actions";
import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";
import { type ContextShortcut, useGoShortcuts } from "./use-go-shortcuts";

// PERF: The project dialogs (and the repository picker inside the service flow) are only
// needed once someone creates something, so they stay out of the shell chunk.
const NewProjectDialog = lazy(() =>
  import("../projects/new-project-dialog").then((module) => ({
    default: module.NewProjectDialog,
  })),
);
const NewServiceDialog = lazy(() =>
  import("../projects/new-service/new-service-dialog").then((module) => ({
    default: module.NewServiceDialog,
  })),
);

/**
 * Moves focus to `target` after client-side navigation, so screen readers announce the
 * new page instead of staying on the link that was followed. Skips the first render, and
 * navigation started from a tab bar, where focus must stay on the tab.
 *
 * @param target - Element to focus, usually `<main>`.
 */
function useFocusOnNavigation(target: RefObject<HTMLElement | null>): void {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    if (document.activeElement?.closest(`[${KEEP_FOCUS_ATTRIBUTE}]`)) return;
    target.current?.focus({ preventScroll: true });
  }, [pathname, target]);
}

/**
 * Authenticated layout for a workspace: sidebar, top bar, page outlet, command palette,
 * keyboard shortcuts, and the shell-owned dialogs (add server, invite member, new
 * project, new service).
 *
 * @param props - The workspace from the URL.
 * @returns The shell.
 */
export function AppShell({ workspaceId }: { workspaceId: string }) {
  const navigate = useNavigate();
  const permissions = usePermissions(workspaceId);
  const theme = useTheme();
  const signOut = useSignOut();
  const { data: me } = useMe();
  const deploy = useDeploy();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [addServerOpen, setAddServerOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [newServiceFor, setNewServiceFor] = useState<string | null>(null);
  const main = useRef<HTMLElement>(null);
  const { projectId, serviceId } = useParams({ strict: false }) as {
    projectId?: string;
    serviceId?: string;
  };
  const projects = useProjects(workspaceId, permissions.can("projects:read"));
  const project = useQuery({
    ...projectQueryOptions(projectId ?? ""),
    enabled: Boolean(projectId),
  });

  const go = useCallback(
    (to: NavPath) => void navigate({ to, params: { workspaceId } }),
    [navigate, workspaceId],
  );
  const openService = useCallback(
    (target: string, service: string, tab: ServiceTab = "deployments") =>
      void navigate({
        to: SERVICE_TAB_PATHS[tab],
        params: { workspaceId, projectId: target, serviceId: service },
      }),
    [navigate, workspaceId],
  );

  const shortcuts = useMemo<ContextShortcut[]>(() => {
    if (!projectId || !serviceId) return [];
    return [
      { key: "d", label: "Deployments", run: () => openService(projectId, serviceId) },
      { key: "l", label: "Logs", run: () => openService(projectId, serviceId, "logs") },
      { key: "v", label: "Variables", run: () => openService(projectId, serviceId, "variables") },
    ];
  }, [projectId, serviceId, openService]);
  useGoShortcuts(go, shortcuts);
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
      openNewProject: () => setNewProjectOpen(true),
      openNewService: (target) => setNewServiceFor(target),
    }),
    [],
  );

  function deployService(target: string, service: string) {
    const detail = project.data?.id === target ? project.data : undefined;
    const environment = detail ? pickEnvironment(detail.environments) : undefined;
    const name = detail?.services.find((entry) => entry.id === service)?.name ?? "service";
    if (!environment) return;
    deploy.mutate(
      { serviceId: service, environmentId: environment.id },
      {
        onSuccess: () => {
          toast({ title: `Deploying ${name}`, description: environment.name, tone: "success" });
          openService(target, service);
        },
        onError: (error) =>
          toast({
            title: `Could not deploy ${name}`,
            description: errorMessage(error),
            tone: "error",
          }),
      },
    );
  }

  const commands = buildCommands({
    navigate: go,
    can: permissions.can,
    openAddServer: actions.openAddServer,
    openInviteMember: actions.openInviteMember,
    toggleTheme: theme.toggle,
    signOut: () => signOut.mutate(),
    openPlatform: canManageInstance(me) ? () => go("/w/$workspaceId/platform") : undefined,
    projects: projects.data,
    project: project.data,
    openNewProject: actions.openNewProject,
    openProject: (target) =>
      void navigate({
        to: "/w/$workspaceId/p/$projectId",
        params: { workspaceId, projectId: target },
      }),
    openNewService: actions.openNewService,
    openService: (target, service) => openService(target, service),
    deployService,
    openLogs: (target, service) => openService(target, service, "logs"),
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
      <Suspense fallback={null}>
        {newProjectOpen ? (
          <NewProjectDialog
            workspaceId={workspaceId}
            open={newProjectOpen}
            onOpenChange={setNewProjectOpen}
          />
        ) : null}
        {newServiceFor ? (
          <NewServiceDialog
            workspaceId={workspaceId}
            projectId={newServiceFor}
            open
            onOpenChange={(open) => {
              if (!open) setNewServiceFor(null);
            }}
          />
        ) : null}
      </Suspense>
    </ShellActionsContext.Provider>
  );
}
