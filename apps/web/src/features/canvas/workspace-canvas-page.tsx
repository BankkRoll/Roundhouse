import { Badge, EmptyState, Skeleton } from "@roundhouse/ui";
import { SegmentedControl } from "@roundhouse/ui/controls";
import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon, GitPullRequestDraftIcon, ShieldCheckIcon } from "lucide-react";
import { useState } from "react";
import { ErrorState } from "../../components/error-state";
import { PageHeader } from "../../components/page-header";
import { SectionHeader } from "../../components/section-header";
import type { WorkspaceChangeSet } from "../../lib/api/changes-types";
import { errorMessage } from "../../lib/api/client";
import { formatRelativeTime } from "../../lib/format";
import { useNow } from "../../lib/use-now";
import { useWorkspaceChangeSets } from "../../queries/changes";
import { ProjectsGrid } from "../projects/projects-grid";
import { changeCount } from "./diff-format";
import { ReviewBadge } from "./review-status";

type Filter = "open" | "pending";

function ChangeSetRow({
  workspaceId,
  set,
  now,
}: {
  workspaceId: string;
  set: WorkspaceChangeSet;
  now: number;
}) {
  const title = set.title ?? (set.is_draft ? "Draft" : `Proposed via ${set.source}`);
  return (
    <li>
      <Link
        to="/w/$workspaceId/p/$projectId"
        params={{ workspaceId, projectId: set.project_id }}
        search={{ env: set.environment_id, review: set.id }}
        className="grid gap-1 px-3 py-2.5 outline-none hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4"
      >
        <span className="grid min-w-0 gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-foreground">
            <GitPullRequestDraftIcon
              className="size-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="truncate font-medium">{title}</span>
            <ReviewBadge status={set.review_status} />
            {set.environment_requires_approval && set.review_status !== "approved" ? (
              <Badge tone="warning">
                <ShieldCheckIcon className="size-3" aria-hidden="true" />
                approval required
              </Badge>
            ) : null}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {set.project_name} · {set.environment_name} · {changeCount(set.op_count)}
          </span>
        </span>
        <span className="flex items-center gap-3 text-xs text-muted-foreground">
          {set.conflicted_count > 0 ? (
            <span className="inline-flex items-center gap-1 text-warning">
              <AlertTriangleIcon className="size-3.5" aria-hidden="true" />
              {set.conflicted_count} conflict{set.conflicted_count === 1 ? "" : "s"}
            </span>
          ) : null}
          <span>{formatRelativeTime(set.updated_at, now)}</span>
        </span>
      </Link>
    </li>
  );
}

/**
 * The workspace's Canvas page: staged changes waiting across every project the caller
 * can see (the review queue), and the projects, each of which opens on its canvas.
 *
 * @param props - Workspace id.
 * @returns The page.
 */
export function WorkspaceCanvasPage({ workspaceId }: { workspaceId: string }) {
  const [filter, setFilter] = useState<Filter>("open");
  const sets = useWorkspaceChangeSets(workspaceId, filter);
  const now = useNow(30_000);

  return (
    <>
      <PageHeader
        title="Canvas"
        subline="Staged changes across your projects, and each project's map of services"
      />
      <div className="grid gap-10">
        <section aria-labelledby="changes-heading">
          <SectionHeader
            id="changes-heading"
            title="Staged changes"
            meta={sets.data ? String(sets.data.length) : undefined}
            action={
              <SegmentedControl
                label="Show"
                value={filter}
                onValueChange={setFilter}
                options={[
                  { value: "open", label: "All open" },
                  { value: "pending", label: "Waiting for review" },
                ]}
              />
            }
          />
          {sets.isError ? (
            <ErrorState message={errorMessage(sets.error)} onRetry={() => void sets.refetch()} />
          ) : sets.isPending ? (
            <div className="grid gap-2" aria-busy="true">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : sets.data.length ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {sets.data.map((set) => (
                <ChangeSetRow key={set.id} workspaceId={workspaceId} set={set} now={now} />
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={<GitPullRequestDraftIcon />}
              title={filter === "pending" ? "Nothing waits for review" : "Nothing is staged"}
              description="Changes staged on a project's canvas, or proposed by templates and agents, show up here until they are applied or discarded."
            />
          )}
        </section>
        <section aria-labelledby="canvas-projects-heading">
          <SectionHeader id="canvas-projects-heading" title="Projects" />
          <ProjectsGrid workspaceId={workspaceId} />
        </section>
      </div>
    </>
  );
}
