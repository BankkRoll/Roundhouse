import { Button, cn, StatusBadge } from "@roundhouse/ui";
import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { BoxIcon, ContainerIcon, GitBranchIcon, RocketIcon, ScrollTextIcon } from "lucide-react";
import type {
  Deployment,
  Environment,
  Service,
  ServiceConfig,
  ServiceSource,
} from "../../lib/api/deploy-types";
import { formatCommit, formatRelativeTime, formatTimestamp } from "../../lib/format";
import { latestDeploymentQueryOptions } from "../../queries/projects";
import { serviceConfigQueryOptions } from "../../queries/services";

/**
 * Everything a services view draws for one service. The list below and the Phase 2
 * canvas both take this, so swapping the view needs no data changes.
 */
export interface ServiceView {
  service: Service;
  /** Latest config version; `undefined` while loading. */
  config: ServiceConfig | undefined;
  /** Newest deployment; `null` before the first deploy, `undefined` while loading. */
  latest: Deployment | null | undefined;
}

/**
 * Loads the view model of every service of a project in one environment: its latest
 * config and newest deployment. Queries are shared with the service pages.
 *
 * @param services - The project's services.
 * @param environment - The environment shown.
 * @returns One view per service, in the given order.
 */
export function useServiceViews(
  services: readonly Service[],
  environment: Environment | undefined,
): ServiceView[] {
  const environmentId = environment?.id ?? "";
  const configs = useQueries({
    queries: services.map((service) => ({
      ...serviceConfigQueryOptions(service.id, environmentId),
      enabled: Boolean(environment),
    })),
  });
  const latest = useQueries({
    queries: services.map((service) => ({
      ...latestDeploymentQueryOptions(service.id, environmentId),
      enabled: Boolean(environment),
    })),
  });
  return services.map((service, index) => ({
    service,
    config: configs[index]?.data,
    latest: latest[index]?.data,
  }));
}

/**
 * One-line description of where a service's code comes from.
 *
 * @param source - The service's source.
 * @returns e.g. `"ghcr.io/acme/api:1.4"` or `"acme/storefront@main · apps/web"`.
 */
export function describeSource(source: ServiceSource): string {
  if (source.type === "image") return source.image;
  const repo = source.repo_url
    .replace(/^https:\/\/(www\.)?github\.com\//, "")
    .replace(/\.git$/, "");
  const dir = source.root_dir && source.root_dir !== "." ? ` · ${source.root_dir}` : "";
  return `${repo}@${source.branch}${dir}`;
}

function SourceIcon({ source }: { source: ServiceSource | undefined }) {
  const Icon = !source ? BoxIcon : source.type === "git" ? GitBranchIcon : ContainerIcon;
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

/** Props for {@link ServiceList}. */
export interface ServiceListProps {
  workspaceId: string;
  projectId: string;
  views: readonly ServiceView[];
  /** `env` search param to keep on links. */
  envParam?: string;
  /** Present when the caller may deploy; deploys one service. */
  onDeploy?: (service: Service) => void;
  /** Service currently being deployed from this list. */
  deployingId?: string | null;
  now: number;
}

/**
 * The project's services as cards: source, newest deployment and quick actions.
 *
 * @param props - Services, links and the deploy action.
 * @returns The list.
 */
export function ServiceList({
  workspaceId,
  projectId,
  views,
  envParam,
  onDeploy,
  deployingId,
  now,
}: ServiceListProps) {
  return (
    <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Services">
      {views.map(({ service, config, latest }) => (
        <li
          key={service.id}
          className="group relative flex flex-col rounded-lg border border-border bg-surface transition-colors focus-within:border-border-strong hover:border-border-strong"
        >
          <div className="flex items-start justify-between gap-3 px-4 pt-4">
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 font-mono text-sm font-semibold text-foreground">
                <SourceIcon source={config?.source} />
                <Link
                  to="/w/$workspaceId/p/$projectId/s/$serviceId"
                  params={{ workspaceId, projectId, serviceId: service.id }}
                  search={{ env: envParam }}
                  className="truncate outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:underline"
                >
                  {service.name}
                </Link>
              </h3>
              <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                {config ? describeSource(config.source) : "…"}
              </p>
            </div>
            {latest ? (
              <StatusBadge status={latest.status} kind="deployment" className="mt-0.5 shrink-0" />
            ) : latest === null ? (
              <span className="mt-0.5 shrink-0 font-mono text-[11px] text-subtle-foreground">
                not deployed
              </span>
            ) : null}
          </div>
          <dl className="grid grid-cols-3 gap-2 px-4 py-3 font-mono text-[11px]">
            <div>
              <dt className="text-subtle-foreground">replicas</dt>
              <dd className="text-foreground tabular-nums">{config?.deploy.replicas ?? "…"}</dd>
            </div>
            <div>
              <dt className="text-subtle-foreground">port</dt>
              <dd className="text-foreground tabular-nums">
                {config ? (config.networking.port ?? "none") : "…"}
              </dd>
            </div>
            <div>
              <dt className="text-subtle-foreground">config</dt>
              <dd className="text-foreground tabular-nums">
                {config ? `v${config.version}` : "…"}
              </dd>
            </div>
          </dl>
          <footer className="relative z-10 mt-auto flex items-center justify-between gap-2 border-t border-border px-4 py-2 font-mono text-[11px] text-muted-foreground">
            <span className="min-w-0 truncate">
              {latest ? (
                <span title={formatTimestamp(latest.created_at)}>
                  {latest.build ? `${formatCommit(latest.build.commit_sha)} · ` : ""}
                  {formatRelativeTime(latest.created_at, now)}
                </span>
              ) : (
                "no deployments yet"
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <Button asChild variant="ghost" size="icon-sm">
                <Link
                  to="/w/$workspaceId/p/$projectId/s/$serviceId/logs"
                  params={{ workspaceId, projectId, serviceId: service.id }}
                  search={{ env: envParam }}
                  aria-label={`Logs of ${service.name}`}
                >
                  <ScrollTextIcon />
                </Link>
              </Button>
              {onDeploy ? (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={deployingId === service.id}
                  onClick={() => onDeploy(service)}
                  aria-label={`Deploy ${service.name}`}
                  className={cn(deployingId === service.id && "opacity-80")}
                >
                  {deployingId === service.id ? null : <RocketIcon />}
                  Deploy
                </Button>
              ) : null}
            </span>
          </footer>
        </li>
      ))}
    </ul>
  );
}
