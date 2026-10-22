import { cn, tabTriggerClasses } from "@openrail/ui";
import { Link } from "@tanstack/react-router";
import { usePermissions } from "../../lib/permissions";

/**
 * Sub-navigation shared by the General, Members and Audit log settings pages.
 *
 * @param props - Workspace id.
 * @returns The tab bar.
 */
export function SettingsTabs({ workspaceId }: { workspaceId: string }) {
  const { can } = usePermissions(workspaceId);
  const tabs = [
    { to: "/w/$workspaceId/settings", label: "General", show: true },
    { to: "/w/$workspaceId/members", label: "Members", show: can("members:read") },
    { to: "/w/$workspaceId/audit", label: "Audit log", show: can("audit:read") },
  ] as const;
  return (
    <nav aria-label="Settings" className="mb-6 flex gap-5 border-b border-border">
      {tabs
        .filter((tab) => tab.show)
        .map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            params={{ workspaceId }}
            className={cn(tabTriggerClasses)}
            activeOptions={{ exact: true }}
          >
            {tab.label}
          </Link>
        ))}
    </nav>
  );
}
