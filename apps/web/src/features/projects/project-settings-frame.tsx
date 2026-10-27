import { SettingsLayout, SettingsNav, SettingsNavGroup, SettingsNavItem } from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useProjectPermissions } from "../../lib/permissions";
import { KEEP_FOCUS_ATTRIBUTE } from "../shell/focus";
import { useProjectEnvironment } from "./use-project-environment";

type ProjectSettingsPath =
  | "/w/$workspaceId/p/$projectId/settings"
  | "/w/$workspaceId/p/$projectId/settings/access"
  | "/w/$workspaceId/p/$projectId/settings/environments"
  | "/w/$workspaceId/p/$projectId/previews";

/** Props for {@link ProjectSettingsFrame}. */
export interface ProjectSettingsFrameProps {
  workspaceId: string;
  projectId: string;
  /** The view's name, rendered as the page's h1. */
  title: string;
  /** One line about what the view holds. */
  description?: ReactNode;
  /** Actions on the title's right. */
  actions?: ReactNode;
  children: ReactNode;
}

/**
 * Every project settings view: a back link to the project, the sub-navigation (General,
 * Access for project admins, Environments, Previews) beside a titled column. Links keep the
 * selected environment.
 *
 * @param props - Ids, title, description, actions and the view.
 * @returns The framed view, or nothing while the project loads.
 */
export function ProjectSettingsFrame({
  workspaceId,
  projectId,
  title,
  description,
  actions,
  children,
}: ProjectSettingsFrameProps) {
  const { project, envParam } = useProjectEnvironment(projectId);
  const access = useProjectPermissions(workspaceId, projectId);
  if (!project.data) return null;

  const item = (to: ProjectSettingsPath, label: string) => (
    <SettingsNavItem asChild>
      <Link
        to={to}
        params={{ workspaceId, projectId }}
        search={{ env: envParam }}
        activeOptions={{ exact: true, includeSearch: false }}
      >
        {label}
      </Link>
    </SettingsNavItem>
  );

  return (
    <div>
      <Link
        to="/w/$workspaceId/p/$projectId"
        params={{ workspaceId, projectId }}
        search={{ env: envParam }}
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
      >
        <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
        {project.data.name}
      </Link>
      <SettingsLayout
        nav={
          <SettingsNav label="Project settings" {...{ [KEEP_FOCUS_ATTRIBUTE]: "" }}>
            <SettingsNavGroup label="Project">
              {item("/w/$workspaceId/p/$projectId/settings", "General")}
              {access.can("access:manage")
                ? item("/w/$workspaceId/p/$projectId/settings/access", "Access")
                : null}
              {item("/w/$workspaceId/p/$projectId/settings/environments", "Environments")}
              {item("/w/$workspaceId/p/$projectId/previews", "Previews")}
            </SettingsNavGroup>
          </SettingsNav>
        }
      >
        <div className="mb-8 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
            {description ? (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
        {children}
      </SettingsLayout>
    </div>
  );
}
