import { SettingsLayout, SettingsNav, SettingsNavGroup, SettingsNavItem } from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { canManageInstance, usePermissions } from "../../lib/permissions";
import { useMe } from "../../queries/me";
import { KEEP_FOCUS_ATTRIBUTE } from "../shell/focus";

/** A settings destination, relative to the workspace. */
type SettingsPath =
  | "/w/$workspaceId/settings"
  | "/w/$workspaceId/members"
  | "/w/$workspaceId/teams"
  | "/w/$workspaceId/audit"
  | "/w/$workspaceId/tokens"
  | "/w/$workspaceId/platform"
  | "/w/$workspaceId/domains-tls"
  | "/w/$workspaceId/instance-audit"
  | "/w/$workspaceId/mcp-clients"
  | "/w/$workspaceId/security"
  | "/w/$workspaceId/preferences"
  | "/w/$workspaceId/preferences/shortcuts"
  | "/w/$workspaceId/preferences/accessibility";

function Item({
  workspaceId,
  to,
  label,
  exact = true,
}: {
  workspaceId: string;
  to: SettingsPath;
  label: string;
  /** Off for items whose pages have children, like a team under Teams. */
  exact?: boolean;
}) {
  return (
    <SettingsNavItem asChild>
      <Link to={to} params={{ workspaceId }} activeOptions={{ exact }}>
        {label}
      </Link>
    </SettingsNavItem>
  );
}

/**
 * The settings sub-navigation: the workspace's own settings (each shown only to roles
 * that may open it), the instance-wide platform settings, the signed-in user's own
 * account settings, and this browser's preferences.
 *
 * @param props - Workspace id.
 * @returns The navigation.
 */
export function WorkspaceSettingsNav({ workspaceId }: { workspaceId: string }) {
  const { can } = usePermissions(workspaceId);
  const { data: me } = useMe();
  const platform = canManageInstance(me) || can("projects:manage");
  return (
    <SettingsNav label="Settings" {...{ [KEEP_FOCUS_ATTRIBUTE]: "" }}>
      <SettingsNavGroup label="Workspace">
        <Item workspaceId={workspaceId} to="/w/$workspaceId/settings" label="General" />
        {can("members:read") ? (
          <Item workspaceId={workspaceId} to="/w/$workspaceId/members" label="Members" />
        ) : null}
        {can("members:read") ? (
          <Item workspaceId={workspaceId} to="/w/$workspaceId/teams" label="Teams" exact={false} />
        ) : null}
        {can("audit:read") ? (
          <Item workspaceId={workspaceId} to="/w/$workspaceId/audit" label="Audit log" />
        ) : null}
        {can("tokens:manage") ? (
          <Item workspaceId={workspaceId} to="/w/$workspaceId/tokens" label="API tokens" />
        ) : null}
      </SettingsNavGroup>
      {platform ? (
        <SettingsNavGroup label="Instance">
          <Item workspaceId={workspaceId} to="/w/$workspaceId/platform" label="Platform" />
          {canManageInstance(me) ? (
            <Item
              workspaceId={workspaceId}
              to="/w/$workspaceId/domains-tls"
              label="Domains & TLS"
            />
          ) : null}
          {canManageInstance(me) ? (
            <Item
              workspaceId={workspaceId}
              to="/w/$workspaceId/instance-audit"
              label="Instance audit log"
            />
          ) : null}
        </SettingsNavGroup>
      ) : null}
      <SettingsNavGroup label="Account">
        <Item workspaceId={workspaceId} to="/w/$workspaceId/security" label="Security" />
        <Item workspaceId={workspaceId} to="/w/$workspaceId/mcp-clients" label="MCP clients" />
      </SettingsNavGroup>
      <SettingsNavGroup label="Preferences">
        <Item workspaceId={workspaceId} to="/w/$workspaceId/preferences" label="Appearance" />
        <Item
          workspaceId={workspaceId}
          to="/w/$workspaceId/preferences/shortcuts"
          label="Keyboard shortcuts"
        />
        <Item
          workspaceId={workspaceId}
          to="/w/$workspaceId/preferences/accessibility"
          label="Accessibility"
        />
      </SettingsNavGroup>
    </SettingsNav>
  );
}

/** Props for {@link SettingsFrame}. */
export interface SettingsFrameProps {
  workspaceId: string;
  /** The view's name, rendered as the page's h1. */
  title: string;
  /** One line about what the view holds. */
  description?: ReactNode;
  /** Actions on the title's right, e.g. "Invite member". */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Every settings view: the sub-navigation beside a titled column.
 *
 * @param props - Workspace id, title, description, actions and the view.
 * @returns The framed view.
 */
export function SettingsFrame({
  workspaceId,
  title,
  description,
  actions,
  children,
}: SettingsFrameProps) {
  return (
    <SettingsLayout nav={<WorkspaceSettingsNav workspaceId={workspaceId} />}>
      <div className="mb-8 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </SettingsLayout>
  );
}
