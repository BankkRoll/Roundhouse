/**
 * Data-browser routes (ADR 0004): run one operation against a database
 * service, and open the browser on its namespaces.
 *
 * Each call authorizes `data:read` in the environment (protection applies),
 * plus `data:write` and a fresh session for `mode: write`; finds the node
 * holding the volume and a running replica; resolves the principal from the
 * service's secret variables; seals it to that node for this request only;
 * and has the node's Durable Object send the signed `db_query` and wait for
 * the answer. Results go back to the caller and nowhere else.
 *
 * @module
 */
import type { z } from "@hono/zod-openapi";
import { MAX_DB_QUERY_RESULT_BYTES } from "@roundhouse/protocol";
import type { ServiceDatabaseEngine } from "@roundhouse/shared";
import { type AppContext, clientIp, createRouter, requireKeys } from "../context";
import { getDatabaseSchema, policyOf, runDatabaseQuery } from "../contracts";
import type { QueryOpSchema } from "../contracts/data-browser";
import { recordAudit } from "../lib/audit";
import {
  DEFAULT_QUERY_MAX_ROWS,
  DEFAULT_QUERY_TIMEOUT_MS,
  findQueryTarget,
  newQueryRequestId,
  type RunQueryOutcome,
  resolveDatabaseCredential,
  sealDatabaseCredential,
} from "../lib/db-query";
import { ApiError, conflict } from "../lib/errors";
import { requireFreshSession } from "../lib/fresh-session";
import { environmentOf, serviceScope } from "../lib/scope";

/** Bytes of a raw statement kept in its audit entry (ADR 0004, "Audit"). */
export const AUDITED_STATEMENT_BYTES = 2048;

type QueryOp = z.infer<typeof QueryOpSchema>;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The audit fields of a raw operation: the start of the statement and a
 * digest of all of it. SQL parameters and Redis arguments are values, so
 * only the Redis command name is kept, and neither appears in plain text.
 *
 * @param op - A `raw` operation.
 * @returns `statement` (at most {@link AUDITED_STATEMENT_BYTES}) and `statement_sha256`.
 */
export async function auditedStatement(op: Extract<QueryOp, { type: "raw" }>): Promise<{
  statement: string;
  statement_sha256: string;
}> {
  if (op.statement !== undefined) {
    const bytes = new TextEncoder().encode(op.statement);
    const head =
      bytes.byteLength <= AUDITED_STATEMENT_BYTES
        ? op.statement
        : // A cut through a multi-byte character decodes to U+FFFD; drop it.
          new TextDecoder().decode(bytes.slice(0, AUDITED_STATEMENT_BYTES)).replace(/�$/, "");
    return { statement: head, statement_sha256: await sha256Hex(op.statement) };
  }
  const argv = op.argv ?? [];
  return {
    statement: (argv[0] ?? "").slice(0, 64),
    statement_sha256: await sha256Hex(JSON.stringify(argv)),
  };
}

/** Maps a transport failure to the API error the caller sees. */
function queryFailure(reason: Extract<RunQueryOutcome, { ok: false }>["reason"]): ApiError {
  switch (reason) {
    case "not_connected":
      return new ApiError(503, "node_offline", "The database's server is offline");
    case "protocol_too_old":
      return conflict("The database's server runs an agent too old for the data browser");
    case "rate_limited":
      return new ApiError(429, "rate_limited", "At most 2 queries a second; slow down");
    case "busy":
      return new ApiError(429, "rate_limited", "The server is running 4 queries already; retry");
    case "timeout":
      return new ApiError(504, "query_timeout", "The server did not answer within 35 s");
  }
}

/**
 * Runs one operation on a database service; shared by both routes.
 *
 * @returns The result, and the request ID it ran under.
 */
