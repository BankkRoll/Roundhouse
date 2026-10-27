/**
 * Project canvas and staged change routes (ADR 0006). The logic lives in
 * `lib/changes/*`, shared with the MCP tools; handlers resolve scope, call
 * it, publish, and serialise.
 *
 * @module
 */
import { changeSets, environments, projects } from "@roundhouse/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { type AppContext, clientIp, createRouter, requireKeys, visibleProjects } from "../context";
import {
  addServiceEdge,
  applyChangeSet,
  approveChangeSet,
  createChangeSet,
  discardChangeSet,
  getCanvas,
  getChangeSet,
  getDraft,
  listChangeSets,
  listWorkspaceChangeSets,
  policyOf,
  rebaseChangeSet,
  rejectChangeSet,
  removeServiceEdge,
  resolveOp,
  reviewChangeSet,
  stageDraftOp,
  stageOp,
  submitChangeSet,
  unstageOp,
  updateCanvasLayout,
} from "../contracts";
import { recordAudit } from "../lib/audit";
import { applySet, reviewSet } from "../lib/changes/apply";
import { buildCanvas, updateLayout } from "../lib/changes/canvas";
import { addEdge, removeEdge, toApiEdge } from "../lib/changes/edges";
import {
  assertCanEdit,
  decideSet,
  rebaseSet,
  requiresApproval,
  submitSet,
} from "../lib/changes/review";
import {
  authorizeStaging,
  discardSet,
  resolveConflict,
  type StagingContext,
  stageIntoSet,
  unstage,
} from "../lib/changes/staging";
import {
  type ChangeSetRow,
  changeSetScope,
  draftFor,
  environmentScope,
  findDraft,
  loadOps,
  openChangeSet,
  presentChangeSet,
  publishChangeSet,
  toApiChangeSetSummary,
} from "../lib/changes/store";
import { notFound } from "../lib/errors";
import { publish } from "../lib/realtime";
import { environmentOf, projectScope } from "../lib/scope";

/** Most sets `status=all` lists. */
const LIST_LIMIT = 50;

/** Most sets the workspace review queue lists. */
const QUEUE_LIMIT = 100;

async function stagingContext(c: AppContext, changeSetId: string) {
  const scope = await changeSetScope(c, changeSetId, "projects:read");
  const ctx: StagingContext = {
    c,
    db: c.get("db"),
    keys: requireKeys(c),
    project: scope.project,
    environment: scope.environment,
    caller: scope.caller,
  };
  return { ...scope, ctx };
}

async function respond(c: AppContext, set: ChangeSetRow) {
  const db = c.get("db");
  await publishChangeSet(c.env, db, set);
  return presentChangeSet(db, set);
}

