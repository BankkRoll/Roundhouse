import { cn, tabTriggerClasses } from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import { canManageInstance, usePermissions } from "../../lib/permissions";
import { useMe } from "../../queries/me";
import { KEEP_FOCUS_ATTRIBUTE } from "../shell/focus";

/**
 * Sub-navigation shared by the General, Members, Audit log and Platform settings pages.
 *
 * @param props - Workspace id.
 * @returns The tab bar.
 */
export function SettingsTabs({ workspaceId }: { workspaceId: string }) {
  const { can } = usePermissions(workspaceId);
  const { data: me } = useMe();
  const tabs = [
    { to: "/w/$workspaceId/settings", label: "General", show: true },
    { to: "/w/$workspaceId/members", label: "Members", show: can("members:read") },
    { to: "/w/$workspaceId/audit", label: "Audit log", show: can("audit:read") },
    {
      to: "/w/$workspaceId/platform",
      label: "Platform",
      show: canManageInstance(me) || can("projects:manage"),
    },
  ] as const;
  return (
    <nav
      aria-label="Settings"
      className="mb-6 flex gap-5 border-b border-border"
      {...{ [KEEP_FOCUS_ATTRIBUTE]: "" }}
    >
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
