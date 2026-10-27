/**
 * Sidebar navigation model, shared by the sidebar, the G-key shortcuts and the command
 * palette so the three never drift apart.
 *
 * @module
 */
import {
  GaugeIcon,
  HouseIcon,
  LayoutTemplateIcon,
  type LucideIcon,
  ScrollTextIcon,
  ServerIcon,
  SettingsIcon,
  WorkflowIcon,
} from "lucide-react";

/** Route a nav item links to. Every path is relative to a workspace. */
export type NavPath =
  | "/w/$workspaceId"
  | "/w/$workspaceId/canvas"
  | "/w/$workspaceId/servers"
  | "/w/$workspaceId/logs"
  | "/w/$workspaceId/templates"
  | "/w/$workspaceId/usage"
  | "/w/$workspaceId/settings"
  | "/w/$workspaceId/members"
  | "/w/$workspaceId/audit"
  | "/w/$workspaceId/platform"
  | "/w/$workspaceId/preferences"
  | "/w/$workspaceId/preferences/shortcuts";

/** One sidebar entry. */
export interface NavItem {
  id: string;
  label: string;
  to: NavPath;
  icon: LucideIcon;
  /** "G then <key>" shortcut, lowercase. */
  shortcut?: string;
  /**
   * URL segments (after `/w/<id>`) that highlight this item. Empty string is the
   * workspace home.
   */
  segments: readonly string[];
}

/** Sidebar entries in display order. */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: "home",
    label: "Home",
    to: "/w/$workspaceId",
    icon: HouseIcon,
    shortcut: "h",
    segments: [""],
  },
  {
    id: "canvas",
    label: "Canvas",
    to: "/w/$workspaceId/canvas",
    icon: WorkflowIcon,
    shortcut: "c",
    segments: ["canvas"],
  },
  {
    id: "servers",
    label: "Servers",
    to: "/w/$workspaceId/servers",
    icon: ServerIcon,
    shortcut: "s",
    segments: ["servers"],
  },
  {
    id: "logs",
    label: "Logs",
    to: "/w/$workspaceId/logs",
    icon: ScrollTextIcon,
    shortcut: "l",
    segments: ["logs"],
  },
  {
    id: "templates",
    label: "Templates",
    to: "/w/$workspaceId/templates",
    icon: LayoutTemplateIcon,
    shortcut: "t",
    segments: ["templates"],
  },
  {
    id: "usage",
    label: "Usage",
    to: "/w/$workspaceId/usage",
    icon: GaugeIcon,
    shortcut: "u",
    segments: ["usage"],
  },
  {
    id: "settings",
    label: "Settings",
    to: "/w/$workspaceId/settings",
    icon: SettingsIcon,
    segments: ["settings", "members", "audit", "tokens", "platform", "domains-tls", "preferences"],
  },
];

/**
 * Finds the nav item that owns a pathname.
 *
 * @param pathname - Current URL path, e.g. `/w/ws_1/servers/node_2`.
 * @returns The active item's id, or `undefined` outside a workspace.
 */
export function activeNavId(pathname: string): string | undefined {
  const match = /^\/w\/[^/]+\/?([^/]*)/.exec(pathname);
  if (!match) return undefined;
  const segment = match[1] ?? "";
  return NAV_ITEMS.find((item) => item.segments.includes(segment))?.id;
}
