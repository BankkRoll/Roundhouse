import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  toast,
} from "@openrail/ui";
import { useNavigate } from "@tanstack/react-router";
import {
  BanIcon,
  EllipsisIcon,
  FileTextIcon,
  RotateCcwIcon,
  RotateCwIcon,
  ScrollTextIcon,
} from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import { errorMessage } from "../../../lib/api/client";
import type { Deployment } from "../../../lib/api/deploy-types";
import { formatTimestamp } from "../../../lib/format";
import { useCancelDeployment, useDeploy, useRollback } from "../../../queries/deployments";
import { canRollBackTo, deploymentRef, isCancellable } from "./deployment-format";

/** Where a deployment's links point. */
export interface DeploymentLinkContext {
  workspaceId: string;
  projectId: string;
  serviceId: string;
  envParam?: string;
}

/**
 * Redeploy, rollback (with confirmation) and cancel for one deployment, shared by the
 * deployments list and the detail page.
 *
 * @param context - Ids used for links.
 * @returns Action handlers, their pending state, and the confirmation dialog to render.
 */
export function useDeploymentActions(context: DeploymentLinkContext) {
  const navigate = useNavigate();
  const deploy = useDeploy();
  const rollback = useRollback();
  const cancel = useCancelDeployment();
  const [rollbackTarget, setRollbackTarget] = useState<Deployment | null>(null);

  function openDeployment(deployment: Deployment) {
    void navigate({
      to: "/w/$workspaceId/p/$projectId/s/$serviceId/deployments/$deploymentId",
      params: { ...context, deploymentId: deployment.id },
      search: { env: context.envParam },
    });
  }

  function redeploy(deployment: Deployment) {
    deploy.mutate(
      {
        serviceId: deployment.service_id,
        environmentId: deployment.environment_id,
        commitSha: deployment.build?.commit_sha,
      },
      {
        onSuccess: (created) => {
          toast({ title: "Redeploying", description: deploymentRef(created), tone: "success" });
        },
        onError: (error) =>
          toast({ title: "Could not redeploy", description: errorMessage(error), tone: "error" }),
      },
    );
  }

  function cancelDeployment(deployment: Deployment) {
    cancel.mutate(deployment, {
      onSuccess: () => toast({ title: "Deployment cancelled", tone: "success" }),
      onError: (error) =>
        toast({ title: "Could not cancel", description: errorMessage(error), tone: "error" }),
    });
  }

  const dialog = (
    <ConfirmDialog
      open={rollbackTarget !== null}
      onOpenChange={(open) => {
        if (!open) {
          setRollbackTarget(null);
          rollback.reset();
        }
      }}
      title={`Roll back to ${rollbackTarget ? deploymentRef(rollbackTarget) : ""}?`}
      description={
        rollbackTarget ? (
          <>
            A new deployment starts from the image and config (v{rollbackTarget.config_version}) of
            the deployment created {formatTimestamp(rollbackTarget.created_at)}. It skips the build;
            variables are read as they are now.
          </>
        ) : null
      }
      confirmLabel="Roll back"
      destructive={false}
      pending={rollback.isPending}
      error={rollback.isError ? errorMessage(rollback.error) : null}
      onConfirm={() => {
        if (!rollbackTarget) return;
        rollback.mutate(rollbackTarget.id, {
          onSuccess: (created) => {
            setRollbackTarget(null);
            toast({ title: "Rolling back", description: deploymentRef(created), tone: "success" });
          },
        });
      }}
    />
  );

  return {
    redeploy,
    cancel: cancelDeployment,
    askRollback: setRollbackTarget,
    openDeployment,
    dialog,
    pending: deploy.isPending || rollback.isPending || cancel.isPending,
  };
}

/** Props for {@link DeploymentMenu}. */
export interface DeploymentMenuProps {
  deployment: Deployment;
  /** Deployment serving traffic, which can't be rolled back to. */
  currentId: string | undefined;
  canDeploy: boolean;
  actions: ReturnType<typeof useDeploymentActions>;
  onLogs: (deployment: Deployment) => void;
  /** Hide "View details" on the detail page itself. */
  showDetails?: boolean;
}

/**
 * The "…" menu of a deployment row.
 *
 * @param props - The deployment, permissions and handlers.
 * @returns The menu.
 */
export function DeploymentMenu({
  deployment,
  currentId,
  canDeploy,
  actions,
  onLogs,
  showDetails = true,
}: DeploymentMenuProps) {
  const ref = deploymentRef(deployment);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for deployment ${ref}`}>
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {showDetails ? (
          <DropdownMenuItem onSelect={() => actions.openDeployment(deployment)}>
            <FileTextIcon />
            View details
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => onLogs(deployment)}>
          <ScrollTextIcon />
          View logs
        </DropdownMenuItem>
        {canDeploy ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => actions.redeploy(deployment)}>
              <RotateCwIcon />
              Redeploy
            </DropdownMenuItem>
            {canRollBackTo(deployment, currentId) ? (
              <DropdownMenuItem onSelect={() => actions.askRollback(deployment)}>
                <RotateCcwIcon />
                Roll back to this
              </DropdownMenuItem>
            ) : null}
            {isCancellable(deployment) ? (
              <DropdownMenuItem destructive onSelect={() => actions.cancel(deployment)}>
                <BanIcon />
                Cancel deployment
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
