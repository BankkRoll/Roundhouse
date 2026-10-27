/**
 * The preview state machine (ADR 0007, "Webhook intake" table and "Gate",
 * "Create", "Expiry"): applying one `pull_request` event to a preview row,
 * admitting a preview under `max_active`, and the steps the preview
 * workflow then runs (create, deploy, tear down).
 *
 * {@link applyPreviewEvent} only touches D1 and returns what remains to do,
 * so the workflow can run the slow parts (GitHub, deployments) as their own
 * retried steps. Events are ordered per PR by `pull_request.updated_at`: an
 * event older than the last one applied is dropped, which also covers
 * GitHub delivering out of order.
 *
 * @module
 */
import { type Db, previewEnvironments, projects } from "@roundhouse/db";
import {
  canApprovePreview,
  ENDED_PREVIEW_STATUSES,
  gatePreview,
  isForkPullRequest,
  newId,
  type PreviewStatus,
  RUNNING_PREVIEW_STATUSES,
} from "@roundhouse/shared";
import { and, asc, count, eq, inArray, lte, ne } from "drizzle-orm";
import type { Env } from "../../env";
import { recordAudit } from "../audit";
import type { KeyEnv } from "../crypto";
import type { LifecycleContext } from "../deployments";
import { isUniqueViolation } from "../errors";
import {
  deployPreview,
  ensurePreviewEnvironment,
  PreviewError,
  type PreviewRow,
  teardownPreviewEnvironment,
} from "./environment";
import { type PreviewEvent, previewGitServices, tracksBase } from "./events";
import { loadPreviewSettings, type PreviewSettingsRow } from "./settings";

/** What the preview workflow runs after an event or an action. */
export type PreviewStep = "none" | "create" | "deploy" | "teardown";

/** The outcome of {@link applyPreviewEvent}. */
export interface AppliedEvent {
  previewId: string | null;
  step: PreviewStep;
  /** For `teardown`: the environment to tear down. */
  teardownEnvironmentId: string | null;
  /** A label to remove from the PR: an approval a new fork commit outdated. */
  removeLabel: string | null;
  /** Whether the PR's comment and status should be brought up to date. */
  feedback: boolean;
}

/** The approval label's sender and their permission on the base repository. */
export interface Approver {
  login: string;
  permission: string;
}

const NOTHING: AppliedEvent = {
  previewId: null,
  step: "none",
  teardownEnvironmentId: null,
  removeLabel: null,
  feedback: false,
};

const isEnded = (s: PreviewStatus) => (ENDED_PREVIEW_STATUSES as readonly string[]).includes(s);

