import {
  Badge,
  Button,
  EmptyState,
  Skeleton,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@roundhouse/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  FileSearchIcon,
  HammerIcon,
  type LucideIcon,
  RouteIcon,
  ServerIcon,
  TerminalIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { ErrorState } from "../../../components/error-state";
import { SectionHeader } from "../../../components/section-header";
import { errorMessage, isApiError } from "../../../lib/api/client";
import type { Deployment, DeploymentEvent } from "../../../lib/api/deploy-types";
import { EMPTY, formatRelativeTime, formatTimestamp } from "../../../lib/format";
import { useNow } from "../../../lib/use-now";
import { useDeployment, useDeployments } from "../../../queries/deployments";
import { useEnvironmentGate } from "../../access/environment-gate";
import { useProjectEnvironment } from "../../projects/use-project-environment";
import { RunLogsDialog } from "../cron/runs-tab";
import type { ServicePageProps } from "../service-layout";
import { DeploymentMenu, useDeploymentActions } from "./deployment-actions";
import {
  currentDeploymentId,
  deploymentDuration,
  deploymentRef,
  isCancellable,
  TRIGGER_LABELS,
} from "./deployment-format";

const EVENT_ICONS: Record<DeploymentEvent["type"], { icon: LucideIcon; tone: string }> = {
  status_changed: { icon: CircleDotIcon, tone: "text-muted-foreground" },
  build_started: { icon: HammerIcon, tone: "text-info" },
  build_finished: { icon: HammerIcon, tone: "text-success" },
  scheduled: { icon: ServerIcon, tone: "text-info" },
  schedule_failed: { icon: CircleAlertIcon, tone: "text-danger" },
  replica_status: { icon: CircleDotIcon, tone: "text-info" },
  route_switched: { icon: RouteIcon, tone: "text-accent-text" },
  rollout_finished: { icon: CircleCheckIcon, tone: "text-success" },
  pre_deploy_started: { icon: TerminalIcon, tone: "text-info" },
  pre_deploy_finished: { icon: TerminalIcon, tone: "text-success" },
  error: { icon: CircleAlertIcon, tone: "text-danger" },
};

/** The pre-deploy run an event is about, from its `data` (`{ run_id, status }`). */
function preDeployRun(event: DeploymentEvent): { runId: string; status: unknown } | null {
  if (event.type !== "pre_deploy_started" && event.type !== "pre_deploy_finished") return null;
  const runId = event.data?.run_id;
  return typeof runId === "string" ? { runId, status: event.data?.status } : null;
}

function eventIcon(event: DeploymentEvent): { icon: LucideIcon; tone: string } {
  const meta = EVENT_ICONS[event.type] ?? EVENT_ICONS.status_changed;
  if (event.type === "pre_deploy_finished" && event.data?.status !== "succeeded") {
    return { ...meta, tone: "text-danger" };
  }
  return meta;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm text-foreground tabular-nums">{children}</dd>
    </div>
  );
}

