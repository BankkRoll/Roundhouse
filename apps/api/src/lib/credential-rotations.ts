/**
 * Rotating a database's credentials (ADR 0004, "Generated credentials").
 *
 * One call runs the whole rotation:
 * 1. Claim the service's `running` rotation, or start one: fresh passwords
 *    for the asked principals, sealed under the project DEK in the row, so
 *    a rotation cut short after the engine took a password can be finished
 *    by the next call instead of locking everyone out.
 * 2. For each principal not yet applied, in template order (read-only,
 *    MySQL's application user, the admin last because every change
 *    connects as it): a `set_password` op through the node's query
 *    channel, as the admin, with the new password only in the sealed
 *    `db-credential` box. A failed admin change is retried connecting with
 *    the new password, in case an earlier call's change landed unanswered.
 * 3. Store the applied passwords as write-only `secret` variables through a
 *    change set applied with `deploy: "affected"`, which redeploys the
 *    database (its container's environment must match the engine: a
 *    restore and a Redis restart apply the passwords from it) and every
 *    service referencing them.
 * 4. Clear the sealed passwords and record the outcome.
 *
 * An unanswered query (timeout, node gone) leaves the rotation `running`
 * with its lease released, for the next call to resume. An engine that
 * refuses a change ends it `failed`, after storing whatever it did accept.
 *
 * SECURITY: a password exists in plaintext only inside this call. It is
 * never returned, audited or logged; the frame carries it sealed to the
 * node and bound to the request.
 *
 * @module
 */
import { credentialRotations, type Db, nodes, type services, volumes } from "@roundhouse/db";
import { MAX_DB_QUERY_RESULT_BYTES } from "@roundhouse/protocol";
import {
  type DatabasePrincipal,
  type DatabasePrincipalVariables,
  databasePrincipals,
  generateDatabasePassword,
  LIVE_VOLUME_STATUSES,
  newId,
  type ServiceDatabaseEngine,
} from "@roundhouse/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { type AppContext, clientIp, requireKeys } from "../context";
import { auditInsert, recordAudit } from "./audit";
import { applySet } from "./changes/apply";
import { type StagingContext, stageIntoSet } from "./changes/staging";
import { type EnvironmentRow, openChangeSet, type ProjectRow } from "./changes/store";
import { sealWith, unsealWith } from "./crypto";
import {
  findQueryTarget,
  newQueryRequestId,
  type QueryTarget,
  type RunQueryOutcome,
  sealDatabaseCredential,
} from "./db-query";
import { ApiError, conflict, isUniqueViolation } from "./errors";
import { resolveServiceEnvironment } from "./resolve-env";
import { type Caller, projectScope } from "./scope";
import { projectKey } from "./variables";

/** A `credential_rotations` row. */
export type RotationRow = typeof credentialRotations.$inferSelect;

/**
 * How long a call holds a running rotation. A second call within it gets
 * 409; after it (the first call died), the second one resumes.
 */
export const ROTATION_LEASE_MS = 2 * 60 * 1000;

/** How long one `set_password` may take on the node. */
const SET_PASSWORD_TIMEOUT_MS = 20_000;

const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** AAD of a rotation's sealed passwords. */
export function rotationSecretsAad(rotationId: string): string {
  return `credential-rotation:${rotationId}`;
}

/**
 * The `CredentialRotation` wire shape. Never carries a password.
 *
 * @param r - The row.
 * @returns See `CredentialRotationSchema`.
 */
export function toApiRotation(r: RotationRow) {
  return {
    id: r.id,
    service_id: r.serviceId,
    environment_id: r.environmentId,
    status: r.status,
    principals: r.principals,
    applied: r.applied,
    change_set_id: r.changeSetId,
    deployment_ids: r.deploymentIds ?? [],
    error: r.error,
    requested_by: r.requestedBy,
    created_at: +r.createdAt,
    finished_at: r.finishedAt ? +r.finishedAt : null,
  };
}

/**
 * Recent rotations of a database in an environment, newest first.
 *
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @returns At most 20 rows.
 */
