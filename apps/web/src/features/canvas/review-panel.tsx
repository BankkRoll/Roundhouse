import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Spinner,
} from "@roundhouse/ui";
import { LockIcon, RocketIcon, Undo2Icon } from "lucide-react";
import { useMemo } from "react";
import type { ChangeSet, StagedChange } from "../../lib/api/changes-types";
import { errorMessage, isApiError } from "../../lib/api/client";
import { useReview } from "../../queries/changes";
import { formatSide, groupChanges, pathLabel } from "./diff-format";

/** Props for {@link ReviewPanel}. */
export interface ReviewPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  set: ChangeSet;
  environmentName: string;
  /** The environment is protected, so applying may need a project admin. */
  protectedEnvironment: boolean;
  nameOf: (ref: string) => string;
  /** Present when the caller may edit the set. */
  onUnstage?: (change: StagedChange) => void;
  onResolve?: (change: StagedChange, keep: "mine" | "theirs") => void;
  /** Present when the caller may apply. */
  onApply?: (deploy: "affected" | "none") => void;
  onDiscard?: () => void;
  applying?: boolean;
  /** Error of the last apply, shown at the top. */
  error?: unknown;
}

const REASONS = {
  config: "config changed",
  variables: "variables changed",
  created: "new service",
  references: "references a changed variable",
  volume: "new volume",
} as const;

function ApplyError({ error }: { error: unknown }) {
  if (!error) return null;
  const details = isApiError(error) ? error.details : [];
  return (
    <div
      role="alert"
      className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      <p>{errorMessage(error)}</p>
      {details.length > 1 ? (
        <ul className="mt-1 list-disc pl-4 text-xs">
          {details.map((d) => (
            <li key={`${d.field}:${d.message}`}>{d.message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The review panel for a change set: every staged change grouped by service with its
 * diff (`path`, before, after; variables by tier and fingerprint only), conflicts with
 * Keep mine / Take theirs, the services an apply will deploy, and Apply. Apply is held
 * back while anything conflicts.
 *
 * @param props - The set, its environment and the actions the caller may take.
 * @returns The panel, as a sheet on the right.
 */
export function ReviewPanel({
  open,
  onOpenChange,
  set,
  environmentName,
  protectedEnvironment,
  nameOf,
  onUnstage,
  onResolve,
  onApply,
  onDiscard,
  applying = false,
  error,
}: ReviewPanelProps) {
  const review = useReview(set.id, open);
  const pending = set.changes.filter((c) => c.status !== "applied");
  const groups = useMemo(() => groupChanges(pending, nameOf), [pending, nameOf]);
  const conflicts = pending.filter((c) => c.status === "conflicted");
  const willConflict = new Set(review.data?.conflicts.map((c) => c.id) ?? []);
  const blocked = conflicts.length > 0 || pending.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-0 right-0 left-auto flex h-dvh max-h-dvh w-full max-w-2xl translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-y-0 border-r-0 p-0">
        <header className="border-b border-border px-5 py-4 pr-12">
          <DialogTitle>Review changes</DialogTitle>
          <DialogDescription className="mt-0.5 flex flex-wrap items-center gap-2">
            <span>
              {pending.length} staged change{pending.length === 1 ? "" : "s"} to {environmentName}
            </span>
            <span className="font-mono text-xs text-subtle-foreground">rev {set.revision}</span>
            {protectedEnvironment ? (
              <Badge tone="warning">
                <LockIcon className="size-3" aria-hidden="true" />
                protected
              </Badge>
            ) : null}
          </DialogDescription>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="grid gap-6">
            <ApplyError error={error} />
            {set.error && !error ? (
              <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
                The last apply stopped: {set.error.message}
              </p>
            ) : null}

            {groups.map((group) => (
              <section key={group.key} aria-labelledby={`review-${group.key}`}>
                <h3
                  id={`review-${group.key}`}
                  className="mb-2 font-mono text-[11px] tracking-wider text-muted-foreground uppercase"
                >
                  {group.name}
                </h3>
                <ul className="divide-y divide-border/70 border-y border-border/70">
                  {group.changes.map((change) => {
                    const conflicted =
                      change.status === "conflicted" || willConflict.has(change.id);
                    return (
                      <li key={change.id} className="py-2.5">
                        <div className="flex items-start gap-2">
                          <p className="min-w-0 flex-1 text-sm text-foreground">
                            {change.summary}
                            {conflicted ? (
                              <Badge tone="warning" className="ml-2">
                                conflict
                              </Badge>
                            ) : null}
                          </p>
                          {onUnstage ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Unstage ${change.summary}`}
                              onClick={() => onUnstage(change)}
                            >
                              <Undo2Icon />
                            </Button>
                          ) : null}
                        </div>
                        {change.diff.length ? (
                          <table className="mt-1.5 w-full table-fixed text-xs">
                            <caption className="sr-only">Changes of {change.summary}</caption>
                            <thead className="sr-only">
                              <tr>
                                <th scope="col">Setting</th>
                                <th scope="col">Before</th>
                                <th scope="col">After</th>
                              </tr>
                            </thead>
                            <tbody>
                              {change.diff.map((entry) => (
                                <tr key={entry.path} className="align-top">
                                  <th
                                    scope="row"
                                    className="w-2/5 truncate py-0.5 pr-3 text-left font-mono font-normal text-muted-foreground"
                                  >
                                    {pathLabel(entry.path)}
                                  </th>
                                  <td className="truncate py-0.5 pr-3 font-mono text-danger/90 line-through decoration-danger/40">
                                    {formatSide(entry.before)}
                                  </td>
                                  <td className="truncate py-0.5 font-mono text-success">
                                    {formatSide(entry.after)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : null}
                        {change.status === "conflicted" && onResolve ? (
                          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-warning/10 px-2.5 py-2 text-xs text-warning">
                            <span className="mr-auto">
                              {change.conflict?.deleted
                                ? "What this changes no longer exists."
                                : "Someone changed this since it was staged."}
                            </span>
                            {change.conflict?.deleted ? null : (
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => onResolve(change, "mine")}
                              >
                                Keep mine
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => onResolve(change, "theirs")}
                            >
                              Take theirs
                            </Button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}

            <section aria-labelledby="review-deploys">
              <h3
                id="review-deploys"
                className="mb-2 font-mono text-[11px] tracking-wider text-muted-foreground uppercase"
              >
                Will deploy
              </h3>
              {review.isPending ? (
                <Spinner label="Checking what will deploy" />
              ) : review.data?.deploys.length ? (
                <ul className="grid gap-1 text-sm">
                  {review.data.deploys.map((d) => (
                    <li key={d.service} className="flex items-center gap-2">
                      <RocketIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                      <span className="text-foreground">{d.name}</span>
                      <span className="text-xs text-muted-foreground">{REASONS[d.reason]}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">Nothing needs a new deployment.</p>
              )}
            </section>
          </div>
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          {onDiscard ? (
            <Button variant="ghost" onClick={onDiscard}>
              Discard all
            </Button>
          ) : null}
          {onApply ? (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                disabled={blocked || applying}
                onClick={() => onApply("none")}
              >
                Apply without deploying
              </Button>
              <Button
                variant="primary"
                loading={applying}
                disabled={blocked}
                onClick={() => onApply("affected")}
              >
                {applying ? null : <RocketIcon />}
                Apply and deploy
              </Button>
            </div>
          ) : (
            <p className="ml-auto text-xs text-muted-foreground">
              You can review but not apply these changes.
            </p>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