function Timeline({
  events,
  now,
  onOpenRun,
}: {
  events: DeploymentEvent[];
  now: number;
  /** Opens a pre-deploy command's output. */
  onOpenRun: (runId: string) => void;
}) {
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">No events yet.</p>;
  }
  return (
    <ol className="relative grid gap-3.5 before:absolute before:top-2 before:bottom-2 before:left-[9px] before:w-px before:bg-border">
      {events.map((event) => {
        const { icon: Icon, tone } = eventIcon(event);
        const run = preDeployRun(event);
        return (
          <li key={event.id} className="relative flex items-start gap-3">
            <span className="relative z-10 flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-background">
              <Icon className={`size-3 ${tone}`} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-foreground">{event.message}</p>
              <p className="text-xs text-muted-foreground">
                {event.type.replace(/_/g, " ")} ·{" "}
                <time
                  dateTime={new Date(event.created_at).toISOString()}
                  title={formatTimestamp(event.created_at)}
                >
                  {formatRelativeTime(event.created_at, now)}
                </time>
                {run ? (
                  <>
                    {" · "}
                    <button
                      type="button"
                      onClick={() => onOpenRun(run.runId)}
                      className="rounded-sm text-foreground underline-offset-2 outline-none hover:underline focus-visible:underline"
                    >
                      View output
                    </button>
                  </>
                ) : null}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One deployment: what it ran, its timeline of events (live while in flight), and where
 * each replica runs, with the same actions as the list.
 *
 * @param props - Ids from the URL.
 * @returns The page.
 */
export function DeploymentDetailPage({
  workspaceId,
  projectId,
  serviceId,
  deploymentId,
}: ServicePageProps & { deploymentId: string }) {
  const { environment, envParam } = useProjectEnvironment(projectId);
  const detail = useDeployment(deploymentId);
  const list = useDeployments(serviceId, environment?.id);
  const { can } = useEnvironmentGate(workspaceId, projectId, environment);
  const navigate = useNavigate();
  const now = useNow(1000);
  const actions = useDeploymentActions({ workspaceId, projectId, serviceId, envParam });
  const [openRun, setOpenRun] = useState<string | null>(null);
  const currentId = currentDeploymentId(list.data?.pages.flatMap((page) => page.deployments) ?? []);

  const back = (
    <Link
      to="/w/$workspaceId/p/$projectId/s/$serviceId/deployments"
      params={{ workspaceId, projectId, serviceId }}
      search={{ env: envParam }}
      className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
    >
      <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
      All deployments
    </Link>
  );

  if (detail.isPending) {
    return (
      <>
        {back}
        <Skeleton className="mb-8 h-28 rounded-lg" />
        <div className="grid gap-8 lg:grid-cols-2">
          <Skeleton className="h-64 rounded-lg" />
          <Skeleton className="h-64 rounded-lg" />
        </div>
      </>
    );
  }
  if (detail.isError) {
    return (
      <>
        {back}
        {isApiError(detail.error, 404) ? (
          <EmptyState icon={<FileSearchIcon />} title="Deployment not found" />
        ) : (
          <ErrorState message={errorMessage(detail.error)} onRetry={() => void detail.refetch()} />
        )}
      </>
    );
  }

  const deployment = detail.data;
  function openLogs(target: Deployment, source?: "build" | "runtime") {
    void navigate({
      to: "/w/$workspaceId/p/$projectId/s/$serviceId/logs",
      params: { workspaceId, projectId, serviceId },
      search: { env: envParam, deployment: target.id, source },
    });
  }

  return (
    <>
      {back}
      <section aria-labelledby="deployment-heading" className="mb-12">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2
                id="deployment-heading"
                className="font-mono text-base font-semibold text-foreground"
              >
                {deploymentRef(deployment)}
              </h2>
              <StatusBadge status={deployment.status} kind="deployment" />
              {deployment.id === currentId ? <Badge tone="accent">Current</Badge> : null}
            </div>
            {deployment.build?.commit_message ? (
              <p className="mt-1 text-sm text-muted-foreground">
                {deployment.build.commit_message}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {deployment.build_id ? (
              <Button variant="secondary" size="sm" onClick={() => openLogs(deployment, "build")}>
                Build logs
              </Button>
            ) : null}
            <Button variant="secondary" size="sm" onClick={() => openLogs(deployment, "runtime")}>
              Runtime logs
            </Button>
            {can("deployments:create") && isCancellable(deployment) ? (
              <Button variant="danger-outline" size="sm" onClick={() => actions.cancel(deployment)}>
                Cancel
              </Button>
            ) : null}
            <DeploymentMenu
              deployment={deployment}
              currentId={currentId}
              canDeploy={can("deployments:create")}
              actions={actions}
              onLogs={(target) => openLogs(target)}
              showDetails={false}
            />
          </div>
        </div>
        {deployment.failure_reason ? (
          <p
            role="alert"
            className="mt-4 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            {deployment.failure_reason}
          </p>
        ) : null}
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-y border-border/70 py-4 sm:grid-cols-3 lg:grid-cols-6">
          <Fact label="Trigger">{TRIGGER_LABELS[deployment.trigger]}</Fact>
          <Fact label="Config">v{deployment.config_version}</Fact>
          <Fact label="Duration">{deploymentDuration(deployment, now)}</Fact>
          <Fact label="Created">
            <span title={formatTimestamp(deployment.created_at)}>
              {formatRelativeTime(deployment.created_at, now)}
            </span>
          </Fact>
          <Fact label="Author">{deployment.build?.commit_author ?? EMPTY}</Fact>
          <Fact label="Rollback of">
            {deployment.rollback_of ? (
              <Link
                to="/w/$workspaceId/p/$projectId/s/$serviceId/deployments/$deploymentId"
                params={{
                  workspaceId,
                  projectId,
                  serviceId,
                  deploymentId: deployment.rollback_of,
                }}
                search={{ env: envParam }}
                className="font-mono text-accent-text hover:underline"
              >
                {deployment.rollback_of}
              </Link>
            ) : (
              EMPTY
            )}
          </Fact>
        </dl>
        {deployment.image ? (
          <p
            className="mt-3 truncate font-mono text-xs text-muted-foreground"
            title={deployment.image}
          >
            image {deployment.image}
          </p>
        ) : null}
      </section>
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:gap-10">
        <section aria-labelledby="timeline-heading">
          <SectionHeader id="timeline-heading" title="Timeline" />
          <Timeline events={deployment.events} now={now} onOpenRun={setOpenRun} />
        </section>
        <section aria-labelledby="replicas-heading">
          <SectionHeader
            id="replicas-heading"
            title="Replicas"
            meta={`${deployment.placements.length} placed`}
          />
          {deployment.placements.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {isCancellable(deployment) ? "Not scheduled yet." : "No replicas were placed."}
            </p>
          ) : (
            <Table stack>
              <TableHeader>
                <TableRow>
                  <TableHead>Replica</TableHead>
                  <TableHead>Node</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="hidden sm:table-cell">Container</TableHead>
                  <TableHead className="text-right">Reported</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deployment.placements.map((placement) => (
                  <TableRow key={placement.id}>
                    <TableCell cell="primary" className="text-sm tabular-nums">
                      #{placement.replica}
                    </TableCell>
                    <TableCell className="text-sm">
                      <Link
                        to="/w/$workspaceId/servers/$nodeId"
                        params={{ workspaceId, nodeId: placement.node_id }}
                        className="text-foreground hover:underline"
                      >
                        {placement.node_name ?? placement.node_id}
                      </Link>
                    </TableCell>
                    <TableCell cell="action">
                      <StatusBadge status={placement.state} kind="workload" />
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                      {placement.container_id?.slice(0, 12) ?? EMPTY}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                      {formatRelativeTime(placement.last_status_at, now)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </div>
      {actions.dialog}
      <RunLogsDialog
        runId={openRun}
        onOpenChange={(open) => {
          if (!open) setOpenRun(null);
        }}
        canCancel={can("deployments:create")}
      />
    </>
  );
}
