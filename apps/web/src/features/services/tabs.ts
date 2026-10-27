/**
 * The service page's tabs, shared by the tab bar, the command palette and the
 * "G then <key>" shortcuts.
 *
 * @module
 */
import type { Action } from "@roundhouse/shared";

/** A service tab id. */
export type ServiceTab =
  | "deployments"
  | "logs"
  | "metrics"
  | "data"
  | "backups"
  | "variables"
  | "settings"
  | "domains"
  | "runs";

/** Route of each service tab. */
export const SERVICE_TAB_PATHS = {
  deployments: "/w/$workspaceId/p/$projectId/s/$serviceId/deployments",
  logs: "/w/$workspaceId/p/$projectId/s/$serviceId/logs",
  metrics: "/w/$workspaceId/p/$projectId/s/$serviceId/metrics",
  data: "/w/$workspaceId/p/$projectId/s/$serviceId/data",
  backups: "/w/$workspaceId/p/$projectId/s/$serviceId/backups",
  variables: "/w/$workspaceId/p/$projectId/s/$serviceId/variables",
  settings: "/w/$workspaceId/p/$projectId/s/$serviceId/settings",
  domains: "/w/$workspaceId/p/$projectId/s/$serviceId/domains",
  runs: "/w/$workspaceId/p/$projectId/s/$serviceId/runs",
} as const satisfies Record<ServiceTab, string>;

/** Tabs of an app service, in display order, with their labels. */
export const SERVICE_TABS: readonly { id: ServiceTab; label: string }[] = [
  { id: "deployments", label: "Deployments" },
  { id: "logs", label: "Logs" },
  { id: "metrics", label: "Metrics" },
  { id: "variables", label: "Variables" },
  { id: "settings", label: "Settings" },
  { id: "domains", label: "Domains" },
];

/**
 * The tabs a service shows. A database service adds Data (for callers with
 * `data:read`) and Backups, and drops Domains: it listens on the private network only.
 * A cron service leads with Runs and drops Metrics and Domains: it serves no traffic.
 *
 * @param service - The service; `database` is set for database services.
 * @param can - The caller's permission check.
 * @returns Tabs in display order.
 * @example
 * serviceTabs({ database: { engine: "postgres", version: "18" } }, () => true).map((t) => t.id);
 * // ["deployments", "logs", "metrics", "data", "backups", "variables", "settings"]
 */
export function serviceTabs(
  service: { database?: unknown; kind?: string } | undefined,
  can: (action: Action) => boolean,
): readonly { id: ServiceTab; label: string }[] {
  if (service?.kind === "cron") {
    return [
      { id: "runs", label: "Runs" },
      { id: "deployments", label: "Deployments" },
      { id: "logs", label: "Logs" },
      { id: "variables", label: "Variables" },
      { id: "settings", label: "Settings" },
    ];
  }
  if (!service?.database) return SERVICE_TABS;
  return [
    { id: "deployments", label: "Deployments" },
    { id: "logs", label: "Logs" },
    { id: "metrics", label: "Metrics" },
    ...(can("data:read") ? [{ id: "data" as const, label: "Data" }] : []),
    { id: "backups", label: "Backups" },
    { id: "variables", label: "Variables" },
    { id: "settings", label: "Settings" },
  ];
}

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
