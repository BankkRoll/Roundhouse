/**
 * The service page's tabs, shared by the tab bar, the command palette and the
 * "G then <key>" shortcuts.
 *
 * @module
 */

/** A service tab id. */
export type ServiceTab = "deployments" | "logs" | "variables" | "settings" | "domains";

/** Route of each service tab. */
export const SERVICE_TAB_PATHS = {
  deployments: "/w/$workspaceId/p/$projectId/s/$serviceId/deployments",
  logs: "/w/$workspaceId/p/$projectId/s/$serviceId/logs",
  variables: "/w/$workspaceId/p/$projectId/s/$serviceId/variables",
  settings: "/w/$workspaceId/p/$projectId/s/$serviceId/settings",
  domains: "/w/$workspaceId/p/$projectId/s/$serviceId/domains",
} as const satisfies Record<ServiceTab, string>;

/** Tabs in display order, with their labels. */
export const SERVICE_TABS: readonly { id: ServiceTab; label: string }[] = [
  { id: "deployments", label: "Deployments" },
  { id: "logs", label: "Logs" },
  { id: "variables", label: "Variables" },
  { id: "settings", label: "Settings" },
  { id: "domains", label: "Domains" },
];

/**
 * "G then <key>" shortcuts that exist only on a service's pages, opening its tabs. They
 * take precedence over the workspace shortcut with the same key (G L opens the service's
 * logs, not the workspace Logs page).
 */
export const SERVICE_SHORTCUTS: readonly { key: string; tab: ServiceTab; label: string }[] = [
  { key: "d", tab: "deployments", label: "Deployments" },
  { key: "l", tab: "logs", label: "Logs" },
  { key: "v", tab: "variables", label: "Variables" },
];