export function listRotations(db: Db, serviceId: string, environmentId: string) {
  return db
    .select()
    .from(credentialRotations)
    .where(
      and(
        eq(credentialRotations.serviceId, serviceId),
        eq(credentialRotations.environmentId, environmentId),
      ),
    )
    .orderBy(desc(credentialRotations.id))
    .limit(20);
}

/** What {@link rotateCredentials} works on. */
export interface RotationInput {
  service: typeof services.$inferSelect;
  project: ProjectRow;
  environment: EnvironmentRow;
  /** Resolved in the environment. */
  caller: Caller;
  /** Principals to rotate; every one the engine has when omitted. Ignored when resuming. */
  principals?: readonly DatabasePrincipal[];
}

/**
 * Runs (or resumes) a rotation. See the module docs for the steps.
 *
 * @param c - Request context.
 * @param input - The database, where, who, and which principals.
 * @returns The rotation as it ended (`succeeded` or `failed`).
 * @throws {ApiError} 409 while another call holds the rotation or the
 *   database isn't running; 422 for a principal the engine lacks; 502, 503
 *   or 504 when the node didn't answer (the rotation stays `running`).
 */
export async function rotateCredentials(c: AppContext, input: RotationInput): Promise<RotationRow> {
  const { service, project, environment, caller } = input;
  const engine = service.databaseEngine;
  if (!engine) throw conflict("This service is not a database");
  const db = c.get("db");
  const all = databasePrincipals(engine);
  const asked = input.principals ?? all.map((p) => p.principal);
  const unknown = asked.filter((p) => !all.some((a) => a.principal === p));
  if (unknown.length) {
    throw new ApiError(
      422,
      "invalid_request",
      `A ${engine} database has no ${unknown.join(", ")} principal`,
    );
  }

  const found = await findQueryTarget(db, service.id, environment.id);
  if (!found.ok) {
    if (found.reason === "node_unavailable") {
      throw new ApiError(503, "node_offline", "The database's server is unavailable");
    }
    throw conflict("The database must be running to rotate its credentials");
  }
  const target = found.target;
  const [node] = await db
    .select({ name: nodes.name, capabilities: nodes.capabilities })
    .from(nodes)
    .where(eq(nodes.id, target.nodeId))
    .limit(1);
  if (node?.capabilities?.db_set_password !== true) {
    throw new ApiError(
      409,
      "agent_outdated",
      `Upgrade the agent on ${node?.name ?? "the database's server"} to rotate credentials`,
    );
  }

  const dek = await projectKey(db, requireKeys(c), project.id);
  const resolved = await resolveServiceEnvironment(db, dek, {
    projectId: project.id,
    serviceId: service.id,
    environment,
  });
  if (!resolved.ok) throw conflict("The database's credential variables don't resolve");
  const env = resolved.env;

  const row = await claimOrStart(db, dek, {
    project,
    service,
    environment,
    caller,
    principals: all.map((p) => p.principal).filter((p) => asked.includes(p)),
  });
  const secrets = JSON.parse(
    await unsealWith(dek, row.secretsSealed!, rotationSecretsAad(row.id)),
  ) as Record<DatabasePrincipal, string>;

  const [volume] = await db
    .select({ provisioned: volumes.readonlyProvisionedAt })
    .from(volumes)
    .where(
      and(
        eq(volumes.serviceId, service.id),
        eq(volumes.environmentId, environment.id),
        inArray(volumes.status, [...LIVE_VOLUME_STATUSES]),
      ),
    )
    .limit(1);
  const admin = all.find((p) => p.principal === "admin")!;
  const adminUser = usernameOf(admin, env);
  const applied = [...row.applied];
  let refused: string | null = null;
  let unanswered: ApiError | null = null;
  for (const principal of row.principals) {
    if (applied.includes(principal)) continue;
    const spec = all.find((p) => p.principal === principal)!;
    // NOTE: a read-only user that doesn't exist yet is created later with
    // whatever its variable holds then, so the variable alone changes.
    const skipEngine = principal === "readonly" && engine !== "redis" && !volume?.provisioned;
    if (!skipEngine) {
      const user = usernameOf(spec, env);
      const adminPassword = env[admin.passwordVariable];
      if (!user || !adminUser || !adminPassword) {
        refused = `${principal}: its credential variables are missing`;
        break;
      }
      const send = (connectWith: string) =>
        setPassword(c, target, engine, {
          username: adminUser,
          password: connectWith,
          new_password: secrets[principal],
          user,
        });
      let outcome = await send(adminPassword);
      if (principal === "admin" && outcome.ok && !outcome.result.ok) {
        const retried = await send(secrets.admin);
        if (retried.ok && retried.result.ok) outcome = retried;
      }
      if (!outcome.ok) {
        unanswered = unansweredError(outcome.reason);
        break;
      }
      if (!outcome.result.ok) {
        refused = `${principal}: ${outcome.result.error ?? "the database refused the change"}`;
        break;
      }
    }
    applied.push(principal);
    await db
      .update(credentialRotations)
      .set({ applied: [...applied], updatedAt: new Date() })
      .where(eq(credentialRotations.id, row.id));
  }

  if (unanswered) {
    await release(db, row.id, applied, unanswered.message);
    throw unanswered;
  }

  let changeSetId: string | null = null;
  let deploymentIds: string[] = [];
  if (applied.length) {
    try {
      const stored = await storePasswords(c, {
        project,
        environment,
        service,
        engine,
        principals: applied.map((p) => all.find((a) => a.principal === p)!),
        secrets,
      });
      changeSetId = stored.changeSetId;
      deploymentIds = stored.deploymentIds;
    } catch (err) {
      // The engine holds the new passwords: keep them sealed for a retry.
      const message = err instanceof Error ? err.message : "storing the passwords failed";
      await release(db, row.id, applied, message);
      throw err;
    }
  }

  const now = new Date();
  const [done] = await db.batch([
    db
      .update(credentialRotations)
      .set({
        status: refused ? "failed" : "succeeded",
        applied,
        secretsSealed: null,
        changeSetId,
        deploymentIds,
        error: refused,
        finishedAt: now,
        updatedAt: now,
      })
      .where(eq(credentialRotations.id, row.id))
      .returning(),
    auditInsert(db, {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: refused ? "database.credentials_rotation_failed" : "database.credentials_rotated",
      targetType: "service",
      targetId: service.id,
      metadata: {
        project_id: project.id,
        environment_id: environment.id,
        rotation_id: row.id,
        principals: row.principals,
        applied,
        change_set_id: changeSetId,
        deployments: deploymentIds.length,
        ...(refused ? { error: refused } : {}),
      },
      ip: clientIp(c),
    }),
  ]);
  return done[0]!;
}

