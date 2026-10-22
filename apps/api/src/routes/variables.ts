/**
 * Service and shared variables. Values are sealed with the project's data
 * key; secrets are masked on every read and only returned by the reveal
 * routes, which audit the keys (never the values). Reference syntax is
 * checked on write; unknown targets and cycles surface at deploy time.
 *
 * @module
 */
import { clientIp, createRouter, requireMasterKey } from "../context";
import {
  listServiceVariables,
  listSharedVariables,
  policyOf,
  putServiceVariables,
  putSharedVariables,
  revealServiceVariables,
  revealSharedVariables,
} from "../contracts";
import { recordAudit } from "../lib/audit";
import { environmentOf, projectScope, serviceScope } from "../lib/scope";
import {
  assertValidReferences,
  listVariables,
  projectKey,
  putVariables,
  revealVariables,
  type VariableTarget,
} from "../lib/variables";

/** Variable routes. */
export const variableRoutes = createRouter()
  .openapi(listServiceVariables, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    const { project } = await serviceScope(c, serviceId, policyOf(listServiceVariables).action!);
    await environmentOf(c, project.id, environment_id);
    const db = c.get("db");
    const target: VariableTarget = {
      projectId: project.id,
      environmentId: environment_id,
      scope: "service",
      serviceId,
    };
    const key = await projectKey(db, requireMasterKey(c), project.id);
    return c.json({ variables: await listVariables(db, key, target) }, 200);
  })
  .openapi(putServiceVariables, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    const body = c.req.valid("json");
    const { project, caller } = await serviceScope(
      c,
      serviceId,
      policyOf(putServiceVariables).action!,
    );
    await environmentOf(c, project.id, environment_id);
    assertValidReferences(body.set);
    const db = c.get("db");
    const target: VariableTarget = {
      projectId: project.id,
      environmentId: environment_id,
      scope: "service",
      serviceId,
    };
    const key = await projectKey(db, requireMasterKey(c), project.id);
    const changed = await putVariables(db, key, target, body);
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      actorType: "user",
      actorId: caller.user.id,
      action: "variables.updated",
      targetType: "service",
      targetId: serviceId,
      metadata: { environment_id, set: changed.set, deleted: changed.deleted },
      ip: clientIp(c),
    });
    return c.json({ variables: await listVariables(db, key, target) }, 200);
  })
  .openapi(revealServiceVariables, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    const { keys } = c.req.valid("json");
    const { project, caller } = await serviceScope(
      c,
      serviceId,
      policyOf(revealServiceVariables).action!,
    );
    await environmentOf(c, project.id, environment_id);
    const db = c.get("db");
    const key = await projectKey(db, requireMasterKey(c), project.id);
    const revealed = await revealVariables(
      db,
      key,
      { projectId: project.id, environmentId: environment_id, scope: "service", serviceId },
      keys,
    );
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      actorType: "user",
      actorId: caller.user.id,
      action: "variables.revealed",
      targetType: "service",
      targetId: serviceId,
      metadata: { environment_id, keys: revealed.map((v) => v.key) },
      ip: clientIp(c),
    });
    return c.json({ variables: revealed }, 200);
  })
  .openapi(listSharedVariables, async (c) => {
    const { projectId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    const { project } = await projectScope(c, projectId, policyOf(listSharedVariables).action!);
    await environmentOf(c, project.id, environment_id);
    const db = c.get("db");
    const key = await projectKey(db, requireMasterKey(c), project.id);
    const target: VariableTarget = {
      projectId,
      environmentId: environment_id,
      scope: "shared",
      serviceId: null,
    };
    return c.json({ variables: await listVariables(db, key, target) }, 200);
  })
  .openapi(putSharedVariables, async (c) => {
    const { projectId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    const body = c.req.valid("json");
    const { project, caller } = await projectScope(
      c,
      projectId,
      policyOf(putSharedVariables).action!,
    );
    await environmentOf(c, project.id, environment_id);
    assertValidReferences(body.set);
    const db = c.get("db");
    const key = await projectKey(db, requireMasterKey(c), project.id);
    const target: VariableTarget = {
      projectId,
      environmentId: environment_id,
      scope: "shared",
      serviceId: null,
    };
    const changed = await putVariables(db, key, target, body);
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      actorType: "user",
      actorId: caller.user.id,
      action: "variables.updated",
      targetType: "project",
      targetId: projectId,
      metadata: { environment_id, scope: "shared", set: changed.set, deleted: changed.deleted },
      ip: clientIp(c),
    });
    return c.json({ variables: await listVariables(db, key, target) }, 200);
  })
  .openapi(revealSharedVariables, async (c) => {
    const { projectId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    const { keys } = c.req.valid("json");
    const { project, caller } = await projectScope(
      c,
      projectId,
      policyOf(revealSharedVariables).action!,
    );
    await environmentOf(c, project.id, environment_id);
    const db = c.get("db");
    const key = await projectKey(db, requireMasterKey(c), project.id);
    const revealed = await revealVariables(
      db,
      key,
      { projectId, environmentId: environment_id, scope: "shared", serviceId: null },
      keys,
    );
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      actorType: "user",
      actorId: caller.user.id,
      action: "variables.revealed",
      targetType: "project",
      targetId: projectId,
      metadata: { environment_id, scope: "shared", keys: revealed.map((v) => v.key) },
      ip: clientIp(c),
    });
    return c.json({ variables: revealed }, 200);
  });
