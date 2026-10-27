/**
 * What previews say to and ask of GitHub (ADR 0007, "GitHub feedback";
 * ADR 0014 section 14): the one comment per PR and project, the commit
 * status, the approval label, and the collaborator permission an approval
 * is checked against.
 *
 * SECURITY: the comment and the status carry statuses, public URLs and
 * commit SHAs only. They are rendered from deployment statuses and
 * generated hostnames, never from variables, failure reasons or logs, so
 * no value or build output can reach a pull request.
 *
 * Every call uses an installation token narrowed to the PR's repository and
 * the permissions it needs, minted only while the project's workspace
 * still holds the installation.
 *
 * @module
 */
import { type Db, previewEnvironments, previewSettings, projects } from "@roundhouse/db";
import { type PreviewStatus, previewCommentMarker, previewStatusContext } from "@roundhouse/shared";
import { eq } from "drizzle-orm";
import type { Env } from "../../env";
import type { KeyEnv } from "../crypto";
import {
  type CommitState,
  createCommitStatus,
  GithubApiError,
  githubAppInfo,
  githubRequest,
  mintRepoToken,
} from "../github";
import { type PreviewServiceView, previewServices } from "./view";

// -----------------------------------------------------------------------------
// Tokens and calls
// -----------------------------------------------------------------------------

/**
 * An installation token for a preview's repository.
 *
 * @param db - Database client.
 * @param keys - Master keyring bindings.
 * @param input - The project's workspace, the preview's installation and repository.
 * @param permissions - What the token may do.
 * @returns The token.
 * @throws When the installation left the workspace or GitHub refuses.
 */
export async function previewToken(
  db: Db,
  keys: KeyEnv,
  input: { workspaceId: string; installationRef: string; repoFullName: string },
  permissions: Record<string, string>,
): Promise<string> {
  const token = await mintRepoToken(db, keys, {
    workspaceId: input.workspaceId,
    installationRef: input.installationRef,
    repoUrl: `https://github.com/${input.repoFullName}`,
    permissions,
  });
  if (!token) throw new Error("No installation token for the repository");
  return token;
}

/**
 * A user's permission on a repository, from
 * `GET /repos/{o}/{r}/collaborators/{user}/permission`.
 *
 * @param token - Installation token with `metadata: read`.
 * @param repoFullName - `owner/repo`.
 * @param login - The GitHub user.
 * @returns `admin`, `write`, `read` or `none`; `none` for a non-collaborator.
 */
export async function collaboratorPermission(
  token: string,
  repoFullName: string,
  login: string,
): Promise<string> {
  try {
    const res = await githubRequest<{ permission?: string }>(
      `/repos/${repoFullName}/collaborators/${encodeURIComponent(login)}/permission`,
      { auth: token },
    );
    return res.permission ?? "none";
  } catch (err) {
    if (err instanceof GithubApiError && err.status === 404) return "none";
    throw err;
  }
}

/**
 * Removes a label from a PR; a label that isn't there is fine.
 *
 * @param token - Installation token with `pull_requests: write`.
 * @param repoFullName - `owner/repo`.
 * @param number - The PR.
 * @param label - The label.
 */
export async function removeLabel(
  token: string,
  repoFullName: string,
  number: number,
  label: string,
): Promise<void> {
  try {
    await githubRequest(
      `/repos/${repoFullName}/issues/${number}/labels/${encodeURIComponent(label)}`,
      { method: "DELETE", auth: token },
    );
  } catch (err) {
    if (!(err instanceof GithubApiError && err.status === 404)) throw err;
  }
}

/**
 * Adds a label to a PR.
 *
 * @param token - Installation token with `pull_requests: write`.
 * @param repoFullName - `owner/repo`.
 * @param number - The PR.
 * @param label - The label.
 */
export async function addLabel(
  token: string,
  repoFullName: string,
  number: number,
  label: string,
): Promise<void> {
  await githubRequest(`/repos/${repoFullName}/issues/${number}/labels`, {
    method: "POST",
    auth: token,
    body: { labels: [label] },
  });
}

// -----------------------------------------------------------------------------
// Comment
// -----------------------------------------------------------------------------

/** What the comment shows. */
export interface PreviewCommentInput {
  projectId: string;
  projectName: string;
  status: PreviewStatus;
  headSha: string;
  approvalLabel: string;
  maxActive: number;
  ttlHours: number;
  expiresAt: number | null;
  services: readonly PreviewServiceView[];
  dashboardUrl: string;
  now: number;
}