/** A principal's user name from the resolved environment. */
function usernameOf(spec: DatabasePrincipalVariables, env: Record<string, string>) {
  return "literal" in spec.username ? spec.username.literal : env[spec.username.variable];
}

/** Claims the running rotation, or inserts a new one with sealed passwords. */
async function claimOrStart(
  db: Db,
  dek: CryptoKey,
  input: {
    project: ProjectRow;
    service: typeof services.$inferSelect;
    environment: EnvironmentRow;
    caller: Caller;
    principals: DatabasePrincipal[];
  },
): Promise<RotationRow> {
  const now = new Date();
  const [running] = await db
    .select()
    .from(credentialRotations)
    .where(
      and(
        eq(credentialRotations.serviceId, input.service.id),
        eq(credentialRotations.environmentId, input.environment.id),
        eq(credentialRotations.status, "running"),
      ),
    )
    .limit(1);
  if (running) {
    const busy = conflict(
      "Another request is running this rotation; try again in a couple of minutes",
    );
    if (+now - +running.updatedAt < ROTATION_LEASE_MS) throw busy;
    const [claimed] = await db
      .update(credentialRotations)
      .set({ updatedAt: now })
      .where(
        and(
          eq(credentialRotations.id, running.id),
          eq(credentialRotations.status, "running"),
          eq(credentialRotations.updatedAt, running.updatedAt),
        ),
      )
      .returning();
    if (!claimed) throw busy;
    return claimed;
  }
  const id = newId("credentialRotation");
  const passwords = Object.fromEntries(
    input.principals.map((p) => [p, generateDatabasePassword(randomBytes)]),
  );
  try {
    const [row] = await db
      .insert(credentialRotations)
      .values({
        id,
        projectId: input.project.id,
        serviceId: input.service.id,
        environmentId: input.environment.id,
        status: "running",
        principals: input.principals,
        applied: [],
        secretsSealed: await sealWith(dek, JSON.stringify(passwords), rotationSecretsAad(id)),
        deploy: "affected",
        requestedBy: input.caller.user.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err, "credential_rotations")) {
      throw conflict("Another request started a rotation of this database; reload");
    }
    throw err;
  }
}

