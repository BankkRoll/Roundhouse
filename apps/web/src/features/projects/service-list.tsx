import { Button, cn, StatusBadge } from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import {
  BoxIcon,
  ClockIcon,
  ContainerIcon,
  GitBranchIcon,
  RocketIcon,
  ScrollTextIcon,
} from "lucide-react";
import type {
  Deployment,
  Environment,
  Service,
  ServiceSource,
  ServiceSummary,
} from "../../lib/api/deploy-types";
import { formatCommit, formatRelativeTime, formatTimestamp } from "../../lib/format";
import { useProjectSummary } from "../../queries/projects";

/**
 * Everything a services view draws for one service. The list below and the Phase 2
 * canvas both take this, so swapping the view needs no data changes. `undefined`
 * fields are still loading.
 */
export interface ServiceView {
  service: Service;
  /** Latest config version; `null` when the environment has none. */
  configVersion: number | null | undefined;
  /** Where the code comes from, per that config version. */
  source: ServiceSource | null | undefined;
  /** First domain in the environment; `null` when it has none. */
  domain: ServiceSummary["domain"] | undefined;
  /** Newest deployment; `null` before the first deploy. */
  latest: Deployment | null | undefined;
}

/**
 * Loads the view model of every service of a project in one environment from the
 * project's summary: one request however many services there are.
 *
 * @param projectId - Project id.
 * @param services - The project's services, in display order.
 * @param environment - The environment shown.
 * @returns One view per service, in the given order.
 */
export function useServiceViews(
  projectId: string,
  services: readonly Service[],
  environment: Environment | undefined,
): ServiceView[] {
  const summary = useProjectSummary(projectId, environment?.id);
  const byId = new Map(summary.data?.services.map((entry) => [entry.service.id, entry]));
  return services.map((service) => {
    const entry = byId.get(service.id);
    return {
      service,
      configVersion: entry?.config_version,
      source: entry?.source,
      domain: entry?.domain,
      latest: entry?.latest_deployment,
    };
  });
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

function SourceIcon({
  source,
  kind,
}: {
  source: ServiceSource | null | undefined;
  kind: Service["kind"];
}) {
  const Icon =
    kind === "cron"
      ? ClockIcon
      : !source
        ? BoxIcon
        : source.type === "git"
          ? GitBranchIcon
          : ContainerIcon;
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

const COLUMNS = "lg:grid-cols-[minmax(0,1.5fr)_7rem_3.5rem_minmax(0,1.4fr)_8.5rem_8rem] lg:gap-x-6";

/**
 * The project's services as list rows: name and source, newest deployment status,
 * config version, public domain, last deploy and quick actions. Below 1024px each row
 * folds to a name line and a details line.
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
    <div>
      <div
        aria-hidden="true"
        className={cn(
          "hidden border-b border-border pb-2 text-xs text-muted-foreground lg:grid",
          COLUMNS,
        )}
      >
        <span>Service</span>
        <span>Status</span>
        <span>Config</span>
        <span>Domain</span>
        <span>Last deploy</span>
        <span />
      </div>
      <ul className="divide-y divide-border/70 border-b border-border/70" aria-label="Services">
        {views.map(({ service, configVersion, source, domain, latest }) => (
          <li
            key={service.id}
            className={cn(
              "group relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 py-3.5 transition-colors hover:bg-muted/30",
              COLUMNS,
            )}
          >
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <SourceIcon source={source} kind={service.kind} />
                <Link
                  to="/w/$workspaceId/p/$projectId/s/$serviceId"
                  params={{ workspaceId, projectId, serviceId: service.id }}
                  search={{ env: envParam }}
                  className="truncate outline-none after:absolute after:inset-0 focus-visible:underline"
                >
                  {service.name}
                </Link>
              </h3>
              <p className="mt-0.5 truncate pl-5.5 font-mono text-xs text-muted-foreground">
                {source ? describeSource(source) : source === null ? "no config" : "…"}
              </p>
            </div>
            <div className="justify-self-end lg:justify-self-start">
              {latest ? (
                <StatusBadge status={latest.status} kind="deployment" />
              ) : latest === null ? (
                <span className="text-xs text-muted-foreground">Not deployed</span>
              ) : null}
            </div>
            <div className="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-1 pl-5.5 text-xs text-muted-foreground lg:contents">
              <span className="tabular-nums lg:text-sm lg:text-foreground">
                <span className="lg:sr-only">config </span>
                {configVersion ? `v${configVersion}` : configVersion === null ? "none" : "…"}
              </span>
              <span className="min-w-0 truncate lg:text-sm">
                {domain ? (
                  <a
                    href={domain.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="relative z-10 rounded-sm text-foreground outline-none hover:underline focus-visible:underline"
                  >
                    {domain.hostname}
                  </a>
                ) : domain === null ? (
                  <span>No domain</span>
                ) : (
                  "…"
                )}
              </span>
              <span className="min-w-0 truncate tabular-nums">
                {latest ? (
                  <span title={formatTimestamp(latest.created_at)}>
                    {latest.build ? (
                      <span className="font-mono">{formatCommit(latest.build.commit_sha)} · </span>
                    ) : null}
                    {formatRelativeTime(latest.created_at, now)}
                  </span>
                ) : (
                  "No deployments yet"
                )}
              </span>
              <span className="relative z-10 ml-auto flex shrink-0 items-center justify-end gap-1">
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
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
