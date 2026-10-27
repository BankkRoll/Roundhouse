/**
 * Pull request preview routes (ADR 0007): settings, the list, approving a
 * fork PR's head, redeploying, and tearing a preview down. Previews are
 * created by the `pull_request` webhook; see `lib/previews`.
 *
 * @module
 */
import { previewEnvironments } from "@roundhouse/db";
import { type Action, ENDED_PREVIEW_STATUSES, gatePreview } from "@roundhouse/shared";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { type AppContext, clientIp, createRouter, originOf } from "../context";
import {
  approvePreview,
  deletePreview,
  getPreview,
  getPreviewSettings,
  listPreviews,
  policyOf,
  putPreviewSettings,
  redeployPreview,
} from "../contracts";
import { recordAudit } from "../lib/audit";
import { ApiError, conflict, notFound } from "../lib/errors";
import { admitPreview } from "../lib/previews/engine";
import { teardownPreviewEnvironment } from "../lib/previews/environment";
import {
  loadPreviewSettings,
  savePreviewSettings,
  toApiPreviewSettings,
} from "../lib/previews/settings";
import { findPreview, toApiPreview } from "../lib/previews/view";
import { projectScope } from "../lib/scope";
import { startPreviewAction } from "../workflows/preview";

/** Loads a preview of a live project and authorizes the caller on that project. */
async function previewScope(c: AppContext, previewId: string, action: Action) {
  const preview = await findPreview(c.get("db"), previewId);
  if (!preview) throw notFound("Preview");
  try {
    const scope = await projectScope(c, preview.projectId, action);
    return { preview, ...scope };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) throw notFound("Preview");
    throw err;
  }
}

