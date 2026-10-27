/**
 * Pull request previews (ADR 0007, bound by ADR 0014 section 14): the
 * vocabulary shared by the API, the dashboard and the CLI, and the pure
 * rules every caller must apply the same way.
 *
 * - {@link gatePreview}: whether a pull request's head may be built at all.
 * - {@link previewWithholdsSecrets}: whether secrets stay out of a preview.
 * - {@link clampPreviewConfig}: the resource caps a preview runs under.
 * - Names: {@link previewEnvironmentSlug}, {@link previewCommentMarker},
 *   {@link previewStatusContext}.
 *
 * @module
 */
import type { ServiceConfigSpec } from "./service-config";

// -----------------------------------------------------------------------------
// Vocabulary
// -----------------------------------------------------------------------------

/**
 * Where a preview is in its life:
 * - `pending_approval`: a fork PR waits for someone with write access to
 *   approve its current head.
 * - `fork_disabled`: a fork PR while the project builds no fork PRs.
 * - `queued_limit`: waits for a free slot under `max_active`.
 * - `creating` / `active`: its environment exists and deploys.
 * - `failed`: creating the environment failed; the next event retries.
 * - `expired`: torn down after `ttl_hours` without activity.
 * - `closed`: torn down because the PR closed, merged, became a draft, or
 *   someone deleted it.
 */
export const PREVIEW_STATUSES = [
  "pending_approval",
  "fork_disabled",
  "queued_limit",
  "creating",
  "active",
  "failed",
  "expired",
  "closed",
] as const;

/** A preview's status; see {@link PREVIEW_STATUSES}. */
export type PreviewStatus = (typeof PREVIEW_STATUSES)[number];

/** Statuses that hold an environment and count towards `max_active`. */
export const RUNNING_PREVIEW_STATUSES = [
  "creating",
  "active",
] as const satisfies readonly PreviewStatus[];

/** Statuses of a preview with no environment that a later event can still bring up. */
export const ENDED_PREVIEW_STATUSES = [
  "expired",
  "closed",
] as const satisfies readonly PreviewStatus[];

/**
 * How a project treats PRs from forks:
 * - `disabled` (default): never built; the PR gets a comment saying so.
 * - `approval`: built only once someone with write access approves the
 *   exact head commit, and again for every new commit.
 */
export const PREVIEW_FORK_POLICIES = ["disabled", "approval"] as const;

/** A fork policy; see {@link PREVIEW_FORK_POLICIES}. */
export type PreviewForkPolicy = (typeof PREVIEW_FORK_POLICIES)[number];

/**
 * Secrets of same-repository PRs: `copy` them like a clone (their authors
 * already have write access), or `omit` them like a fork's.
 */
export const PREVIEW_SAME_REPO_SECRETS = ["copy", "omit"] as const;

/** See {@link PREVIEW_SAME_REPO_SECRETS}. */
export type PreviewSameRepoSecrets = (typeof PREVIEW_SAME_REPO_SECRETS)[number];

/**
 * How a preview's databases start: `empty`, or `latest_backup`, a restore of
 * the base environment's latest database dump into the preview's fresh
 * database (its own credentials kept). Never for a preview that withholds
 * secrets: fork PRs always start empty.
 */
export const PREVIEW_DATABASE_SEEDS = ["empty", "latest_backup"] as const;

/** See {@link PREVIEW_DATABASE_SEEDS}. */
export type PreviewDatabaseSeed = (typeof PREVIEW_DATABASE_SEEDS)[number];

/** Upper bounds on what each preview service may use. */
export interface PreviewCaps {
  /** Replicas per service. */
  replicas: number;
  /** Thousandths of a core per replica. */
  cpu_millis: number;
  memory_mb: number;
  /** Size of each volume. */
  volume_mb: number;
}

/** Caps a project starts with. */
export const DEFAULT_PREVIEW_CAPS: PreviewCaps = {
  replicas: 1,
  cpu_millis: 1000,
  memory_mb: 1024,
  volume_mb: 1024,
};

/** Bounds of the numeric preview settings. */
export const PREVIEW_LIMITS = {
  ttlHours: { min: 1, max: 720, default: 72 },
  maxActive: { min: 1, max: 50, default: 5 },
  replicas: { min: 1, max: 10 },
  cpuMillis: { min: 100, max: 16000 },
  memoryMb: { min: 64, max: 65536 },
  volumeMb: { min: 64, max: 102400 },
} as const;

/** The label that approves a fork PR's current head, unless a project sets another. */
export const DEFAULT_PREVIEW_APPROVAL_LABEL = "roundhouse:preview";

// -----------------------------------------------------------------------------
// Names
// -----------------------------------------------------------------------------

/**
 * Slug of the environment of a pull request's preview.
 *
 * @param prNumber - The pull request number.
 * @returns E.g. `pr-42`.
 */
export function previewEnvironmentSlug(prNumber: number): string {
  return `pr-${prNumber}`;
}

