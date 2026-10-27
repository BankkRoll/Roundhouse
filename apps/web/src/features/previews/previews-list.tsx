import { ENDED_PREVIEW_STATUSES } from "@roundhouse/shared";
import {
  Badge,
  Button,
  EmptyState,
  SettingsSection,
  Skeleton,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  toast,
} from "@roundhouse/ui";
import { Switch } from "@roundhouse/ui/controls";
import { GitPullRequestIcon } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorState } from "../../components/error-state";
import { errorMessage, isApiError } from "../../lib/api/client";
import type { Preview } from "../../lib/api/previews-client";
import { formatCommit, formatRelativeTime, formatUntil } from "../../lib/format";
import { useProjectPermissions } from "../../lib/permissions";
import { useNow } from "../../lib/use-now";
import {
  useApprovePreview,
  useDeletePreview,
  usePreviews,
  useRedeployPreview,
} from "../../queries/previews";
import { PREVIEW_STATUS, webUrl } from "./preview-format";

const isEnded = (preview: Preview) =>
  (ENDED_PREVIEW_STATUSES as readonly string[]).includes(preview.status);

function PullRequestCell({ preview }: { preview: Preview }) {
  const href = webUrl(preview.pr_url);
  const heading = (
    <>
      <span className="text-muted-foreground tabular-nums">#{preview.pr_number}</span>{" "}
      {preview.title}
    </>
  );
  return (
    <>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="block truncate text-sm font-medium text-foreground outline-none hover:underline focus-visible:underline"
        >
          {heading}
        </a>
      ) : (
        <span className="block truncate text-sm font-medium text-foreground">{heading}</span>
      )}
      <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="truncate">
          {preview.author_login} · <span className="font-mono">{preview.head_ref}</span>
        </span>
        {preview.is_fork ? (
          <Tooltip
            content={`From ${preview.head_repo_full_name ?? "a deleted fork"}. Its code is untrusted.`}
          >
            <Badge tone="warning" tabIndex={0}>
              fork
            </Badge>
          </Tooltip>
        ) : null}
        {preview.draft ? <Badge>draft</Badge> : null}
        {preview.withheld ? (
          <Tooltip content="Secret variables and build args were replaced by empty placeholders.">
            <Badge tone="info" tabIndex={0}>
              secrets withheld
            </Badge>
          </Tooltip>
        ) : null}
      </span>
    </>
  );
}