/** Preview routes. */
export const previewRoutes = createRouter()
  .openapi(getPreviewSettings, async (c) => {
    const { projectId } = c.req.valid("param");
    await projectScope(c, projectId, policyOf(getPreviewSettings).action!);
    const db = c.get("db");
    return c.json(
      await toApiPreviewSettings(db, projectId, await loadPreviewSettings(db, projectId)),
      200,
    );
  })
  .openapi(putPreviewSettings, async (c) => {
    const { projectId } = c.req.valid("param");
    const { project, caller } = await projectScope(
      c,
      projectId,
      policyOf(putPreviewSettings).action!,
    );
    const body = c.req.valid("json");
    const db = c.get("db");
    const row = await savePreviewSettings(db, projectId, body);
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "preview.settings_updated",
      targetType: "project",
      targetId: projectId,
      metadata: {
        enabled: row.enabled,
        base_environment_id: row.baseEnvironmentId,
        services: row.services,
        fork_policy: row.forkPolicy,
        same_repo_secrets: row.sameRepoSecrets,
        max_active: row.maxActive,
        ttl_hours: row.ttlHours,
      },
      ip: clientIp(c),
    });
    return c.json(await toApiPreviewSettings(db, projectId, row), 200);
  })
  .openapi(listPreviews, async (c) => {
    const { projectId } = c.req.valid("param");
    const { status } = c.req.valid("query");
    await projectScope(c, projectId, policyOf(listPreviews).action!);
    const db = c.get("db");
    const rows = await db
      .select()
      .from(previewEnvironments)
      .where(
        and(
          eq(previewEnvironments.projectId, projectId),
          status === "open"
            ? notInArray(previewEnvironments.status, [...ENDED_PREVIEW_STATUSES])
            : undefined,
        ),
      )
      .orderBy(desc(previewEnvironments.lastActivityAt))
      .limit(200);
    const previews = [];
    for (const r of rows) previews.push(await toApiPreview(db, r));
    return c.json({ previews }, 200);
  })
  .openapi(getPreview, async (c) => {
    const { previewId } = c.req.valid("param");
    const { preview } = await previewScope(c, previewId, policyOf(getPreview).action!);
    return c.json(await toApiPreview(c.get("db"), preview), 200);
  })
  .openapi(approvePreview, async (c) => {
    const { previewId } = c.req.valid("param");
    const { head_sha } = c.req.valid("json");
    const { preview, project, caller } = await previewScope(
      c,
      previewId,
      policyOf(approvePreview).action!,
    );
    const db = c.get("db");
    const settings = await loadPreviewSettings(db, project.id);
    if (!settings?.enabled) throw conflict("Previews are turned off for this project");
    if (preview.status !== "pending_approval") {
      throw conflict(
        `The preview is ${preview.status.replace(/_/g, " ")}, not waiting for approval`,
      );
    }
    if (preview.headSha !== head_sha) {
      throw new ApiError(
        409,
        "head_moved",
        "The pull request has new commits since you looked; review them and approve again",
      );
    }
    const now = Date.now();
    // Bound to the head the approver saw: a push landing meanwhile matches nothing.
    const [approved] = await db
      .update(previewEnvironments)
      .set({
        approvedSha: head_sha,
        approvedByLogin: caller.user.name || caller.user.email,
        lastActivityAt: new Date(now),
        updatedAt: new Date(now),
      })
      .where(
        and(
          eq(previewEnvironments.id, preview.id),
          eq(previewEnvironments.headSha, head_sha),
          eq(previewEnvironments.status, "pending_approval"),
        ),
      )
      .returning();
    if (!approved) {
      throw new ApiError(409, "head_moved", "The pull request changed meanwhile; reload and retry");
    }
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "preview.approved",
      targetType: "preview",
      targetId: preview.id,
      metadata: {
        repo: preview.repoFullName,
        pr_number: preview.prNumber,
        head_sha,
        via: "dashboard",
      },
      ip: clientIp(c),
    });
    const gate = gatePreview({
      isFork: approved.isFork,
      forkPolicy: settings.forkPolicy,
      headSha: approved.headSha,
      approvedSha: approved.approvedSha,
    });
    const admitted =
      gate === "pass"
        ? await admitPreview(db, approved, settings, now)
        : { status: approved.status, step: "none" as const };
    await startPreviewAction(c.env, {
      kind: "action",
      preview_id: preview.id,
      origin: originOf(c),
      action: "approve",
      next: admitted.step,
    });
    return c.json(await toApiPreview(db, (await findPreview(db, preview.id))!), 200);
  })
  .openapi(redeployPreview, async (c) => {
    const { previewId } = c.req.valid("param");
    const { preview, project, caller } = await previewScope(
      c,
      previewId,
      policyOf(redeployPreview).action!,
    );
    if (preview.status !== "active" || !preview.environmentId) {
      throw conflict("Only an active preview can be redeployed");
    }
    // The preview's environment is the protection scope; checked like a deploy there.
    await projectScope(c, project.id, "deployments:create", preview.environmentId);
    const db = c.get("db");
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "deployment.created",
      targetType: "preview",
      targetId: preview.id,
      metadata: {
        environment_id: preview.environmentId,
        trigger: "preview_redeploy",
        head_sha: preview.headSha,
      },
      ip: clientIp(c),
    });
    await startPreviewAction(c.env, {
      kind: "action",
      preview_id: preview.id,
      origin: originOf(c),
      action: "deploy",
    });
    return c.json(await toApiPreview(db, preview), 200);
  })
  .openapi(deletePreview, async (c) => {
    const { previewId } = c.req.valid("param");
    const { preview, project, caller } = await previewScope(
      c,
      previewId,
      policyOf(deletePreview).action!,
    );
    const db = c.get("db");
    const now = Date.now();
    const [closed] = await db
      .update(previewEnvironments)
      .set({
        status: "closed",
        environmentId: null,
        expiresAt: null,
        closedAt: preview.closedAt ?? new Date(now),
        updatedAt: new Date(now),
      })
      .where(eq(previewEnvironments.id, preview.id))
      .returning();
    if (preview.environmentId) {
      await teardownPreviewEnvironment({ db, env: c.env }, project.id, preview.environmentId, now);
    }
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "preview.deleted",
      targetType: "preview",
      targetId: preview.id,
      metadata: {
        repo: preview.repoFullName,
        pr_number: preview.prNumber,
        environment_id: preview.environmentId,
      },
      ip: clientIp(c),
    });
    await startPreviewAction(c.env, {
      kind: "action",
      preview_id: preview.id,
      origin: originOf(c),
      action: "feedback",
    });
    return c.json(await toApiPreview(db, closed!), 200);
  });
