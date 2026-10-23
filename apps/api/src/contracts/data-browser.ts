/**
 * The data browser (ADR 0004, "Data browser and query runner"): queries a
 * database service through the agent on the node holding its volume.
 *
 * The caller never handles a credential: the API resolves the read-only
 * (`roundhouse_ro`) or admin principal from the service's secret variables,
 * seals it to the node for one request, and returns only the result. Results
 * are never stored. Raw statements are audited (`database.query_executed`)
 * with the first 2 KiB of the statement and its SHA-256, never parameters
 * or results.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import {
  DbOpSchema,
  MAX_DB_COLUMNS,
  MAX_DB_QUERY_ROWS,
  MAX_DB_QUERY_TIMEOUT_MS,
} from "@roundhouse/protocol";
import { SERVICE_DATABASE_ENGINES } from "@roundhouse/shared";
import { body, errors, json, sessionAuth } from "../schemas";
import { EnvironmentQuery, ServiceParams } from "./params";
import { defineRoute, session } from "./policy";

const [listNamespaces, listTables, describeTable, tableRows, rawStatement] = DbOpSchema.options;

/**
 * An operation the API accepts: every `DbOp` except `provision_readonly`
 * and `set_password`, which only the control plane sends.
 */
export const QueryOpSchema = z
  .discriminatedUnion("type", [listNamespaces, listTables, describeTable, tableRows, rawStatement])
  .openapi("DatabaseQueryOp");

/** Body of `POST /v1/services/{serviceId}/database/query`. */
export const DatabaseQueryBody = z
  .object({
    environment_id: z.string(),
    /** `read` runs as `roundhouse_ro` in a read-only transaction; `write` as the admin. */
    mode: z.enum(["read", "write"]).default("read"),
    op: QueryOpSchema,
    /** Rows returned at most; 100 when omitted. */
    max_rows: z.number().int().min(1).max(MAX_DB_QUERY_ROWS).optional(),
    /** Query timeout in ms; 10 s when omitted. */
    timeout_ms: z.number().int().min(100).max(MAX_DB_QUERY_TIMEOUT_MS).optional(),
  })
  .openapi("DatabaseQuery");

/** One result column. */
const ColumnSchema = z.object({ name: z.string(), type: z.string() });

/**
 * A query's result. `ok: false` is an engine error (syntax, permission, a
 * write refused in read mode), not a transport failure.
 */
export const DatabaseQueryResultSchema = z
  .object({
    request_id: z.string(),
    ok: z.boolean(),
    columns: z.array(ColumnSchema).max(MAX_DB_COLUMNS).optional(),
    /** Cells are JSON values: binary as `{"$b64": "…"}`, 64-bit integers as strings. */
    rows: z.array(z.array(z.unknown())).optional(),
    /** Rows returned, or rows affected by a write. */
    row_count: z.number().int().optional(),
    /** More rows existed than `max_rows`, or the result hit its size cap. */
    truncated: z.boolean().optional(),
    notice: z.string().optional(),
    error: z.string().optional(),
    duration_ms: z.number().int(),
  })
  .openapi("DatabaseQueryResult");

/** The database's namespaces, for the browser's schema tree. */
export const DatabaseSchemaSchema = z
  .object({
    engine: z.enum(SERVICE_DATABASE_ENGINES),
    version: z.string().nullable(),
    /** `list_namespaces`: databases, schemas, or Redis DB indexes. */
    namespaces: DatabaseQueryResultSchema,
  })
  .openapi("DatabaseSchema");

const QUERY_ERRORS =
  "409 when the service is not a database or has no running replica; 429 over 2 queries a " +
  "second per user or 4 at once per server; 503 when its server is offline; 504 when the " +
  "server does not answer within 35 s.";

/**
 * Runs one data-browser operation. `write` mode needs `data:write` and a
 * fresh session.
 */
export const runDatabaseQuery = defineRoute(session("data:read", ["database.query_executed"]), {
  method: "post",
  path: "/v1/services/{serviceId}/database/query",
  tags: ["databases"],
  summary: "Query a database",
  description: `\`mode: write\` also needs \`data:write\` and a fresh session (403 \`reauth_required\`). ${QUERY_ERRORS}`,
  security: sessionAuth,
  request: { params: ServiceParams, ...body(DatabaseQueryBody) },
  responses: {
    200: json(DatabaseQueryResultSchema),
    ...errors(400, 401, 403, 404, 409, 429, 503, 504),
  },
});

/** Opens the data browser: the database's namespaces. Audited once per call. */
export const getDatabaseSchema = defineRoute(session("data:read", ["database.browser_opened"]), {
  method: "get",
  path: "/v1/services/{serviceId}/database/schema",
  tags: ["databases"],
  summary: "Get a database's schema",
  description: QUERY_ERRORS,
  security: sessionAuth,
  request: { params: ServiceParams, query: EnvironmentQuery },
  responses: {
    200: json(DatabaseSchemaSchema),
    ...errors(401, 403, 404, 409, 429, 503, 504),
  },
});

/** Every data-browser route, by name. */
export const DATA_BROWSER_ROUTES = { runDatabaseQuery, getDatabaseSchema } as const;

/** A query's result. */
export type DatabaseQueryResult = z.infer<typeof DatabaseQueryResultSchema>;
