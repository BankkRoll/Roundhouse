/**
 * Service and shared variables. Values are sealed with the project's data
 * key. Secret values are write-only: no route returns them (ADR 0014). Plain
 * values are returned only to callers who may read them. Reference syntax is
 * checked on write; unknown targets and cycles surface at deploy time.
 *
 * TODO(api-secrets-crypto): `resolveServiceVariables`, v2 sealing and
 * fingerprints. TODO(api-authz-rbac-github): check with `resolveAccess` and
 * the environment's protection instead of the workspace role.
 *
 * @module
 */
import { can } from "@roundhouse/shared";
import { clientIp, createRouter, requireMasterKey } from "../context";
import {
  listServiceVariables,
  listSharedVariables,
  policyOf,
  putServiceVariables,
  putSharedVariables,
} from "../contracts";
import { recordAudit } from "../lib/audit";
import { environmentOf, projectScope, serviceScope } from "../lib/scope";
import {
  assertValidReferences,
  listVariables,
  projectKey,
  putVariables,
  type VariableTarget,
} from "../lib/variables";

const withValues = (set: readonly { key: string; value?: string }[]) =>
  set.flatMap((s) => (s.value === undefined ? [] : [{ key: s.key, value: s.value }]));

/** Variable routes. */
export const variableRoutes = createRouter()
  .openapi(listServiceVariables, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    const { project, caller } = await serviceScope(
      c,
      serviceId,
      policyOf(listServiceVariables).action!,
    );
    await environmentOf(c, project.id, environment_id);
    const db = c.get("db");
    const target: VariableTarget = {
      projectId: project.id,
      environmentId: environment_id,
      scope: "service",
      serviceId,
    };
    const key = await projectKey(db, requireMasterKey(c), project.id);
    const plain = can(caller.role, "variables:read_plain");
    return c.json({ variables: await listVariables(db, key, target, { plain }) }, 200);
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
    assertValidReferences(withValues(body.set));
    const db = c.get("db");
    const target: VariableTarget = {
      projectId: project.id,
      environmentId: environment_id,
      scope: "service",
      serviceId,
    };
    const key = await projectKey(db, requireMasterKey(c), project.id);
    const changed = await putVariables(db, key, target, body, caller.user.id);
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
    const plain = can(caller.role, "variables:read_plain");
    return c.json(
      {
        variables: await listVariables(db, key, target, { plain }),
        warnings: changed.warnings,
      },
      200,
    );
  })
  .openapi(listSharedVariables, async (c) => {
    const { projectId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    const { project, caller } = await projectScope(
      c,
      projectId,
      policyOf(listSharedVariables).action!,
    );
    await environmentOf(c, project.id, environment_id);
    const db = c.get("db");
    const key = await projectKey(db, requireMasterKey(c), project.id);
    const target: VariableTarget = {
      projectId,
      environmentId: environment_id,
      scope: "shared",
      serviceId: null,
    };
    const plain = can(caller.role, "variables:read_plain");
    return c.json({ variables: await listVariables(db, key, target, { plain }) }, 200);
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
    assertValidReferences(withValues(body.set));
    const db = c.get("db");
    const key = await projectKey(db, requireMasterKey(c), project.id);
    const target: VariableTarget = {
      projectId,
      environmentId: environment_id,
      scope: "shared",
      serviceId: null,
    };
    const changed = await putVariables(db, key, target, body, caller.user.id);
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
    const plain = can(caller.role, "variables:read_plain");
    return c.json(
      {
        variables: await listVariables(db, key, target, { plain }),
        warnings: changed.warnings,
      },
      200,
    );
  });
