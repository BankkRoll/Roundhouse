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
import { RocketIcon } from "lucide-react";
import { ErrorState } from "../../../components/error-state";
import { errorMessage } from "../../../lib/api/client";
import type { Deployment } from "../../../lib/api/deploy-types";
import { formatRelativeTime, formatTimestamp } from "../../../lib/format";
import { usePermissions } from "../../../lib/permissions";
import { useNow } from "../../../lib/use-now";
import { useDeployments } from "../../../queries/deployments";
import { useProjectEnvironment } from "../../projects/use-project-environment";
import type { ServicePageProps } from "../service-layout";
import { DeploymentMenu, useDeploymentActions } from "./deployment-actions";
import {
  currentDeploymentId,
  deploymentDuration,
  deploymentName,
  deploymentRef,
  TRIGGER_LABELS,
} from "./deployment-format";

function What({ deployment }: { deployment: Deployment }) {
  const message = deployment.build?.commit_message;
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 font-mono text-xs text-foreground">
          {deploymentRef(deployment)}
        </span>
        {message ? (
          <span className="min-w-0 truncate text-sm text-muted-foreground">{message}</span>
        ) : null}
      </div>
      {deployment.failure_reason ? (
        <p className="mt-0.5 truncate text-xs text-danger">{deployment.failure_reason}</p>
      ) : null}
    </div>
  );
}

/**
 * A service's deployments, newest first: status, what was deployed, trigger, duration
 * and age, with redeploy, rollback and cancel per row. Rows update live from the
 * realtime socket.
 *
 * @param props - Workspace, project and service ids.
 * @returns The tab.
 */
export function DeploymentsTab({ workspaceId, projectId, serviceId }: ServicePageProps) {
  const { environment, envParam } = useProjectEnvironment(projectId);
  const deployments = useDeployments(serviceId, environment?.id);
  const { can } = usePermissions(workspaceId);
  const navigate = useNavigate();
  const now = useNow(1000);
  const context = { workspaceId, projectId, serviceId, envParam };
  const actions = useDeploymentActions(context);
  const rows = deployments.data?.pages.flatMap((page) => page.deployments) ?? [];
  const currentId = currentDeploymentId(rows);

  function openLogs(deployment: Deployment) {
    void navigate({
      to: "/w/$workspaceId/p/$projectId/s/$serviceId/logs",
      params: { workspaceId, projectId, serviceId },
      search: {
        env: envParam,
        deployment: deployment.id,
        source:
          deployment.status === "building" || deployment.status === "queued" ? "build" : undefined,
      },
    });
  }

  if (deployments.isPending) {
    return (
      <div className="grid gap-2" aria-busy="true">
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-10" />
        ))}
      </div>
    );
  }
  if (deployments.isError) {
    return (
      <ErrorState
        message={errorMessage(deployments.error)}
        onRetry={() => void deployments.refetch()}
      />
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<RocketIcon />}
        title="No deployments yet"
        description={
          can("deployments:create")
            ? "Deploy to build (for git sources) and start this service on your servers. Set variables first if it needs any."
            : "This service has not been deployed."
        }
        className="py-16"
      />
    );
  }

  return (
    <section aria-label="Deployments">
      <Table stack>
        <TableHeader>
          <TableRow>
            <TableHead className="w-36">Status</TableHead>
            <TableHead>Deployed</TableHead>
            <TableHead className="hidden w-28 md:table-cell">Trigger</TableHead>
            <TableHead className="hidden w-24 text-right sm:table-cell">Duration</TableHead>
            <TableHead className="w-24 text-right">Created</TableHead>
            <TableHead className="w-10">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((deployment) => (
            <TableRow key={deployment.id} data-status={deployment.status}>
              <TableCell>
                <span className="flex items-center gap-2">
                  <Link
                    to="/w/$workspaceId/p/$projectId/s/$serviceId/deployments/$deploymentId"
                    params={{ workspaceId, projectId, serviceId, deploymentId: deployment.id }}
                    search={{ env: envParam }}
                    className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Deployment ${deploymentName(deployment)}, ${deployment.status.replace("_", " ")}`}
                  >
                    <StatusBadge status={deployment.status} kind="deployment" />
                  </Link>
                  {deployment.id === currentId ? <Badge tone="accent">Current</Badge> : null}
                </span>
              </TableCell>
              <TableCell cell="primary" className="max-w-0">
                <What deployment={deployment} />
              </TableCell>
              <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                {TRIGGER_LABELS[deployment.trigger]}
              </TableCell>
              <TableCell className="hidden text-right text-xs text-muted-foreground tabular-nums sm:table-cell">
                {deploymentDuration(deployment, now)}
              </TableCell>
              <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                <time
                  dateTime={new Date(deployment.created_at).toISOString()}
                  title={formatTimestamp(deployment.created_at)}
                >
                  {formatRelativeTime(deployment.created_at, now)}
                </time>
              </TableCell>
              <TableCell cell="action" className="text-right">
                <DeploymentMenu
                  deployment={deployment}
                  currentId={currentId}
                  canDeploy={can("deployments:create")}
                  actions={actions}
                  onLogs={openLogs}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {deployments.hasNextPage ? (
        <div className="mt-4 flex justify-center">
          <Button
            variant="secondary"
            onClick={() => void deployments.fetchNextPage()}
            loading={deployments.isFetchingNextPage}
          >
            Load older deployments
          </Button>
        </div>
      ) : null}
      {actions.dialog}
    </section>
  );
}
