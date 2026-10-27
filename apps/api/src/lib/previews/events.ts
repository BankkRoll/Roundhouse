/**
 * `pull_request` webhook intake for previews (ADR 0007, "Webhook intake"):
 * reducing a payload to the few fields previews use, and finding the
 * projects it concerns.
 *
 * - {@link parsePullRequestEvent}: validates and copies the fields into a
 *   {@link PreviewEvent} of bounded size, never the whole payload.
 * - {@link matchPreviewProjects}: the projects whose previews track the
 *   PR's base branch through the delivering installation, plus those that
 *   already hold a preview of the PR (a close must reach them even when the
 *   base moved or previews were turned off).
 *
 * @module
 */
import {
  type Db,
  environments,
  previewEnvironments,
  previewSettings,
  projects,
  serviceConfigs,
  services,
  workspaces,
} from "@roundhouse/db";
import { ENDED_PREVIEW_STATUSES, type ServiceSource } from "@roundhouse/shared";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import { normalizeRepoUrl } from "../github";

/** `pull_request` actions previews react to; the others are ignored. */
export const PREVIEW_ACTIONS = [
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
  "converted_to_draft",
  "labeled",
  "edited",
  "closed",
] as const;

/** A handled `pull_request` action. */
export type PreviewAction = (typeof PREVIEW_ACTIONS)[number];

/** The fields of a `pull_request` delivery a preview needs; at most a few hundred bytes. */
export interface PreviewEvent {
  action: PreviewAction;
  number: number;
  title: string;
  html_url: string;
  draft: boolean;
  merged: boolean;
  /** `pull_request.updated_at`, unix ms: the per-PR order key. */
  updated_at: number;
  head: { sha: string; ref: string; repo_full_name: string | null };
  base: {
    ref: string;
    repo_full_name: string;
    clone_url: string;
    /** For `edited`: the base branch before the edit, when it changed. */
    previous_ref: string | null;
  };
  author: { login: string; association: string };
  sender: { login: string; bot: boolean };
  /** For `labeled`: the label added. */
  label: string | null;
  installation_id: number;
}

const SHA_RE = /^([a-f0-9]{40}|[a-f0-9]{64})$/;
const FULL_NAME_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const LOGIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$/;

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
/**
 * A non-empty string cut to `max`, for fields only shown. Fields compared
 * with settings use {@link exact}: a cut value could match what the full
 * one doesn't.
 */
const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;

/** A non-empty string of at most `max` characters, else `null`. */
const exact = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

/**
 * Validates a `pull_request` delivery and copies what previews need.
 *
 * @param payload - The parsed delivery body.
 * @returns The event, or `null` for an action previews ignore or a payload
 *   missing a field they need.
 */
export function parsePullRequestEvent(payload: unknown): PreviewEvent | null {
  const p = obj(payload);
  const pr = obj(p?.pull_request);
  const head = obj(pr?.head);
  const base = obj(pr?.base);
  const baseRepo = obj(base?.repo);
  const headRepo = obj(head?.repo);
  const installation = obj(p?.installation);
  if (!p || !pr || !head || !base || !baseRepo || !installation) return null;
  const action = p.action;
  if (typeof action !== "string" || !(PREVIEW_ACTIONS as readonly string[]).includes(action)) {
    return null;
  }
  const number = pr.number;
  const sha = head.sha;
  const updatedAt = typeof pr.updated_at === "string" ? Date.parse(pr.updated_at) : Number.NaN;
  const installationId = installation.id;
  const baseFullName = exact(baseRepo.full_name, 201);
  const cloneUrl = exact(baseRepo.clone_url, 300);
  const baseRef = exact(base.ref, 255);
  const headRef = str(head.ref, 255);
  const headFullName = headRepo ? exact(headRepo.full_name, 201) : null;
  const user = obj(pr.user);
  const sender = obj(p.sender);
  const authorLogin = exact(user?.login, 60);
  const senderLogin = exact(sender?.login, 60);
  if (
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    typeof sha !== "string" ||
    !SHA_RE.test(sha) ||
    !Number.isFinite(updatedAt) ||
    typeof installationId !== "number" ||
    !Number.isSafeInteger(installationId) ||
    !baseFullName ||
    !FULL_NAME_RE.test(baseFullName) ||
    (headFullName !== null && !FULL_NAME_RE.test(headFullName)) ||
    !cloneUrl ||
    !baseRef ||
    !headRef ||
    !authorLogin ||
    !LOGIN_RE.test(authorLogin) ||
    !senderLogin ||
    !LOGIN_RE.test(senderLogin)
  ) {
    return null;
  }
  const changes = obj(p.changes);
  const previousRef = exact(obj(obj(changes?.base)?.ref)?.from, 255);
  return {
    action: action as PreviewAction,
    number,
    title: typeof pr.title === "string" ? pr.title.slice(0, 256) : "",
    html_url: `https://github.com/${baseFullName}/pull/${number}`,
    draft: pr.draft === true,
    merged: pr.merged === true,
    updated_at: updatedAt,
    head: { sha, ref: headRef, repo_full_name: headFullName },
    base: {
      ref: baseRef,
      repo_full_name: baseFullName,
      clone_url: cloneUrl,
      previous_ref: previousRef,
    },
    author: {
      login: authorLogin,
      association: str(pr.author_association, 40) ?? "NONE",
    },
    sender: { login: senderLogin, bot: sender?.type === "Bot" },
    label: action === "labeled" ? exact(obj(p.label)?.name, 50) : null,
    installation_id: installationId,
  };
}