/** Canvas and change set routes. */
export const changeRoutes = createRouter()
  .openapi(getCanvas, async (c) => {
    const { projectId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    const { project } = await projectScope(c, projectId, policyOf(getCanvas).action!);
    const environment = await environmentOf(c, project.id, environment_id);
    const canvas = await buildCanvas({
      db: c.get("db"),
      keys: requireKeys(c),
      project,
      environment,
    });
    return c.json(canvas, 200);
  })
  .openapi(updateCanvasLayout, async (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { project, caller } = await projectScope(
      c,
      projectId,
      policyOf(updateCanvasLayout).action!,
    );
    const layout = await updateLayout(
      c.get("db"),
      project.id,
      body.positions,
      body.expected_version,
    );
    await publish(c.env, project.id, {
      type: "canvas.layout_updated",
      positions: layout.positions,
      version: layout.version,
      by_user_id: caller.user.id,
    });
    return c.json(layout, 200);
  })
  .openapi(addServiceEdge, async (c) => {
    const { projectId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { project, caller } = await projectScope(c, projectId, policyOf(addServiceEdge).action!);
    const db = c.get("db");
    const edge = await addEdge(db, {
      projectId: project.id,
      from: body.from_service_id,
      to: body.to_service_id,
      userId: caller.user.id,
    });
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "canvas.edge_added",
      targetType: "project",
      targetId: project.id,
      metadata: { edge_id: edge.id, from: edge.fromServiceId, to: edge.toServiceId },
      ip: clientIp(c),
    });
    await publish(c.env, project.id, { type: "canvas.edges_updated", by_user_id: caller.user.id });
    return c.json(toApiEdge(edge), 201);
  })
  .openapi(removeServiceEdge, async (c) => {
    const { projectId, edgeId } = c.req.valid("param");
    const { project, caller } = await projectScope(
      c,
      projectId,
      policyOf(removeServiceEdge).action!,
    );
    const db = c.get("db");
    const edge = await removeEdge(db, project.id, edgeId);
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "canvas.edge_removed",
      targetType: "project",
      targetId: project.id,
      metadata: { edge_id: edge.id, from: edge.fromServiceId, to: edge.toServiceId },
      ip: clientIp(c),
    });
    await publish(c.env, project.id, { type: "canvas.edges_updated", by_user_id: caller.user.id });
    return c.body(null, 204);
  })
  .openapi(listChangeSets, async (c) => {
    const { environmentId } = c.req.valid("param");
    const { status } = c.req.valid("query");
    const { environment } = await environmentScope(
      c,
      environmentId,
      policyOf(listChangeSets).action!,
    );
    const db = c.get("db");
    const sets = await db
      .select()
      .from(changeSets)
      .where(
        and(
          eq(changeSets.environmentId, environment.id),
          ...(status === "open" ? [inArray(changeSets.status, ["open", "applying"])] : []),
        ),
      )
      .orderBy(desc(changeSets.id))
      .limit(LIST_LIMIT);
    const summaries = await Promise.all(
      sets.map(async (s) => toApiChangeSetSummary(s, await loadOps(db, s.id))),
    );
    return c.json(
      { change_sets: summaries, environment_requires_approval: requiresApproval(environment) },
      200,
    );
  })
  .openapi(listWorkspaceChangeSets, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const { review } = c.req.valid("query");
    const visible = await visibleProjects(c, workspaceId, "projects:read");
    if (!visible.size) return c.json({ change_sets: [] }, 200);
    const db = c.get("db");
    const rows = await db
      .select({ set: changeSets, environment: environments, projectName: projects.name })
      .from(changeSets)
      .innerJoin(environments, eq(environments.id, changeSets.environmentId))
      .innerJoin(projects, eq(projects.id, changeSets.projectId))
      .where(
        and(
          inArray(changeSets.projectId, [...visible]),
          inArray(changeSets.status, ["open", "applying"]),
          ...(review === "pending" ? [eq(changeSets.reviewStatus, "submitted")] : []),
        ),
      )
      .orderBy(desc(changeSets.updatedAt), desc(changeSets.id))
      .limit(QUEUE_LIMIT);
    const out = await Promise.all(
      rows.map(async (r) => ({
        ...toApiChangeSetSummary(r.set, await loadOps(db, r.set.id)),
        project_name: r.projectName,
        environment_name: r.environment.name,
        environment_requires_approval: requiresApproval(r.environment),
      })),
    );
    // A draft nothing is staged in yet is noise in a review queue.
    return c.json({ change_sets: out.filter((s) => s.op_count > 0) }, 200);
  })
  .openapi(createChangeSet, async (c) => {
    const { environmentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { environment, project, caller } = await environmentScope(
      c,
      environmentId,
      policyOf(createChangeSet).action!,
    );
    assertCanEdit(caller);
    for (const op of body.ops) authorizeStaging(caller, op);
    const db = c.get("db");
    const ctx: StagingContext = {
      c,
      db,
      keys: requireKeys(c),
      project,
      environment,
      caller,
    };
    let set = await openChangeSet(db, {
      projectId: project.id,
      environmentId: environment.id,
      source: body.source,
      isDraft: false,
      caller,
      title: body.title ?? null,
    });
    try {
      for (const op of body.ops) set = await stageIntoSet(ctx, set, op);
    } catch (err) {
      // An API client gets the whole set or nothing.
      await db.delete(changeSets).where(eq(changeSets.id, set.id));
      throw err;
    }
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "change_set.created",
      targetType: "change_set",
      targetId: set.id,
      metadata: {
        project_id: project.id,
        environment_id: environment.id,
        source: body.source,
        ops: body.ops.length,
      },
      ip: clientIp(c),
    });
    return c.json(await respond(c, set), 201);
  })
  .openapi(getDraft, async (c) => {
    const { environmentId } = c.req.valid("param");
    const { environment } = await environmentScope(c, environmentId, policyOf(getDraft).action!);
    const db = c.get("db");
    const draft = await findDraft(db, environment.id);
    return c.json({ change_set: draft ? await presentChangeSet(db, draft) : null }, 200);
  })
  .openapi(stageDraftOp, async (c) => {
    const { environmentId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { environment, project, caller } = await environmentScope(
      c,
      environmentId,
      policyOf(stageDraftOp).action!,
    );
    authorizeStaging(caller, body.op);
    const db = c.get("db");
    const ctx: StagingContext = {
      c,
      db,
      keys: requireKeys(c),
      project,
      environment,
      caller,
    };
    const draft = await draftFor(db, environment, caller);
    const set = await stageIntoSet(ctx, draft, body.op, body.expected_revision);
    return c.json(await respond(c, set), 200);
  })
  .openapi(getChangeSet, async (c) => {
    const { changeSetId } = c.req.valid("param");
    const { set } = await changeSetScope(c, changeSetId, policyOf(getChangeSet).action!);
    return c.json(await presentChangeSet(c.get("db"), set), 200);
  })
  .openapi(reviewChangeSet, async (c) => {
    const { changeSetId } = c.req.valid("param");
    const { set, project, environment } = await changeSetScope(
      c,
      changeSetId,
      policyOf(reviewChangeSet).action!,
    );
    const db = c.get("db");
    const review = await reviewSet({ c, db, env: c.env, project, environment }, set);
    return c.json(
      {
        change_set: await presentChangeSet(db, set),
        rebases: review.rebases,
        conflicts: review.conflicts,
        deploys: review.deploys,
        approval: review.approval,
      },
      200,
    );
  })
  .openapi(stageOp, async (c) => {
    const { changeSetId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { set, ctx } = await stagingContext(c, changeSetId);
    const updated = await stageIntoSet(ctx, set, body.op, body.expected_revision);
    return c.json(await respond(c, updated), 200);
  })
  .openapi(unstageOp, async (c) => {
    const { changeSetId, opId } = c.req.valid("param");
    const { expected_revision } = c.req.valid("query");
    const { set, ctx } = await stagingContext(c, changeSetId);
    const row = (await loadOps(ctx.db, set.id)).find((r) => r.id === opId);
    if (!row) throw notFound("Staged change");
    authorizeStaging(ctx.caller, row.op);
    const updated = await unstage(ctx.db, set, opId, expected_revision);
    return c.json(await respond(c, updated), 200);
  })
  .openapi(resolveOp, async (c) => {
    const { changeSetId, opId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { set, ctx } = await stagingContext(c, changeSetId);
    const updated = await resolveConflict(ctx, set, opId, body.keep, body.expected_revision);
    return c.json(await respond(c, updated), 200);
  })
  .openapi(rebaseChangeSet, async (c) => {
    const { changeSetId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { set, ctx } = await stagingContext(c, changeSetId);
    const result = await rebaseSet(ctx, {
      set,
      caller: ctx.caller,
      expectedRevision: body.expected_revision,
    });
    return c.json(
      {
        change_set: await respond(c, result.set),
        rebased: result.rebased,
        conflicts: result.conflicts,
      },
      200,
    );
  })
  .openapi(submitChangeSet, async (c) => {
    const { changeSetId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { set, project, caller } = await changeSetScope(
      c,
      changeSetId,
      policyOf(submitChangeSet).action!,
    );
    const submitted = await submitSet(c.get("db"), {
      set,
      project,
      caller,
      ...(body.expected_revision !== undefined ? { expectedRevision: body.expected_revision } : {}),
      ...(body.note !== undefined ? { note: body.note } : {}),
      ip: clientIp(c),
    });
    return c.json(await respond(c, submitted), 200);
  })
  .openapi(approveChangeSet, async (c) => {
    const { changeSetId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { set, project, caller } = await changeSetScope(
      c,
      changeSetId,
      policyOf(approveChangeSet).action!,
    );
    const approved = await decideSet(c.get("db"), {
      set,
      project,
      caller,
      decision: "approve",
      expectedRevision: body.expected_revision,
      ...(body.note !== undefined ? { note: body.note } : {}),
      ip: clientIp(c),
    });
    return c.json(await respond(c, approved), 200);
  })
  .openapi(rejectChangeSet, async (c) => {
    const { changeSetId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { set, project, caller } = await changeSetScope(
      c,
      changeSetId,
      policyOf(rejectChangeSet).action!,
    );
    const rejected = await decideSet(c.get("db"), {
      set,
      project,
      caller,
      decision: "reject",
      expectedRevision: body.expected_revision,
      ...(body.note !== undefined ? { note: body.note } : {}),
      ip: clientIp(c),
    });
    return c.json(await respond(c, rejected), 200);
  })
  .openapi(applyChangeSet, async (c) => {
    const { changeSetId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { set, project, environment } = await changeSetScope(
      c,
      changeSetId,
      policyOf(applyChangeSet).action!,
    );
    const db = c.get("db");
    const result = await applySet({ c, db, env: c.env, project, environment }, set, {
      expectedRevision: body.expected_revision,
      deploy: body.deploy,
    });
    return c.json(
      {
        change_set: await presentChangeSet(db, result.set),
        deployment_ids: result.deploymentIds,
        skipped: result.skipped,
      },
      200,
    );
  })
  .openapi(discardChangeSet, async (c) => {
    const { changeSetId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { set, project, caller } = await changeSetScope(
      c,
      changeSetId,
      policyOf(discardChangeSet).action!,
    );
    assertCanEdit(caller);
    const db = c.get("db");
    const discarded = await discardSet(db, {
      set,
      project,
      caller,
      ...(body.expected_revision !== undefined ? { expectedRevision: body.expected_revision } : {}),
      ip: clientIp(c),
    });
    return c.json(await respond(c, discarded), 200);
  });
