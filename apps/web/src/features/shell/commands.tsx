import type { Action } from "@openrail/shared";
import type { PaletteCommand } from "@openrail/ui";
import {
  GlobeIcon,
  HistoryIcon,
  LogOutIcon,
  ServerIcon,
  SunMoonIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import { NAV_ITEMS, type NavPath } from "./nav";

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
  /** Opens the public landing page. Omitted where the shell has no router. */
  openLanding?: () => void;
}

/**
 * Builds the command palette entries for the current user. Actions the caller's role
 * cannot perform are omitted rather than shown disabled.
 *
 * @param deps - Navigation, permission check and action callbacks.
 * @returns Commands grouped under "Navigation", "Actions" and "Account".
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

  const actions: PaletteCommand[] = [];
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

  const prototype: PaletteCommand[] = deps.openLanding
    ? [
        {
          id: "prototype:landing",
          label: "Open landing page",
          group: "Prototype",
          icon: <GlobeIcon />,
          keywords: ["marketing", "homepage", "website", "public"],
          onSelect: deps.openLanding,
        },
      ]
    : [];

  return [...navigation, ...actions, ...prototype, ...account];
}