/** A git service of a base environment that previews build. */
export interface TrackedService {
  serviceId: string;
  source: Extract<ServiceSource, { type: "git" }>;
}

/**
 * The git services of `environmentId` a project's previews build: every git
 * service, or those `scope` names.
 *
 * @param db - Database client.
 * @param projectId - The project.
 * @param environmentId - Its preview base environment.
 * @param scope - `preview_settings.services`.
 * @returns The services with their latest source.
 */
export async function previewGitServices(
  db: Db,
  projectId: string,
  environmentId: string,
  scope: readonly string[] | null,
): Promise<TrackedService[]> {
  const latestVersion = sql`(SELECT MAX(c2.version) FROM service_configs c2 WHERE c2.service_id = ${serviceConfigs.serviceId} AND c2.environment_id = ${serviceConfigs.environmentId})`;
  const rows = await db
    .select({ serviceId: services.id, source: serviceConfigs.source })
    .from(services)
    .innerJoin(
      serviceConfigs,
      and(
        eq(serviceConfigs.serviceId, services.id),
        eq(serviceConfigs.environmentId, environmentId),
      ),
    )
    .where(
      and(
        eq(services.projectId, projectId),
        isNull(services.deletedAt),
        eq(serviceConfigs.version, latestVersion),
      ),
    );
  return rows.flatMap((r) =>
    r.source.type === "git" && (scope === null || scope.includes(r.serviceId))
      ? [{ serviceId: r.serviceId, source: r.source }]
      : [],
  );
}

/**
 * Whether a project's previews track a PR's base: one of its in-scope git
 * services reads the base repository's base branch through the delivering
 * installation, or without any installation (a public repository; the
 * caller has already limited matching to the workspace that claimed the
 * delivering installation, as push deploys are).
 *
 * @param tracked - From {@link previewGitServices}.
 * @param base - The PR's base repository clone URL and branch.
 * @param installationRef - Our `ghi_…` ID of the delivering installation.
 * @returns `true` when previews apply.
 */
export function tracksBase(
  tracked: readonly TrackedService[],
  base: { clone_url: string; ref: string },
  installationRef: string,
): boolean {
  const url = normalizeRepoUrl(base.clone_url);
  return tracked.some(
    (t) =>
      (!t.source.github_installation_id || t.source.github_installation_id === installationRef) &&
      t.source.branch === base.ref &&
      normalizeRepoUrl(t.source.repo_url) === url,
  );
}

/**
 * Projects a `pull_request` delivery concerns, within the workspace that
 * claimed the delivering installation.
 *
 * SECURITY: only that workspace's projects are considered, and a project
 * matches by base branch only through a service that reaches the repository
 * through this installation, so a delivery can never act on another
 * workspace's project.
 *
 * @param db - Database client.
 * @param event - The parsed delivery.
 * @param installation - Our row of the delivering installation.
 * @returns Project IDs, each once.
 */
export async function matchPreviewProjects(
  db: Db,
  event: PreviewEvent,
  installation: { id: string; workspaceId: string },
): Promise<string[]> {
  const live = and(
    eq(projects.workspaceId, installation.workspaceId),
    isNull(projects.deletedAt),
    isNull(workspaces.deletedAt),
  );
  const enabled = await db
    .select({ settings: previewSettings })
    .from(previewSettings)
    .innerJoin(projects, eq(projects.id, previewSettings.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .innerJoin(environments, eq(environments.id, previewSettings.baseEnvironmentId))
    .where(and(live, eq(previewSettings.enabled, true), isNull(environments.retiredAt)));
  const out = new Set<string>();
  for (const { settings } of enabled) {
    const tracked = await previewGitServices(
      db,
      settings.projectId,
      settings.baseEnvironmentId,
      settings.services ?? null,
    );
    if (tracksBase(tracked, event.base, installation.id)) out.add(settings.projectId);
  }
  const existing = await db
    .select({ projectId: previewEnvironments.projectId })
    .from(previewEnvironments)
    .innerJoin(projects, eq(projects.id, previewEnvironments.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(
      and(
        live,
        eq(previewEnvironments.installationRef, installation.id),
        eq(previewEnvironments.repoFullName, event.base.repo_full_name),
        eq(previewEnvironments.prNumber, event.number),
        notInArray(previewEnvironments.status, [...ENDED_PREVIEW_STATUSES]),
      ),
    );
  for (const e of existing) out.add(e.projectId);
  return [...out].sort();
}

/**
 * Whether the instance has received `pull_request` deliveries, for the
 * dashboard's hint that older Apps must subscribe to the event. Delivery
 * IDs are pruned after a while, so any preview ever created counts too.
 *
 * @param db - Database client.
 * @returns `true` once one arrived.
 */
export async function pullRequestEventsSeen(db: Db): Promise<boolean> {
  const row = await db.get<{ n: number }>(
    sql`SELECT 1 AS n WHERE EXISTS (SELECT 1 FROM github_deliveries WHERE event = 'pull_request')
      OR EXISTS (SELECT 1 FROM preview_environments)`,
  );
  return row !== undefined && row !== null;
}
