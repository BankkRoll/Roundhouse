import { Button, cn } from "@roundhouse/ui";
import {
  AlertTriangleIcon,
  GitPullRequestDraftIcon,
  RocketIcon,
  ShieldCheckIcon,
} from "lucide-react";
import type { ChangeSet } from "../../lib/api/changes-types";
import { changeCount } from "./diff-format";
import { ReviewBadge } from "./review-status";

/** Props for {@link StagedBar}. */
export interface StagedBarProps {
  draft: ChangeSet;
  onReview: () => void;
  onDiscard: () => void;
  /** Present when the caller may apply; applies with `deploy: "affected"`. */
  onDeploy?: () => void;
  deploying?: boolean;
  /** The environment needs an approval the draft doesn't have yet; Review leads instead. */
  needsApproval?: boolean;
  className?: string;
}

/**
 * The bar under the canvas while the environment has staged changes: how many, how many
 * conflict, and Review / Discard / Deploy. Deploy is held back while anything conflicts;
 * the review panel explains why.
 *
 * @param props - The draft and its actions.
 * @returns The bar.
 */
export function StagedBar({
  draft,
  onReview,
  onDiscard,
  onDeploy,
  deploying = false,
  needsApproval = false,
  className,
}: StagedBarProps) {
  const conflicts = draft.conflicted_count;
  return (
    <section
      aria-label="Staged changes"
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-accent/40 bg-surface px-3 py-2 shadow-lg shadow-black/20",
        className,
      )}
    >
      <p className="flex min-w-0 items-center gap-2 text-sm text-foreground" aria-live="polite">
        <GitPullRequestDraftIcon className="size-4 shrink-0 text-accent-text" aria-hidden="true" />
        <span className="font-medium">{changeCount(draft.op_count)}</span>
        <span className="text-muted-foreground">staged</span>
        {conflicts > 0 ? (
          <span className="inline-flex items-center gap-1 text-warning">
            <AlertTriangleIcon className="size-3.5" aria-hidden="true" />
            {conflicts} conflict{conflicts === 1 ? "" : "s"}
          </span>
        ) : null}
        <ReviewBadge status={draft.review_status} />
        {needsApproval ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <ShieldCheckIcon className="size-3.5" aria-hidden="true" />
            needs approval
          </span>
        ) : null}
      </p>
      <div className="ml-auto flex items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={onDiscard}>
          Discard
        </Button>
        <Button variant={onDeploy ? "secondary" : "primary"} size="sm" onClick={onReview}>
          Review
        </Button>
        {onDeploy ? (
          <Button
            variant="primary"
            size="sm"
            onClick={onDeploy}
            loading={deploying}
            disabled={conflicts > 0 || draft.op_count === 0}
            title={conflicts > 0 ? "Resolve the conflicts in Review first" : undefined}
          >
            {deploying ? null : <RocketIcon />}
            Deploy
          </Button>
        ) : null}
      </div>
    </section>
  );
}
