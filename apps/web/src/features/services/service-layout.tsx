import {
  Button,
  EmptyState,
  Skeleton,
  StatusBadge,
  tabTriggerClasses,
  toast,
} from "@roundhouse/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet } from "@tanstack/react-router";
import { ArrowLeftIcon, BoxIcon, ExternalLinkIcon, RocketIcon } from "lucide-react";
import { errorMessage } from "../../lib/api/client";
import { usePermissions } from "../../lib/permissions";
import { useDeploy } from "../../queries/deployments";
import { latestDeploymentQueryOptions } from "../../queries/projects";
import { useDomains, useServiceConfig } from "../../queries/services";
import { ProjectPresence } from "../projects/presence";
import { describeSource } from "../projects/service-list";
import { findService, useProjectEnvironment } from "../projects/use-project-environment";
import { KEEP_FOCUS_ATTRIBUTE } from "../shell/focus";
import { SERVICE_TAB_PATHS, SERVICE_TABS } from "./tabs";

/** Props shared by every service page. */
export interface ServicePageProps {
  workspaceId: string;
  projectId: string;
  serviceId: string;
}

/**
 * Layout of a service's pages: back link, name, newest deployment status, source and
 * public URL, the Deploy action, and the tab bar. Tabs are routes, so each one's code
 * loads only when opened.
 *
 * @param props - Workspace, project and service ids.
 * @returns The layout.
 */
export function ServiceLayout({ workspaceId, projectId, serviceId }: ServicePageProps) {
  const { project, environment, envParam } = useProjectEnvironment(projectId);
  const service = findService(project.data, serviceId);
  const config = useServiceConfig(serviceId, environment?.id);
  const domains = useDomains(serviceId, environment?.id);
  const latest = useQuery({
    ...latestDeploymentQueryOptions(serviceId, environment?.id ?? ""),
    enabled: Boolean(environment),
  });
  const deploy = useDeploy();
  const { can } = usePermissions(workspaceId);

  if (!service) {
    return (
      <EmptyState
        icon={<BoxIcon />}
        title="Service not found"
        description="It may have been deleted."
        action={
          <Link
            to="/w/$workspaceId/p/$projectId"
            params={{ workspaceId, projectId }}
            search={{ env: envParam }}
            className="text-sm text-accent-text underline-offset-4 outline-none hover:underline focus-visible:underline"
          >
            Back to {project.data?.name ?? "the project"}
          </Link>
        }
        className="py-16"
      />
    );
  }

  const url = domains.data?.[0]?.url;

  function onDeploy() {
    if (!environment || !service) return;
    deploy.mutate(
      { serviceId, environmentId: environment.id },
      {
        onSuccess: () =>
          toast({
            title: `Deploying ${service.name}`,
            description: environment.name,
            tone: "success",
          }),
        onError: (error) =>
          toast({ title: "Could not deploy", description: errorMessage(error), tone: "error" }),
      },
    );
  }

  return (
    <>
      <Link
        to="/w/$workspaceId/p/$projectId"
        params={{ workspaceId, projectId }}
        search={{ env: envParam }}
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
      >
        <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
        {project.data?.name}
      </Link>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">
              {service.name}
            </h1>
            {latest.data ? <StatusBadge status={latest.data.status} kind="deployment" /> : null}
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
            {config.data ? (
              <span>{describeSource(config.data.source)}</span>
            ) : (
              <Skeleton className="h-3 w-48" />
            )}
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-accent-text outline-none hover:underline focus-visible:underline"
              >
                {url.replace(/^https?:\/\//, "")}
                <ExternalLinkIcon className="size-3" aria-hidden="true" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ProjectPresence className="mr-2" />
          {can("deployments:create") ? (
            <Button
              variant="primary"
              onClick={onDeploy}
              loading={deploy.isPending}
              disabled={!environment}
            >
              {deploy.isPending ? null : <RocketIcon />}
              Deploy
            </Button>
          ) : null}
        </div>
      </div>
      <nav
        aria-label="Service"
        className="mb-6 flex gap-4 overflow-x-auto border-b border-border [scrollbar-width:none] sm:gap-5 lg:mb-8"
        {...{ [KEEP_FOCUS_ATTRIBUTE]: "" }}
      >
        {SERVICE_TABS.map((tab) => (
          <Link
            key={tab.id}
            to={SERVICE_TAB_PATHS[tab.id]}
            params={{ workspaceId, projectId, serviceId }}
            search={{ env: envParam }}
            className={tabTriggerClasses}
            activeOptions={{ includeSearch: false }}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </>
  );
}
