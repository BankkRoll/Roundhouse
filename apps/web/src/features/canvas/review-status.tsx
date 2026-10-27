import { Badge, Button, Label, Textarea } from "@roundhouse/ui";
import { CheckIcon, SendIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import { useId, useState } from "react";
import type { ChangeSet, ChangeSetReview } from "../../lib/api/changes-types";

/** Props for {@link ReviewStatus}. */
export interface ReviewStatusProps {
  set: ChangeSet;
  /** The review's approval block, once loaded. */
  approval: ChangeSetReview["approval"] | undefined;
  /** The signed-in user, to tell whether they may review. */
  userId: string | undefined;
  /** Display name of a user ID, for "Approved by …". */
  nameOf: (userId: string) => string;
  /** Present when the caller may propose changes. */
  onSubmit?: (note: string | undefined) => void;
  /** Present when the caller holds `changes:approve`. */
  onDecide?: (decision: "approve" | "reject", note: string | undefined) => void;
  pending?: boolean;
}

/** Longest note the API accepts (`MAX_REVIEW_NOTE_LENGTH`). */
const NOTE_LIMIT = 500;

/**
 * Where a change set is in review, and the actions the caller may take on it: ask for a
 * review, or approve or reject the revision on screen. Whoever opened the set or staged
 * changes in it can't review it; the API refuses them too (`self_review`), this only
 * hides the buttons and says why.
 *
 * @param props - The set, its approval state, the caller and the actions.
 * @returns The review block of the review panel.
 */
export function ReviewStatus({
  set,
  approval,
  userId,
  nameOf,
  onSubmit,
  onDecide,
  pending = false,
}: ReviewStatusProps) {
  const [note, setNote] = useState("");
  const noteId = useId();
  const status = set.review_status;
  const isAuthor = Boolean(userId && approval?.authors.includes(userId));
  const approvedHere = status === "approved" && Boolean(approval?.approved);
  const trimmed = note.trim() || undefined;
  const canDecide = Boolean(onDecide) && !isAuthor && set.op_count > 0;
  const canSubmit =
    Boolean(onSubmit) && set.op_count > 0 && (status === "none" || status === "rejected");

  if (!approval?.required && status === "none" && !onSubmit) return null;

  return (
    <section
      aria-labelledby={`${noteId}-title`}
      className="grid gap-3 rounded-md border border-border bg-surface-raised/40 px-3 py-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3
          id={`${noteId}-title`}
          className="font-mono text-[11px] tracking-wider text-muted-foreground uppercase"
        >
          Review
        </h3>
        <ReviewBadge status={status} />
        {approval?.required ? (
          <Badge tone={approvedHere ? "success" : "warning"}>
            <ShieldCheckIcon className="size-3" aria-hidden="true" />
            approval required
          </Badge>
        ) : null}
      </div>

      <p className="text-sm text-muted-foreground">
        {status === "approved" && set.approved_by
          ? `Approved by ${nameOf(set.approved_by)} at revision ${set.revision}.`
          : status === "rejected" && set.rejected_by
            ? `Rejected by ${nameOf(set.rejected_by)}. Change it, or ask for another review.`
            : status === "submitted"
              ? `Waiting for a reviewer${set.submitted_by ? `, asked by ${nameOf(set.submitted_by)}` : ""}.`
              : approval?.required
                ? "This environment needs an approval from someone else before these changes apply."
                : "Nobody has been asked to review these changes."}
      </p>
      {set.review_note ? (
        // SECURITY: user-written; rendered as text, never as markup.
        <blockquote className="border-l-2 border-border-strong pl-3 text-sm whitespace-pre-wrap text-foreground">
          {set.review_note}
        </blockquote>
      ) : null}

      {canSubmit || canDecide ? (
        <div className="grid gap-2">
          <Label htmlFor={noteId} className="text-xs text-muted-foreground">
            Note (optional)
          </Label>
          <Textarea
            id={noteId}
            value={note}
            maxLength={NOTE_LIMIT}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            {canSubmit ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={pending}
                onClick={() => {
                  onSubmit?.(trimmed);
                  setNote("");
                }}
              >
                <SendIcon />
                Ask for review
              </Button>
            ) : null}
            {canDecide && status !== "rejected" ? (
              <Button
                size="sm"
                variant="danger-outline"
                disabled={pending}
                onClick={() => {
                  onDecide?.("reject", trimmed);
                  setNote("");
                }}
              >
                <XIcon />
                Reject
              </Button>
            ) : null}
            {canDecide && !approvedHere ? (
              <Button
                size="sm"
                variant="primary"
                disabled={pending}
                onClick={() => {
                  onDecide?.("approve", trimmed);
                  setNote("");
                }}
              >
                <CheckIcon />
                Approve revision {set.revision}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {onDecide && isAuthor ? (
        <p className="text-xs text-subtle-foreground">
          You opened this change set or staged changes in it, so someone else reviews it.
        </p>
      ) : null}
    </section>
  );
}

/**
 * A change set's review state as a badge.
 *
 * @param props - The review status.
 * @returns The badge, or nothing for a set nobody asked to review.
 */
export function ReviewBadge({ status }: { status: ChangeSet["review_status"] }) {
  switch (status) {
    case "submitted":
      return <Badge tone="info">in review</Badge>;
    case "approved":
      return <Badge tone="success">approved</Badge>;
    case "rejected":
      return <Badge tone="danger">rejected</Badge>;
    default:
      return null;
  }
}