/**
 * First line of the one comment a project keeps on a PR, so a lost comment
 * ID is found again by listing the PR's comments.
 *
 * @param projectId - The project.
 * @returns An HTML comment GitHub doesn't render.
 */
export function previewCommentMarker(projectId: string): string {
  return `<!-- roundhouse-preview:${projectId} -->`;
}

/**
 * Commit status context of a project's preview.
 *
 * @param projectSlug - The project's slug.
 * @returns E.g. `roundhouse/preview/shop`.
 */
export function previewStatusContext(projectSlug: string): string {
  return `roundhouse/preview/${projectSlug}`;
}

// -----------------------------------------------------------------------------
// Rules
// -----------------------------------------------------------------------------

/**
 * Whether a PR comes from a fork. A head repository GitHub no longer knows
 * (the fork was deleted) counts as a fork.
 *
 * @param headRepoFullName - `head.repo.full_name`, or `null`.
 * @param baseRepoFullName - `base.repo.full_name`.
 * @returns `true` unless head and base are the same repository.
 */
export function isForkPullRequest(
  headRepoFullName: string | null,
  baseRepoFullName: string,
): boolean {
  return (
    headRepoFullName === null || headRepoFullName.toLowerCase() !== baseRepoFullName.toLowerCase()
  );
}

/**
 * Whether a GitHub collaborator permission may approve a fork PR. GitHub
 * reports `maintain` as `write` on this endpoint; both are accepted.
 *
 * @param permission - `permission` of `GET …/collaborators/{user}/permission`.
 * @returns `true` for `admin`, `maintain` and `write`.
 */
export function canApprovePreview(permission: string | null | undefined): boolean {
  return permission === "admin" || permission === "maintain" || permission === "write";
}

/** What {@link gatePreview} decides. */
export type PreviewGate = "pass" | "fork_disabled" | "pending_approval";

/**
 * Decides whether a PR's head may be built (ADR 0007, "Gate").
 *
 * SECURITY: a fork passes only with an approval of exactly its current head
 * SHA, so every new commit needs a new approval.
 *
 * @param input - Fork or not, the project's fork policy, the head SHA and
 *   the approved SHA.
 * @returns `pass`, or the status the preview waits in.
 * @example
 * gatePreview({ isFork: true, forkPolicy: "approval", headSha: "b", approvedSha: "a" });
 * // "pending_approval"
 */
export function gatePreview(input: {
  isFork: boolean;
  forkPolicy: PreviewForkPolicy;
  headSha: string;
  approvedSha: string | null;
}): PreviewGate {
  if (!input.isFork) return "pass";
  if (input.forkPolicy !== "approval") return "fork_disabled";
  return input.approvedSha !== null && input.approvedSha === input.headSha
    ? "pass"
    : "pending_approval";
}

/**
 * Whether a preview gets placeholders instead of secrets: always for forks,
 * and for same-repository PRs when the project says `omit`.
 *
 * @param isFork - Whether the PR comes from a fork.
 * @param sameRepoSecrets - The project's setting.
 * @returns `true` when secrets are withheld.
 */
export function previewWithholdsSecrets(
  isFork: boolean,
  sameRepoSecrets: PreviewSameRepoSecrets,
): boolean {
  return isFork || sameRepoSecrets === "omit";
}

/**
 * A base environment's config as a preview runs it: replicas, CPU and
 * memory clamped to the caps, the preview node selector merged over the
 * service's own (preview keys win), and on the project's nodes even when
 * the base runs on Cloudflare Containers. Never raises a value.
 *
 * @param spec - The base environment's latest config.
 * @param caps - The project's caps.
 * @param nodeSelector - Labels every preview workload must match.
 * @returns A new spec; `spec` is not modified.
 * @example
 * clampPreviewConfig(spec, { replicas: 1, cpu_millis: 500, memory_mb: 256, volume_mb: 512 }, { pool: "preview" });
 */
export function clampPreviewConfig(
  spec: ServiceConfigSpec,
  caps: PreviewCaps,
  nodeSelector: Readonly<Record<string, string>>,
): ServiceConfigSpec {
  return {
    ...spec,
    deploy: {
      ...spec.deploy,
      // 0 replicas stays 0: a stopped service stays stopped.
      replicas: Math.min(spec.deploy.replicas, caps.replicas),
    },
    resources: {
      cpu_millis: Math.min(spec.resources.cpu_millis, caps.cpu_millis),
      memory_mb: Math.min(spec.resources.memory_mb, caps.memory_mb),
    },
    placement: {
      ...spec.placement,
      // A preview runs on the project's own nodes, in the preview build
      // isolation and under the caps, never on Cloudflare Containers (ADR 0011).
      ...(spec.placement.provider ? { provider: "nodes" as const } : {}),
      node_selector: { ...spec.placement.node_selector, ...nodeSelector },
    },
  };
}
