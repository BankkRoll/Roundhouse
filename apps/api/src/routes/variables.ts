/**
 * Service and shared variables. Values are sealed with the project's data
 * key. Secret values are write-only: no route returns them (ADR 0014). Plain
 * values are returned only to callers who may read them. Reference syntax is
 * checked on write; unknown targets and cycles surface at deploy time.
 *
 * The resolved route returns a service's plain environment through the
 * deploy path's resolver, for running the service locally; secrets and
 * values derived from them are left for the CLI to take from a local `.env`.
 *
 * Access is checked with `resolveAccess`, the project in scope; writes also
 * name the environment, so its protection applies. Lists carry every
 * value's fingerprint, so readers who can't see values can still tell
 * them apart.
 *
 * @module
 */
import { clientIp, createRouter, requireKeys } from "../context";
import {
  listServiceVariables,
  listSharedVariables,
  policyOf,
  putServiceVariables,
  putSharedVariables,
  resolveServiceVariables,
} from "../contracts";
import { recordAudit } from "../lib/audit";
import { resolvePlainEnvironment } from "../lib/plain-env";
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
    const key = await projectKey(db, requireKeys(c), project.id);
    const plain = caller.allows("variables:read_plain");
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
      environment_id,
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
    const key = await projectKey(db, requireKeys(c), project.id);
    const changed = await putVariables(db, key, target, body, caller.user.id);
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "variables.updated",
      targetType: "service",
      targetId: serviceId,
      metadata: {
        environment_id,
        set: changed.set,
        deleted: changed.deleted,
        ...(changed.unwithheld.length ? { replaced_withheld: changed.unwithheld } : {}),
      },
      ip: clientIp(c),
    });
    const plain = caller.allows("variables:read_plain");
    return c.json(
      {
        variables: await listVariables(db, key, target, { plain }),
        warnings: changed.warnings,
      },
      200,
    );
  })
  .openapi(resolveServiceVariables, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    const { service, project, caller } = await serviceScope(
      c,
      serviceId,
      policyOf(resolveServiceVariables).action!,
    );
    const environment = await environmentOf(c, project.id, environment_id);
    const db = c.get("db");
    const key = await projectKey(db, requireKeys(c), project.id);
    const { variables, localKeys } = await resolvePlainEnvironment(db, key, {
      projectId: project.id,
      service,
      environment,
    });
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "variables.resolved",
      targetType: "service",
      targetId: serviceId,
      metadata: { environment_id, keys: Object.keys(variables), local_keys: localKeys },
      ip: clientIp(c),
    });
    return c.json({ variables, local_keys: localKeys }, 200);
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
    const key = await projectKey(db, requireKeys(c), project.id);
    const target: VariableTarget = {
      projectId,
      environmentId: environment_id,
      scope: "shared",
      serviceId: null,
    };
    const plain = caller.allows("variables:read_plain");
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
      environment_id,
    );
    await environmentOf(c, project.id, environment_id);
    assertValidReferences(withValues(body.set));
    const db = c.get("db");
    const key = await projectKey(db, requireKeys(c), project.id);
    const target: VariableTarget = {
      projectId,
      environmentId: environment_id,
      scope: "shared",
      serviceId: null,
    };
    const changed = await putVariables(db, key, target, body, caller.user.id);
    await recordAudit(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "variables.updated",
      targetType: "project",
      targetId: projectId,
      metadata: {
        environment_id,
        scope: "shared",
        set: changed.set,
        deleted: changed.deleted,
        ...(changed.unwithheld.length ? { replaced_withheld: changed.unwithheld } : {}),
      },
      ip: clientIp(c),
    });
    const plain = caller.allows("variables:read_plain");
    return c.json(
      {
        variables: await listVariables(db, key, target, { plain }),
        warnings: changed.warnings,
      },
      200,
    );
  });