/** Leaves a rotation `running`, with its lease expired so the next call resumes it at once. */
async function release(db: Db, id: string, applied: DatabasePrincipal[], error: string) {
  await db
    .update(credentialRotations)
    .set({ applied, error, updatedAt: new Date(Date.now() - ROTATION_LEASE_MS) })
    .where(and(eq(credentialRotations.id, id), eq(credentialRotations.status, "running")));
}

function unansweredError(reason: Extract<RunQueryOutcome, { ok: false }>["reason"]): ApiError {
  const resume = "the rotation is kept and the next request finishes it";
  switch (reason) {
    case "timeout":
      return new ApiError(504, "query_timeout", `The database's server didn't answer; ${resume}`);
    case "not_connected":
      return new ApiError(503, "node_offline", `The database's server is offline; ${resume}`);
    case "protocol_too_old":
      return new ApiError(409, "agent_outdated", `Upgrade the database's agent; ${resume}`);
    default:
      return new ApiError(502, "credential_rotation_failed", `The server is busy; ${resume}`);
  }
}

/** Sends one `set_password` and waits for its result. */
async function setPassword(
  c: AppContext,
  target: QueryTarget,
  engine: ServiceDatabaseEngine,
  input: { username: string; password: string; new_password: string; user: string },
): Promise<RunQueryOutcome> {
  const requestId = newQueryRequestId();
  const stub = c.env.NODE_CONNECTION.get(c.env.NODE_CONNECTION.idFromName(target.nodeId));
  return (await stub.runQuery({
    request_id: requestId,
    workload_id: target.workloadId,
    engine,
    credential_sealed: await sealDatabaseCredential(target, requestId, {
      username: input.username,
      password: input.password,
      new_password: input.new_password,
    }),
    mode: "write",
    op: { type: "set_password", user: input.user },
    max_rows: 1,
    max_bytes: MAX_DB_QUERY_RESULT_BYTES,
    timeout_ms: SET_PASSWORD_TIMEOUT_MS,
  })) as RunQueryOutcome;
}

/**
 * Stores the new passwords as secret variables through a change set applied
 * with `deploy: "affected"`.
 */
async function storePasswords(
  c: AppContext,
  input: {
    project: ProjectRow;
    environment: EnvironmentRow;
    service: typeof services.$inferSelect;
    engine: ServiceDatabaseEngine;
    principals: DatabasePrincipalVariables[];
    secrets: Record<DatabasePrincipal, string>;
  },
): Promise<{ changeSetId: string; deploymentIds: string[] }> {
  const db = c.get("db");
  const { project, environment, service } = input;
  const { caller } = await projectScope(c, project.id, "projects:read");
  const ctx: StagingContext = { db, keys: requireKeys(c), project, environment, caller };
  let set = await openChangeSet(db, {
    projectId: project.id,
    environmentId: environment.id,
    source: "api",
    isDraft: false,
    caller,
    title: `Rotate the credentials of ${service.name}`,
  });
  for (const p of input.principals) {
    set = await stageIntoSet(ctx, set, {
      type: "variable.set",
      scope: "service",
      service: service.id,
      key: p.passwordVariable,
      value: input.secrets[p.principal],
      tier: "secret",
      confirm_write_only: true,
      acknowledge_public: false,
    });
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
      source: "api",
      ops: input.principals.length,
      engine: input.engine,
    },
    ip: clientIp(c),
  });
  const applied = await applySet({ c, db, env: c.env, project, environment }, set, {
    expectedRevision: set.revision,
    deploy: "affected",
  });
  return { changeSetId: applied.set.id, deploymentIds: applied.deploymentIds };
}
