import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  KbdHint,
} from "@roundhouse/ui";
import { Link, useMatches, useNavigate, useParams } from "@tanstack/react-router";
import { BellIcon, ChevronsUpDownIcon, LayersIcon, MenuIcon, SearchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { isApplePlatform } from "../../lib/platform";
import { useMembership } from "../../queries/me";
import { findService, useProjectEnvironment } from "../projects/use-project-environment";

function Separator({ className }: { className?: string }) {
  return (
    <li aria-hidden="true" className={cn("text-subtle-foreground", className)}>
      /
    </li>
  );
}

const crumbLink =
  "block max-w-40 truncate rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Breadcrumbs inside a project: project, environment switcher and service. The
 * environment menu lists every environment of the project; Phase 1 creates only
 * production, so it usually has one entry.
 */
function ProjectCrumbs({
  workspaceId,
  projectId,
  serviceId,
}: {
  workspaceId: string;
  projectId: string;
  serviceId?: string;
}) {
  const navigate = useNavigate();
  const { project, environment, envParam } = useProjectEnvironment(projectId);
  const service = serviceId ? findService(project.data, serviceId) : undefined;
  return (
    <>
      <Separator className="hidden md:block" />
      <li className="min-w-0">
        <Link
          to="/w/$workspaceId/p/$projectId"
          params={{ workspaceId, projectId }}
          search={{ env: envParam }}
          className={`${crumbLink} font-mono`}
        >
          {project.data?.name ?? "Project"}
        </Link>
      </li>
      <Separator />
      <li className="shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex h-6 items-center gap-1.5 rounded-md border border-border bg-surface px-1.5 font-mono text-xs text-foreground outline-none transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Environment: ${environment?.name ?? "loading"}. Switch environment`}
          >
            <LayersIcon className="size-3 text-accent-text" aria-hidden="true" />
            {environment?.name ?? "…"}
            <ChevronsUpDownIcon className="size-3 text-muted-foreground" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Environments</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={environment?.slug}
              onValueChange={(slug) => {
                const next = project.data?.environments.find((entry) => entry.slug === slug);
                void navigate({
                  to: ".",
                  search: (previous: Record<string, unknown>) => ({
                    ...previous,
                    env: next?.kind === "production" ? undefined : slug,
                  }),
                });
              }}
            >
              {project.data?.environments.map((entry) => (
                <DropdownMenuRadioItem key={entry.id} value={entry.slug}>
                  <span className="font-mono">{entry.name}</span>
                  <span className="ml-auto font-mono text-[10px] text-subtle-foreground">
                    {entry.kind}
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <p className="px-2 pt-1 pb-2 text-xs text-subtle-foreground">
              Staging and preview environments arrive in a later phase.
            </p>
          </DropdownMenuContent>
        </DropdownMenu>
      </li>
      {serviceId ? (
        <>
          <Separator />
          <li className="min-w-0">
            <Link
              to="/w/$workspaceId/p/$projectId/s/$serviceId"
              params={{ workspaceId, projectId, serviceId }}
              search={{ env: envParam }}
              className={`${crumbLink} font-mono`}
            >
              {service?.name ?? "Service"}
            </Link>
          </li>
        </>
      ) : null}
    </>
  );
}

/**
 * Top bar: breadcrumbs (with the environment switcher inside a project), command palette
 * trigger and notifications.
 *
 * @param props - Workspace id and handlers for the palette and mobile menu.
 * @returns The top bar.
 */
export function TopBar({
  workspaceId,
  onOpenPalette,
  onOpenMenu,
}: {
  workspaceId: string;
  onOpenPalette: () => void;
  onOpenMenu: () => void;
}) {
  const workspace = useMembership(workspaceId);
  const { projectId, serviceId } = useParams({ strict: false }) as {
    projectId?: string;
    serviceId?: string;
  };
  const title = useMatches({
    select: (matches) =>
      [...matches].reverse().find((match) => match.staticData.title)?.staticData.title,
  });
  let crumbs: ReactNode = null;
  if (projectId) {
    crumbs = (
      <ProjectCrumbs workspaceId={workspaceId} projectId={projectId} serviceId={serviceId} />
    );
  }
  return (
    <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur md:px-6">
      <Button
        variant="ghost"
        size="icon-sm"
        className="md:hidden"
        onClick={onOpenMenu}
        aria-label="Open navigation"
      >
        <MenuIcon />
      </Button>
      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        <ol className="flex items-center gap-1.5 text-sm">
          <li className={cn("truncate text-muted-foreground", projectId && "hidden md:block")}>
            {workspace?.name ?? "Workspace"}
          </li>
          {crumbs}
          {title ? (
            <>
              <Separator className={projectId ? "hidden sm:block" : undefined} />
              <li
                className={cn(
                  "truncate font-medium text-foreground",
                  projectId && "hidden sm:block",
                )}
                aria-current="page"
              >
                {title}
              </li>
            </>
          ) : null}
        </ol>
      </nav>
      <button
        type="button"
        onClick={onOpenPalette}
        className="hidden h-8 w-72 items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-sm text-subtle-foreground outline-none transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring sm:flex"
      >
        <SearchIcon className="size-3.5" aria-hidden="true" />
        <span className="flex-1 text-left">Search or run a command</span>
        <KbdHint keys={[isApplePlatform() ? "⌘" : "Ctrl", "K"]} />
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="sm:hidden"
        onClick={onOpenPalette}
        aria-label="Search or run a command"
      >
        <SearchIcon />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Notifications">
            <BellIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>Notifications</DropdownMenuLabel>
          <p className="px-2 pb-3 text-sm text-muted-foreground">You are all caught up.</p>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
