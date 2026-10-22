import type { Action } from "@openrail/shared";
import type { PaletteCommand } from "@openrail/ui";
import {
  BoxIcon,
  FolderKanbanIcon,
  FolderPlusIcon,
  HistoryIcon,
  LogOutIcon,
  PlusIcon,
  RocketIcon,
  ScrollTextIcon,
  ServerIcon,
  SettingsIcon,
  SunMoonIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import { NAV_ITEMS, type NavPath } from "./nav";

/** A project as the palette needs it. */
export interface PaletteProject {
  id: string;
  name: string;
}

/** The project whose page is open, with its services. */
export interface PaletteProjectContext extends PaletteProject {
  services: readonly { id: string; name: string }[];
}

/** Everything {@link buildCommands} needs from the running app. */
export interface CommandDeps {
  /** Navigates to a workspace page. */
  navigate: (to: NavPath) => void;
  /** Permission check for the caller's role in the current workspace. */
  can: (action: Action) => boolean;
  /** Opens the add-server dialog. */
  openAddServer: () => void;
  /** Opens the invite-member dialog. */
  openInviteMember: () => void;
  /** Flips between the dark and light themes. */
  toggleTheme: () => void;
  /** Signs out and goes to the sign-in page. */
  signOut: () => void;
  /** Opens the instance (platform) settings; only passed to callers who may manage them. */
  openPlatform?: () => void;
  /** The workspace's projects, for "Open project" commands. */
  projects?: readonly PaletteProject[];
  /** The project currently open, if any, for service commands. */
  project?: PaletteProjectContext;
  /** Opens the new-project dialog. */
  openNewProject?: () => void;
  /** Opens a project's page. */
  openProject?: (projectId: string) => void;
  /** Opens the new-service flow for a project. */
  openNewService?: (projectId: string) => void;
  /** Opens a service's page. */
  openService?: (projectId: string, serviceId: string) => void;
  /** Deploys a service's latest config to the project's current environment. */
  deployService?: (projectId: string, serviceId: string) => void;
  /** Opens a service's live logs. */
  openLogs?: (projectId: string, serviceId: string) => void;
}

function projectCommands(deps: CommandDeps): PaletteCommand[] {
  const commands: PaletteCommand[] = (deps.projects ?? []).map((project) => ({
    id: `project:${project.id}`,
    label: `Open project ${project.name}`,
    group: "Projects",
    icon: <FolderKanbanIcon />,
    keywords: [project.name, "project"],
    onSelect: () => deps.openProject?.(project.id),
  }));
  const project = deps.project;
  if (!project) return commands;
  for (const service of project.services) {
    commands.push({
      id: `service:${service.id}`,
      label: `Go to ${service.name}`,
      group: project.name,
      icon: <BoxIcon />,
      keywords: ["service", project.name],
      onSelect: () => deps.openService?.(project.id, service.id),
    });
    if (deps.deployService && deps.can("deployments:create")) {
      commands.push({
        id: `deploy:${service.id}`,
        label: `Deploy ${service.name}`,
        group: project.name,
        icon: <RocketIcon />,
        keywords: ["release", "ship", "redeploy", "build"],
        onSelect: () => deps.deployService?.(project.id, service.id),
      });
    }
    commands.push({
      id: `logs:${service.id}`,
      label: `Open logs · ${service.name}`,
      group: project.name,
      icon: <ScrollTextIcon />,
      keywords: ["tail", "output", "stdout", "stderr", service.name],
      onSelect: () => deps.openLogs?.(project.id, service.id),
    });
  }
  if (deps.openNewService && deps.can("services:manage")) {
    commands.push({
      id: `new-service:${project.id}`,
      label: "New service",
      group: project.name,
      icon: <PlusIcon />,
      keywords: ["add", "docker", "image", "github", "repo", "app"],
      onSelect: () => deps.openNewService?.(project.id),
    });
  }
  return commands;
}

/**
 * Builds the command palette entries for the current user. Actions the caller's role
 * cannot perform are omitted rather than shown disabled.
 *
 * @param deps - Navigation, permission check, context and action callbacks.
 * @returns Commands grouped under "Navigation", the open project, "Projects", "Actions"
 *   and "Account".
 */
export function buildCommands(deps: CommandDeps): PaletteCommand[] {
  const navigation: PaletteCommand[] = NAV_ITEMS.map((item) => {
    const Icon = item.icon;
    return {
      id: `nav:${item.id}`,
      label: `Go to ${item.label}`,
      group: "Navigation",
      icon: <Icon />,
      hint: item.shortcut ? ["G", item.shortcut.toUpperCase()] : undefined,
      onSelect: () => deps.navigate(item.to),
    };
  });
  if (deps.can("members:read")) {
    navigation.push({
      id: "nav:members",
      label: "Go to Members",
      group: "Navigation",
      icon: <UsersIcon />,
      keywords: ["team", "people", "roles"],
      onSelect: () => deps.navigate("/w/$workspaceId/members"),
    });
  }
  if (deps.can("audit:read")) {
    navigation.push({
      id: "nav:audit",
      label: "Go to Audit log",
      group: "Navigation",
      icon: <HistoryIcon />,
      keywords: ["history", "events", "activity"],
      onSelect: () => deps.navigate("/w/$workspaceId/audit"),
    });
  }
  if (deps.openPlatform) {
    navigation.push({
      id: "nav:platform",
      label: "Go to Platform settings",
      group: "Navigation",
      icon: <SettingsIcon />,
      keywords: ["instance", "domain", "tls", "github", "app"],
      onSelect: deps.openPlatform,
    });
  }

  const actions: PaletteCommand[] = [];
  if (deps.openNewProject && deps.can("projects:manage")) {
    actions.push({
      id: "action:new-project",
      label: "New project",
      group: "Actions",
      icon: <FolderPlusIcon />,
      keywords: ["create", "app"],
      onSelect: deps.openNewProject,
    });
  }
  if (deps.can("nodes:manage")) {
    actions.push({
      id: "action:add-server",
      label: "Add server",
      group: "Actions",
      icon: <ServerIcon />,
      keywords: ["node", "machine", "install", "agent"],
      onSelect: deps.openAddServer,
    });
  }
  if (deps.can("members:manage")) {
    actions.push({
      id: "action:invite",
      label: "Invite member",
      group: "Actions",
      icon: <UserPlusIcon />,
      keywords: ["teammate", "user", "email"],
      onSelect: deps.openInviteMember,
    });
  }
  actions.push({
    id: "action:theme",
    label: "Toggle theme",
    group: "Actions",
    icon: <SunMoonIcon />,
    keywords: ["dark", "light", "appearance"],
    onSelect: deps.toggleTheme,
  });

  const account: PaletteCommand[] = [
    {
      id: "account:sign-out",
      label: "Sign out",
      group: "Account",
      icon: <LogOutIcon />,
      keywords: ["log out", "logout"],
      onSelect: deps.signOut,
    },
  ];

  const projects = projectCommands(deps);
  const current = deps.project ? projects.filter((c) => c.group === deps.project?.name) : [];
  const others = projects.filter((c) => !current.includes(c));
  return [...current, ...navigation, ...others, ...actions, ...account];
}
