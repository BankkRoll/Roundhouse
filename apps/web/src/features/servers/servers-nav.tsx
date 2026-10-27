import { tabTriggerClasses } from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import { KEEP_FOCUS_ATTRIBUTE } from "../shell/focus";

/**
 * Sub-navigation of the Servers area: the fleet overview and the private network
 * between servers. Tabs are routes, so each view has its own URL.
 *
 * @param props - Workspace id.
 * @returns The tab bar.
 */
export function ServersNav({ workspaceId }: { workspaceId: string }) {
  return (
    <nav
      aria-label="Servers"
      className="mb-6 flex gap-4 overflow-x-auto border-b border-border [scrollbar-width:none] sm:gap-5 lg:mb-8"
      {...{ [KEEP_FOCUS_ATTRIBUTE]: "" }}
    >
      <Link
        to="/w/$workspaceId/servers"
        params={{ workspaceId }}
        className={tabTriggerClasses}
        activeOptions={{ exact: true, includeSearch: false }}
      >
        Overview
      </Link>
      <Link
        to="/w/$workspaceId/servers/network"
        params={{ workspaceId }}
        className={tabTriggerClasses}
        activeOptions={{ includeSearch: false }}
      >
        Network
      </Link>
    </nav>
  );
}