function ServicesCell({ preview }: { preview: Preview }) {
  if (preview.services.length === 0) {
    return <span className="text-xs text-subtle-foreground">—</span>;
  }
  return (
    <ul className="grid gap-1">
      {preview.services.map((service) => {
        const href = webUrl(service.url);
        return (
          <li key={service.service_id} className="flex min-w-0 items-center gap-1.5 text-xs">
            <StatusDot
              status={service.status ?? "queued"}
              kind="deployment"
              label={
                service.status
                  ? `${service.name}: ${service.status}`
                  : `${service.name}: not deployed`
              }
            />
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="truncate text-foreground outline-none hover:underline focus-visible:underline"
              >
                {service.name}
              </a>
            ) : (
              <span className="truncate text-muted-foreground">{service.name}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function lifetime(preview: Preview, now: number): string {
  if (preview.closed_at !== null && isEnded(preview)) {
    return `${PREVIEW_STATUS[preview.status].label.toLowerCase()} ${formatRelativeTime(preview.closed_at, now)}`;
  }
  return preview.expires_at === null ? "—" : `expires ${formatUntil(preview.expires_at, now)}`;
}

/** Props for {@link PreviewsList}. */
export interface PreviewsListProps {
  workspaceId: string;
  projectId: string;
}

/**
 * A project's previews: PR, status, head commit, services and expiry, with Approve (fork
 * PRs, project admins), Redeploy and Tear down. Open previews by default; a switch adds
 * closed and expired ones.
 *
 * @param props - Workspace and project ids.
 * @returns The section.
 */
export function PreviewsList({ workspaceId, projectId }: PreviewsListProps) {
  const [showEnded, setShowEnded] = useState(false);
  const previews = usePreviews(projectId, showEnded ? "all" : "open");
  const access = useProjectPermissions(workspaceId, projectId);
  const approve = useApprovePreview(projectId);
  const redeploy = useRedeployPreview(projectId);
  const remove = useDeletePreview(projectId);
  const now = useNow(30_000);
  const switchId = useId();
  const [approving, setApproving] = useState<Preview | null>(null);
  const [tearingDown, setTearingDown] = useState<Preview | null>(null);
  const canApprove = access.can("previews:manage");
  const canTearDown = access.can("environments:manage");

  function onApprove(preview: Preview) {
    approve.mutate(
      { previewId: preview.id, headSha: preview.head_sha },
      {
        onSuccess: () => {
          setApproving(null);
          toast({
            title: `Approved #${preview.pr_number}`,
            description: `Building ${formatCommit(preview.head_sha)}.`,
            tone: "success",
          });
        },
        onError: (error) => {
          if (!isApiError(error, "head_moved")) return;
          setApproving(null);
          void previews.refetch();
          toast({
            title: `#${preview.pr_number} has new commits`,
            description: "Nothing was approved. Review the new head commit, then approve that one.",
            tone: "error",
          });
        },
      },
    );
  }

  function onRedeploy(preview: Preview) {
    redeploy.mutate(preview.id, {
      onSuccess: () => toast({ title: `Redeploying #${preview.pr_number}`, tone: "success" }),
      onError: (error) =>
        toast({
          title: `Could not redeploy #${preview.pr_number}`,
          description: errorMessage(error),
          tone: "error",
        }),
    });
  }

  const rows = previews.data ?? [];

  return (
    <SettingsSection
      title="Pull requests"
      description="Each open pull request gets its own environment, built from its head commit."
      actions={
        <div className="flex items-center gap-2">
          <Switch id={switchId} checked={showEnded} onCheckedChange={setShowEnded} />
          <label htmlFor={switchId} className="text-sm text-muted-foreground">
            Show closed
          </label>
        </div>
      }
    >
      {previews.isPending ? (
        <Skeleton className="my-2 h-32" />
      ) : previews.isError ? (
        <ErrorState
          message={errorMessage(previews.error)}
          onRetry={() => void previews.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<GitPullRequestIcon />}
          title={showEnded ? "No previews yet" : "No open previews"}
          description="Previews appear here when a pull request opens against the repository."
          className="py-10"
        />
      ) : (
        <Table stack aria-label="Previews">
          <TableHeader>
            <TableRow>
              <TableHead>Pull request</TableHead>
              <TableHead className="w-32">Status</TableHead>
              <TableHead className="hidden w-24 md:table-cell">Head</TableHead>
              <TableHead className="hidden lg:table-cell">Services</TableHead>
              <TableHead className="hidden w-36 sm:table-cell">Lifetime</TableHead>
              <TableHead className="w-0">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((preview) => {
              const status = PREVIEW_STATUS[preview.status];
              const canRedeploy =
                preview.status === "active" &&
                access.can("deployments:create", preview.environment_id ?? undefined);
              return (
                <TableRow key={preview.id} data-status={preview.status}>
                  <TableCell cell="primary" className="max-w-0 min-w-48">
                    <PullRequestCell preview={preview} />
                  </TableCell>
                  <TableCell>
                    <Tooltip content={status.description}>
                      <Badge tone={status.tone} tabIndex={0}>
                        {status.label}
                      </Badge>
                    </Tooltip>
                    {preview.error ? (
                      <span className="mt-1 block text-xs text-danger">{preview.error}</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
                    {formatCommit(preview.head_sha)}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <ServicesCell preview={preview} />
                  </TableCell>
                  <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                    {lifetime(preview, now)}
                  </TableCell>
                  <TableCell cell="action">
                    <div className="flex items-center justify-end gap-1.5">
                      {preview.status === "pending_approval" && canApprove ? (
                        <Button
                          size="sm"
                          variant="primary"
                          aria-label={`Approve #${preview.pr_number}`}
                          onClick={() => setApproving(preview)}
                        >
                          Approve
                        </Button>
                      ) : null}
                      {canRedeploy ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          aria-label={`Redeploy #${preview.pr_number}`}
                          loading={redeploy.isPending && redeploy.variables === preview.id}
                          onClick={() => onRedeploy(preview)}
                        >
                          Redeploy
                        </Button>
                      ) : null}
                      {canTearDown && !isEnded(preview) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Tear down #${preview.pr_number}`}
                          onClick={() => setTearingDown(preview)}
                        >
                          Tear down
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <ConfirmDialog
        open={approving !== null}
        onOpenChange={(open) => {
          if (!open) {
            setApproving(null);
            approve.reset();
          }
        }}
        title={`Approve #${approving?.pr_number ?? ""} at ${formatCommit(approving?.head_sha)}?`}
        description={
          <>
            Its build steps run code from{" "}
            <span className="font-mono">{approving?.head_repo_full_name ?? "a deleted fork"}</span>{" "}
            on your builder. Only this commit is approved; every new push needs another approval.
          </>
        }
        confirmLabel="Approve and build"
        destructive={false}
        pending={approve.isPending}
        error={
          approve.isError && !isApiError(approve.error, "head_moved")
            ? errorMessage(approve.error)
            : null
        }
        onConfirm={() => approving && onApprove(approving)}
      />
      <ConfirmDialog
        open={tearingDown !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTearingDown(null);
            remove.reset();
          }
        }}
        title={`Tear down #${tearingDown?.pr_number ?? ""}?`}
        description="Its deployments stop, its volumes are scheduled for deletion and its domains go. A later push or reopen of the pull request creates it again."
        confirmLabel="Tear down"
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() =>
          tearingDown &&
          remove.mutate(tearingDown.id, {
            onSuccess: () => {
              toast({ title: `Tore down #${tearingDown.pr_number}`, tone: "success" });
              setTearingDown(null);
            },
          })
        }
      />
    </SettingsSection>
  );
}