async function previewOf(db: Db, projectId: string, repo: string, number: number) {
  const [row] = await db
    .select()
    .from(previewEnvironments)
    .where(
      and(
        eq(previewEnvironments.projectId, projectId),
        eq(previewEnvironments.repoFullName, repo),
        eq(previewEnvironments.prNumber, number),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Applies one `pull_request` event to the project's preview of the PR.
 *
 * @param ctx - Database and bindings.
 * @param input - The project, the event, our ID of the delivering
 *   installation, the approval label sender's permission (looked up with
 *   GitHub for a `labeled` event with the approval label, else `null`), and
 *   the current time.
 * @returns What the workflow must still do.
 */
export async function applyPreviewEvent(
  ctx: { db: Db },
  input: {
    projectId: string;
    event: PreviewEvent;
    installationRef: string;
    approver: Approver | null;
    now: number;
  },
): Promise<AppliedEvent> {
  const { db } = ctx;
  const { event, now } = input;
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);
  if (!project || project.deletedAt) return NOTHING;
  const settings = await loadPreviewSettings(db, project.id);
  const existing = await previewOf(db, project.id, event.base.repo_full_name, event.number);
  // SECURITY: a preview stays bound to the installation it was created
  // through; another installation's delivery for the same name never moves it.
  if (existing && existing.installationRef !== input.installationRef) return NOTHING;
  if (existing && event.updated_at < +existing.lastEventAt) return NOTHING;

  const tracked =
    !!settings?.enabled &&
    tracksBase(
      await previewGitServices(
        db,
        project.id,
        settings.baseEnvironmentId,
        settings.services ?? null,
      ),
      event.base,
      input.installationRef,
    );
  const audit = (
    action: "preview.created" | "preview.gated" | "preview.closed" | "preview.approved",
    previewId: string,
    metadata: Record<string, unknown>,
  ) =>
    recordAudit(db, {
      workspaceId: project.workspaceId,
      actorType: "system",
      actorId: null,
      action,
      targetType: "preview",
      targetId: previewId,
      metadata: {
        repo: event.base.repo_full_name,
        pr_number: event.number,
        head_sha: event.head.sha,
        github_action: event.action,
        github_sender: event.sender.login,
        ...metadata,
      },
    });

  const close = async (row: PreviewRow, reason: string): Promise<AppliedEvent> => {
    const [closed] = await db
      .update(previewEnvironments)
      .set({
        status: "closed",
        environmentId: null,
        expiresAt: null,
        closedAt: new Date(now),
        draft: event.draft,
        lastEventAt: new Date(event.updated_at),
        updatedAt: new Date(now),
      })
      .where(
        and(
          eq(previewEnvironments.id, row.id),
          lte(previewEnvironments.lastEventAt, new Date(event.updated_at)),
        ),
      )
      .returning();
    if (!closed) return NOTHING;
    await audit("preview.closed", row.id, { reason, merged: event.merged });
    return {
      previewId: row.id,
      step: row.environmentId ? "teardown" : "none",
      teardownEnvironmentId: row.environmentId,
      removeLabel: null,
      feedback: true,
    };
  };

  switch (event.action) {
    case "closed":
      if (!existing || isEnded(existing.status)) return NOTHING;
      return close(existing, event.merged ? "merged" : "closed");
    case "converted_to_draft":
      if (!existing || isEnded(existing.status)) return NOTHING;
      if (settings?.skipDrafts ?? true) return close(existing, "draft");
      await touch(db, existing, event, now);
      return NOTHING;
    case "edited":
      if (!existing || isEnded(existing.status)) return NOTHING;
      if (event.base.previous_ref !== null && !tracked) return close(existing, "base_changed");
      await touch(db, existing, event, now);
      return NOTHING;
    default:
      break;
  }

  if (!settings?.enabled || !tracked) return NOTHING;
  const isFork = isForkPullRequest(event.head.repo_full_name, event.base.repo_full_name);
  let approval: { sha: string; login: string } | null = null;
  if (event.action === "labeled") {
    if (event.label !== settings.approvalLabel || !isFork) return NOTHING;
    // SECURITY: the label alone proves nothing; anyone with triage access can
    // add it. GitHub is asked for the sender's permission, server-side, now.
    if (event.sender.bot || !input.approver || !canApprovePreview(input.approver.permission)) {
      if (existing) {
        await audit("preview.gated", existing.id, {
          reason: "approver_lacks_permission",
          permission: input.approver?.permission ?? null,
        });
      }
      return NOTHING;
    }
    approval = { sha: event.head.sha, login: event.sender.login };
  }
  if (event.draft && settings.skipDrafts) {
    if (existing && !isEnded(existing.status)) return close(existing, "draft");
    return NOTHING;
  }

  const fields = {
    installationRef: input.installationRef,
    headRef: event.head.ref,
    headSha: event.head.sha,
    headRepoFullName: event.head.repo_full_name,
    isFork,
    title: event.title,
    authorLogin: event.author.login,
    authorAssociation: event.author.association,
    draft: event.draft,
    lastEventAt: new Date(event.updated_at),
    lastActivityAt: new Date(now),
    updatedAt: new Date(now),
    ...(approval ? { approvedSha: approval.sha, approvedByLogin: approval.login } : {}),
  };
  let row: PreviewRow | undefined;
  if (existing) {
    [row] = await db
      .update(previewEnvironments)
      .set(fields)
      .where(
        and(
          eq(previewEnvironments.id, existing.id),
          lte(previewEnvironments.lastEventAt, new Date(event.updated_at)),
        ),
      )
      .returning();
    if (!row) return NOTHING;
  } else {
    try {
      [row] = await db
        .insert(previewEnvironments)
        .values({
          id: newId("preview"),
          projectId: project.id,
          repoFullName: event.base.repo_full_name,
          prNumber: event.number,
          status: "queued_limit",
          ...fields,
        })
        .returning();
    } catch (err) {
      // A concurrent delivery for the same PR inserted it first; apply on top of it.
      if (!isUniqueViolation(err, "preview_environments.")) throw err;
      return applyPreviewEvent(ctx, input);
    }
  }
  const preview = row!;
  if (approval) await audit("preview.approved", preview.id, { via: "label" });

  // A new fork commit outdates the approval; the label goes so GitHub shows that too.
  const removeLabel =
    isFork && existing?.approvedSha && existing.approvedSha !== event.head.sha && !approval
      ? settings.approvalLabel
      : null;
  const gate = gatePreview({
    isFork,
    forkPolicy: settings.forkPolicy,
    headSha: preview.headSha,
    approvedSha: preview.approvedSha,
  });
  if (gate !== "pass") {
    const status: PreviewStatus = gate;
    const teardown = gate === "fork_disabled" ? preview.environmentId : null;
    await db
      .update(previewEnvironments)
      .set({
        status,
        updatedAt: new Date(now),
        ...(teardown ? { environmentId: null, expiresAt: null } : {}),
      })
      .where(eq(previewEnvironments.id, preview.id));
    if (existing?.status !== status) await audit("preview.gated", preview.id, { reason: gate });
    return {
      previewId: preview.id,
      step: teardown ? "teardown" : "none",
      teardownEnvironmentId: teardown,
      removeLabel,
      feedback: true,
    };
  }
  const admitted = await admitPreview(db, { ...preview }, settings, now);
  if (admitted.status === "queued_limit" && existing?.status !== "queued_limit") {
    await audit("preview.gated", preview.id, {
      reason: "max_active",
      max_active: settings.maxActive,
    });
  }
  if (admitted.step === "create" && existing?.status !== "creating") {
    await audit("preview.created", preview.id, { fork: isFork });
  }
  return {
    previewId: preview.id,
    step: admitted.step,
    teardownEnvironmentId: null,
    removeLabel,
    feedback: true,
  };
}

/** Records an event that changes nothing but the order key and the PR's metadata. */
async function touch(db: Db, row: PreviewRow, event: PreviewEvent, now: number) {
  await db
    .update(previewEnvironments)
    .set({
      title: event.title,
      draft: event.draft,
      lastEventAt: new Date(event.updated_at),
      updatedAt: new Date(now),
    })
    .where(
      and(
        eq(previewEnvironments.id, row.id),
        lte(previewEnvironments.lastEventAt, new Date(event.updated_at)),
      ),
    );
}

/**
 * Lets a preview whose head may be built run: deploy into its live
 * environment, or create one when fewer than `max_active` previews of the
 * project are `creating` or `active`, else queue it (`queued_limit`).
 *
 * @param db - Database client.
 * @param preview - The preview, already past the gate.
 * @param settings - Its project's settings.
 * @param now - Unix ms.
 * @returns Its new status and the step to run.
 */
export async function admitPreview(
  db: Db,
  preview: PreviewRow,
  settings: PreviewSettingsRow,
  now: number,
): Promise<{ status: PreviewStatus; step: PreviewStep }> {
  const expiresAt = new Date(now + settings.ttlHours * 3_600_000);
  if (preview.environmentId && (preview.status === "active" || preview.status === "creating")) {
    await db
      .update(previewEnvironments)
      .set({ status: "active", expiresAt, error: null, updatedAt: new Date(now) })
      .where(eq(previewEnvironments.id, preview.id));
    return { status: "active", step: "deploy" };
  }
  const [running] = await db
    .select({ n: count() })
    .from(previewEnvironments)
    .where(
      and(
        eq(previewEnvironments.projectId, preview.projectId),
        inArray(previewEnvironments.status, [...RUNNING_PREVIEW_STATUSES]),
        ne(previewEnvironments.id, preview.id),
      ),
    );
  if ((running?.n ?? 0) >= settings.maxActive) {
    await db
      .update(previewEnvironments)
      .set({ status: "queued_limit", updatedAt: new Date(now) })
      .where(eq(previewEnvironments.id, preview.id));
    return { status: "queued_limit", step: "none" };
  }
  await db
    .update(previewEnvironments)
    .set({ status: "creating", expiresAt, error: null, closedAt: null, updatedAt: new Date(now) })
    .where(eq(previewEnvironments.id, preview.id));
  return { status: "creating", step: "create" };
}

// -----------------------------------------------------------------------------
// Steps
// -----------------------------------------------------------------------------

/** Loads a preview with its live project and settings, or `null` when any is gone. */
async function loadContext(db: Db, previewId: string) {
  const [row] = await db
    .select({ preview: previewEnvironments, project: projects })
    .from(previewEnvironments)
    .innerJoin(projects, eq(projects.id, previewEnvironments.projectId))
    .where(eq(previewEnvironments.id, previewId))
    .limit(1);
  if (!row || row.project.deletedAt) return null;
  const settings = await loadPreviewSettings(db, row.project.id);
  return settings ? { ...row, settings } : null;
}

/**
 * Creates a `creating` preview's environment and deploys every service;
 * the preview becomes `active`, or `failed` with a reason safe to show.
 * Does nothing once the preview moved on (closed meanwhile, say).
 *
 * @param ctx - Database and bindings.
 * @param keys - Master keyring bindings.
 * @param previewId - The preview.
 * @param origin - Control plane origin, for deployments' commit links.
 * @returns Whether it ran.
 */
export async function runCreateStep(
  ctx: LifecycleContext,
  keys: KeyEnv,
  previewId: string,
  origin: string,
): Promise<boolean> {
  const loaded = await loadContext(ctx.db, previewId);
  if (loaded?.preview.status !== "creating") return false;
  const { preview, project, settings } = loaded;
  try {
    const environmentId = await ensurePreviewEnvironment(ctx, { preview, project, settings, keys });
    await deployPreview(ctx, {
      preview,
      settings,
      environmentId,
      scope: "all",
      origin,
    });
    await ctx.db
      .update(previewEnvironments)
      .set({ status: "active", error: null, updatedAt: new Date() })
      .where(
        and(eq(previewEnvironments.id, preview.id), eq(previewEnvironments.status, "creating")),
      );
    return true;
  } catch (err) {
    const reason =
      err instanceof PreviewError ? err.message : "Creating the preview environment failed";
    if (!(err instanceof PreviewError)) {
      console.error("preview create failed", preview.id, err instanceof Error ? err.name : "error");
    }
    await ctx.db
      .update(previewEnvironments)
      .set({ status: "failed", error: reason, updatedAt: new Date() })
      .where(
        and(eq(previewEnvironments.id, preview.id), eq(previewEnvironments.status, "creating")),
      );
    return false;
  }
}

/**
 * Deploys an `active` preview's git services at the PR's head.
 *
 * @param ctx - Database and bindings.
 * @param previewId - The preview.
 * @param origin - Control plane origin.
 * @returns Deployment IDs started; empty when the preview is not active.
 */
export async function runDeployStep(
  ctx: LifecycleContext,
  previewId: string,
  origin: string,
): Promise<string[]> {
  const loaded = await loadContext(ctx.db, previewId);
  if (loaded?.preview.status !== "active" || !loaded.preview.environmentId) return [];
  try {
    return await deployPreview(ctx, {
      preview: loaded.preview,
      settings: loaded.settings,
      environmentId: loaded.preview.environmentId,
      scope: "git",
      origin,
    });
  } catch (err) {
    if (err instanceof PreviewError) return [];
    throw err;
  }
}

/**
 * Tears a preview's former environment down.
 *
 * @param ctx - Database and bindings.
 * @param projectId - The preview's project.
 * @param environmentId - The environment to tear down.
 */
export function runTeardownStep(
  ctx: LifecycleContext,
  projectId: string,
  environmentId: string,
): Promise<void> {
  return teardownPreviewEnvironment(ctx, projectId, environmentId);
}

// -----------------------------------------------------------------------------
// Minute tick
// -----------------------------------------------------------------------------

/** Previews one tick expires or admits at most. */
const TICK_BATCH = 20;

/**
 * Expires previews past `expires_at` (status `expired`, environment torn
 * down) and admits the oldest queued preview of each project with a free
 * slot. Their comments are updated by preview workflow instances.
 *
 * @param env - Worker bindings.
 * @param db - Database client.
 * @param now - The tick's time, unix ms.
 * @param start - Starts a preview workflow action.
 * @returns How many previews changed.
 */
export async function runPreviewTick(
  env: Env,
  db: Db,
  now: number,
  start: (previewId: string, action: "create" | "feedback") => Promise<void>,
): Promise<number> {
  let changed = 0;
  const due = await db
    .select()
    .from(previewEnvironments)
    .where(
      and(
        inArray(previewEnvironments.status, ["creating", "active", "failed", "pending_approval"]),
        lte(previewEnvironments.expiresAt, new Date(now)),
      ),
    )
    .orderBy(asc(previewEnvironments.expiresAt))
    .limit(TICK_BATCH);
  for (const p of due) {
    const [expired] = await db
      .update(previewEnvironments)
      .set({
        status: "expired",
        environmentId: null,
        expiresAt: null,
        closedAt: new Date(now),
        updatedAt: new Date(now),
      })
      .where(and(eq(previewEnvironments.id, p.id), eq(previewEnvironments.status, p.status)))
      .returning();
    if (!expired) continue;
    changed++;
    const [project] = await db.select().from(projects).where(eq(projects.id, p.projectId)).limit(1);
    if (p.environmentId) {
      await teardownPreviewEnvironment({ db, env }, p.projectId, p.environmentId, now);
    }
    if (project) {
      await recordAudit(db, {
        workspaceId: project.workspaceId,
        actorType: "system",
        actorId: null,
        action: "preview.expired",
        targetType: "preview",
        targetId: p.id,
        metadata: { repo: p.repoFullName, pr_number: p.prNumber },
      });
    }
    await start(p.id, "feedback");
  }

  const queued = await db
    .select()
    .from(previewEnvironments)
    .where(eq(previewEnvironments.status, "queued_limit"))
    .orderBy(asc(previewEnvironments.lastActivityAt))
    .limit(TICK_BATCH);
  for (const p of queued) {
    const settings = await loadPreviewSettings(db, p.projectId);
    if (!settings?.enabled) continue;
    if (p.isFork && p.approvedSha !== p.headSha) continue;
    const admitted = await admitPreview(db, p, settings, now);
    if (admitted.step !== "create") continue;
    changed++;
    await start(p.id, "create");
  }
  return changed;
}