async function execute(
  c: AppContext,
  input: {
    service: { id: string; databaseEngine: ServiceDatabaseEngine | null };
    projectId: string;
    environmentId: string;
    userId: string;
    mode: "read" | "write";
    op: QueryOp;
    maxRows: number;
    timeoutMs: number;
  },
) {
  const engine = input.service.databaseEngine;
  if (!engine) throw conflict("This service is not a database");
  const db = c.get("db");
  const found = await findQueryTarget(db, input.service.id, input.environmentId);
  if (!found.ok) {
    if (found.reason === "node_unavailable") {
      throw new ApiError(503, "node_offline", "The database's server is unavailable");
    }
    throw conflict(
      found.reason === "no_replica"
        ? "The database is not running in this environment"
        : "The database has not been deployed in this environment",
    );
  }
  const { target } = found;
  const credential = await resolveDatabaseCredential(
    db,
    requireKeys(c),
    {
      projectId: input.projectId,
      serviceId: input.service.id,
      environmentId: input.environmentId,
      engine,
    },
    input.mode,
  );
  if (!credential) {
    throw conflict("The database's credential variables are missing or don't resolve");
  }
  const requestId = newQueryRequestId();
  const stub = c.env.NODE_CONNECTION.get(c.env.NODE_CONNECTION.idFromName(target.nodeId));
  const outcome = (await stub.runQuery(
    {
      request_id: requestId,
      workload_id: target.workloadId,
      engine,
      credential_sealed: await sealDatabaseCredential(target, requestId, credential),
      mode: input.mode,
      op: input.op,
      max_rows: input.maxRows,
      max_bytes: MAX_DB_QUERY_RESULT_BYTES,
      timeout_ms: input.timeoutMs,
    },
    { userId: input.userId },
  )) as RunQueryOutcome;
  return { requestId, outcome, engine };
}

/** The response body of a result frame. */
function resultBody(requestId: string, outcome: Extract<RunQueryOutcome, { ok: true }>) {
  const { type: _type, request_id: _id, ...rest } = outcome.result;
  return { request_id: requestId, ...rest };
}

/** Data-browser routes. */
export const dataBrowserRoutes = createRouter()
  .openapi(runDatabaseQuery, async (c) => {
    const { serviceId } = c.req.valid("param");
    const body = c.req.valid("json");
    const { service, project, caller } = await serviceScope(
      c,
      serviceId,
      policyOf(runDatabaseQuery).action!,
      body.environment_id,
    );
    if (body.mode === "write") {
      await serviceScope(c, serviceId, "data:write", body.environment_id);
      await requireFreshSession(c);
    }
    await environmentOf(c, project.id, body.environment_id);
    const started = Date.now();
    const { requestId, outcome } = await execute(c, {
      service,
      projectId: project.id,
      environmentId: body.environment_id,
      userId: caller.user.id,
      mode: body.mode,
      op: body.op,
      maxRows: body.max_rows ?? DEFAULT_QUERY_MAX_ROWS,
      timeoutMs: body.timeout_ms ?? DEFAULT_QUERY_TIMEOUT_MS,
    });
    const sent = outcome.ok || outcome.reason === "timeout";
    if (body.op.type === "raw" && sent) {
      // SECURITY: the statement's head and digest, never its parameters or results.
      await recordAudit(c.get("db"), {
        workspaceId: project.workspaceId,
        ...caller.actor,
        action: "database.query_executed",
        targetType: "service",
        targetId: service.id,
        metadata: {
          environment_id: body.environment_id,
          request_id: requestId,
          mode: body.mode,
          ...(await auditedStatement(body.op)),
          outcome: outcome.ok ? (outcome.result.ok ? "ok" : "error") : "timeout",
          row_count: outcome.ok ? (outcome.result.row_count ?? null) : null,
          duration_ms: outcome.ok ? outcome.result.duration_ms : Date.now() - started,
        },
        ip: clientIp(c),
      });
    }
    if (!outcome.ok) throw queryFailure(outcome.reason);
    return c.json(resultBody(requestId, outcome), 200);
  })
  .openapi(getDatabaseSchema, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    const { service, project, caller } = await serviceScope(
      c,
      serviceId,
      policyOf(getDatabaseSchema).action!,
      environment_id,
    );
    await environmentOf(c, project.id, environment_id);
    const { requestId, outcome, engine } = await execute(c, {
      service,
      projectId: project.id,
      environmentId: environment_id,
      userId: caller.user.id,
      mode: "read",
      op: { type: "list_namespaces" },
      maxRows: 1000,
      timeoutMs: DEFAULT_QUERY_TIMEOUT_MS,
    });
    if (!outcome.ok) throw queryFailure(outcome.reason);
    await recordAudit(c.get("db"), {
      workspaceId: project.workspaceId,
      ...caller.actor,
      action: "database.browser_opened",
      targetType: "service",
      targetId: service.id,
      metadata: { environment_id },
      ip: clientIp(c),
    });
    return c.json(
      {
        engine,
        version: service.databaseVersion ?? null,
        namespaces: resultBody(requestId, outcome),
      },
      200,
    );
  });