const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  building: "Building",
  deploying: "Deploying",
  active: "Ready",
  failed: "Failed",
  crashed: "Crashed",
  cancelled: "Cancelled",
  removed: "Removed",
  rolled_back: "Rolled back",
};

/** Text that can't break out of a Markdown table cell or open HTML. */
function cell(text: string): string {
  return text.replace(/[\\|<>`*_[\]]/g, (c) => `\\${c}`).replace(/\s+/g, " ");
}

const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * Renders the preview comment. Pure.
 *
 * @param input - Statuses, URLs, SHAs and times; nothing secret goes in.
 * @returns Markdown starting with {@link previewCommentMarker}.
 */
export function renderPreviewComment(input: PreviewCommentInput): string {
  const sha = input.headSha.slice(0, 7);
  const lines = [
    previewCommentMarker(input.projectId),
    `### Roundhouse preview · ${cell(input.projectName)}`,
    "",
  ];
  switch (input.status) {
    case "fork_disabled":
      lines.push(
        "This pull request comes from a fork. Previews of fork pull requests are turned off for this project.",
      );
      break;
    case "pending_approval":
      lines.push(
        `This pull request comes from a fork, so commit \`${sha}\` is built only after someone with write access approves it: add the \`${cell(input.approvalLabel)}\` label, or approve it in the dashboard. Every new commit needs a new approval.`,
      );
      break;
    case "queued_limit":
      lines.push(
        `Waiting for a free preview slot: at most ${input.maxActive} previews of this project run at once.`,
      );
      break;
    case "failed":
      lines.push("The preview could not be created. The dashboard shows why.");
      break;
    case "closed":
      lines.push("The preview was torn down.");
      break;
    case "expired":
      lines.push(
        `The preview expired after ${input.ttlHours} hours without activity. Push a commit to create it again.`,
      );
      break;
    default: {
      if (!input.services.length) {
        lines.push(`Deploying commit \`${sha}\`.`);
        break;
      }
      lines.push("| Service | Status | URL | Commit |", "| --- | --- | --- | --- |");
      for (const s of input.services) {
        const status = s.status ? (STATUS_LABEL[s.status] ?? s.status) : "Pending";
        const url = s.url ? `[${cell(new URL(s.url).host)}](${s.url})` : "";
        const commit = s.commit_sha ? `\`${s.commit_sha.slice(0, 7)}\`` : "";
        lines.push(`| ${cell(s.slug)} | ${status} | ${url} | ${commit} |`);
      }
    }
  }
  lines.push("");
  const footer = [`Updated ${utc(input.now)}`];
  if (input.expiresAt && (input.status === "active" || input.status === "creating")) {
    footer.push(`expires ${utc(input.expiresAt)}`);
  }
  footer.push(`[Dashboard](${input.dashboardUrl})`);
  lines.push(footer.join(" · "));
  return lines.join("\n");
}

interface IssueComment {
  id: number;
  body?: string | null;
  user?: { login?: string } | null;
  performed_via_github_app?: { id?: number } | null;
}

/** Most comment pages read when recovering a lost comment ID. */
const MAX_COMMENT_PAGES = 5;

/**
 * Creates or updates the project's comment on a PR. A lost comment ID is
 * recovered by listing the PR's comments for the marker, written by this
 * App, before a new one is posted.
 *
 * @returns The comment ID.
 */
async function upsertComment(
  token: string,
  input: {
    repoFullName: string;
    number: number;
    projectId: string;
    body: string;
    commentId: number | null;
    app: { id: number; slug: string } | null;
  },
): Promise<number> {
  if (input.commentId) {
    try {
      await githubRequest(`/repos/${input.repoFullName}/issues/comments/${input.commentId}`, {
        method: "PATCH",
        auth: token,
        body: { body: input.body },
      });
      return input.commentId;
    } catch (err) {
      if (!(err instanceof GithubApiError && err.status === 404)) throw err;
    }
  }
  const marker = previewCommentMarker(input.projectId);
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const comments = await githubRequest<IssueComment[]>(
      `/repos/${input.repoFullName}/issues/${input.number}/comments?per_page=100&page=${page}`,
      { auth: token },
    );
    // SECURITY: anyone can paste the marker into a comment; only the App's own counts.
    const ours = comments.find(
      (c) =>
        c.body?.startsWith(marker) &&
        input.app &&
        (c.performed_via_github_app?.id === input.app.id ||
          c.user?.login === `${input.app.slug}[bot]`),
    );
    if (ours) {
      await githubRequest(`/repos/${input.repoFullName}/issues/comments/${ours.id}`, {
        method: "PATCH",
        auth: token,
        body: { body: input.body },
      });
      return ours.id;
    }
    if (comments.length < 100) break;
  }
  const created = await githubRequest<{ id: number }>(
    `/repos/${input.repoFullName}/issues/${input.number}/comments`,
    { method: "POST", auth: token, body: { body: input.body } },
  );
  return created.id;
}

