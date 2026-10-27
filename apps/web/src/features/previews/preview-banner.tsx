import { Badge } from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import { GitPullRequestIcon } from "lucide-react";
import type { Environment } from "../../lib/api/deploy-types";
import { formatCommit, formatUntil } from "../../lib/format";
import { useNow } from "../../lib/use-now";
import { usePreview } from "../../queries/previews";
import { PREVIEW_STATUS, webUrl } from "./preview-format";

/** Props for {@link PreviewBanner}. */
export interface PreviewBannerProps {
  workspaceId: string;
  projectId: string;
  /** The environment in view; nothing renders unless it belongs to a preview. */
  environment: Pick<Environment, "preview_id" | "pr_number" | "slug"> | undefined;
}

/**
 * The strip above every project page while a preview environment is selected:
 * "Preview for #123 · head abc1234 · expires in 2 days", with links to the pull request
 * and the project's previews.
 *
 * @param props - Ids and the selected environment.
 * @returns The banner, or nothing outside a preview environment.
 */
export function PreviewBanner({ workspaceId, projectId, environment }: PreviewBannerProps) {
  const previewId = environment?.preview_id ?? null;
  const preview = usePreview(previewId);
  const now = useNow(60_000);
  if (!environment || !previewId) return null;
  const data = preview.data;
  const number = data?.pr_number ?? environment.pr_number;
  const href = webUrl(data?.pr_url);
  const ended = data && (data.status === "closed" || data.status === "expired");
  return (
    <section
      aria-label="Preview environment"
      className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-info/40 bg-info/10 px-4 py-2.5 text-sm text-foreground"
    >
      <GitPullRequestIcon className="size-4 shrink-0 text-info" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        Preview for{" "}
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium underline-offset-4 outline-none hover:underline focus-visible:underline"
          >
            #{number}
          </a>
        ) : (
          <span className="font-medium">{number === null ? environment.slug : `#${number}`}</span>
        )}
        {data ? (
          <>
            {" · head "}
            <code className="font-mono text-xs">{formatCommit(data.head_sha)}</code>
            {ended
              ? ` · ${PREVIEW_STATUS[data.status].label.toLowerCase()}`
              : data.expires_at !== null
                ? ` · expires ${formatUntil(data.expires_at, now)}`
                : null}
          </>
        ) : null}
      </p>
      {data?.withheld ? <Badge tone="info">secrets withheld</Badge> : null}
      <Link
        to="/w/$workspaceId/p/$projectId/previews"
        params={{ workspaceId, projectId }}
        className="text-xs text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:underline"
      >
        All previews
      </Link>
    </section>
  );
}