// -----------------------------------------------------------------------------
// Commit status
// -----------------------------------------------------------------------------

/**
 * The commit status a preview reports, or `null` for none (gated by policy,
 * or torn down).
 *
 * @param status - The preview's status.
 * @param services - Its services' latest deployments.
 * @returns State and description.
 */
export function previewCommitStatus(
  status: PreviewStatus,
  services: readonly PreviewServiceView[],
): { state: CommitState; description: string } | null {
  switch (status) {
    case "pending_approval":
      return { state: "pending", description: "Waiting for approval to build this fork commit" };
    case "queued_limit":
      return { state: "pending", description: "Waiting for a free preview slot" };
    case "failed":
      return { state: "failure", description: "The preview could not be created" };
    case "creating":
    case "active": {
      const statuses = services.map((s) => s.status);
      if (statuses.some((s) => s === "failed" || s === "crashed")) {
        return { state: "failure", description: "A preview deployment failed" };
      }
      if (statuses.length && statuses.every((s) => s === "active")) {
        return { state: "success", description: "Preview ready" };
      }
      return { state: "pending", description: "Preview deploying" };
    }
    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
// Sync
// -----------------------------------------------------------------------------

/**
 * Brings the PR's comment and commit status up to date with the preview.
 * Best effort: GitHub being down or the App lacking a permission never
 * fails what called it.
 *
 * @param env - Worker bindings (master keys).
 * @param db - Database client.
 * @param previewId - The preview.
 * @param origin - Control plane origin, for the dashboard link.
 * @returns Whether GitHub took every update.
 */
export async function syncPreviewFeedback(
  env: Env,
  db: Db,
  previewId: string,
  origin: string,
): Promise<boolean> {
  const [row] = await db
    .select({ preview: previewEnvironments, project: projects, settings: previewSettings })
    .from(previewEnvironments)
    .innerJoin(projects, eq(projects.id, previewEnvironments.projectId))
    .leftJoin(previewSettings, eq(previewSettings.projectId, previewEnvironments.projectId))
    .where(eq(previewEnvironments.id, previewId))
    .limit(1);
  if (!row || row.project.deletedAt) return false;
  const { preview, project, settings } = row;
  const services = await previewServices(db, preview.environmentId);
  const dashboardUrl = `${origin}/w/${project.workspaceId}/p/${project.id}/previews`;
  try {
    const token = await previewToken(
      db,
      env,
      {
        workspaceId: project.workspaceId,
        installationRef: preview.installationRef,
        repoFullName: preview.repoFullName,
      },
      { pull_requests: "write", statuses: "write" },
    );
    const status = previewCommitStatus(preview.status, services);
    if (status) {
      await createCommitStatus(token, preview.repoFullName, preview.headSha, {
        ...status,
        target_url: dashboardUrl,
        context: previewStatusContext(project.slug),
      });
    }
    if (settings?.comment ?? true) {
      const body = renderPreviewComment({
        projectId: project.id,
        projectName: project.name,
        status: preview.status,
        headSha: preview.headSha,
        approvalLabel: settings?.approvalLabel ?? "",
        maxActive: settings?.maxActive ?? 0,
        ttlHours: settings?.ttlHours ?? 0,
        expiresAt: preview.expiresAt ? +preview.expiresAt : null,
        services,
        dashboardUrl,
        now: Date.now(),
      });
      const app = await githubAppInfo(db);
      const id = await upsertComment(token, {
        repoFullName: preview.repoFullName,
        number: preview.prNumber,
        projectId: project.id,
        body,
        commentId: preview.githubCommentId,
        app: app ? { id: app.id, slug: app.slug } : null,
      });
      if (id !== preview.githubCommentId) {
        await db
          .update(previewEnvironments)
          .set({ githubCommentId: id })
          .where(eq(previewEnvironments.id, preview.id));
      }
    }
    return true;
  } catch (err) {
    console.warn("preview feedback failed", preview.id, err instanceof Error ? err.message : err);
    return false;
  }
}
