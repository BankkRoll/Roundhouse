/**
 * Web shell routes (ADR 0012 "Web shell", ADR 0014 §15): the terminal
 * socket, the replicas a service offers one in, the session history and
 * terminating a session.
 *
 * Deviations from the ADR's table:
 * - `GET /v1/services/{serviceId}/shell-targets` (not in the ADR) lists the
 *   running replicas and previews the caller's gate, so the dashboard can
 *   ask for re-authentication or 2FA, or explain a protected environment,
 *   before connecting.
 * - `GET /v1/shell-sessions/{sessionId}/recording` also needs a fresh
 *   browser session (`reauth`): a recording holds secrets, as a revealed
 *   variable would.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { MAX_EXEC_ARGS, MAX_EXEC_COLS, MAX_EXEC_ROWS } from "@roundhouse/protocol";
import { ASCIICAST_CONTENT_TYPE, SHELL_DENIALS, SHELL_RECORDING_STATES } from "@roundhouse/shared";
import {
  CursorField,
  errors,
  json,
  LimitField,
  Millis,
  sessionAuth,
  sessionOnlyAuth,
  WorkspaceParams,
} from "../schemas";
import { EnvironmentQuery, ServiceParams } from "./params";
import { defineRoute, session, sessionOnly } from "./policy";

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

/** `{workloadId}` path param. */
export const WorkloadParams = z.object({ workloadId: z.string() });

/** `{sessionId}` path param. */
export const ShellSessionParams = z.object({ sessionId: z.string() });

/** Query of the shell socket. */
export const ShellQuery = z.object({
  cols: z.coerce.number().int().min(1).max(MAX_EXEC_COLS).default(80),
  rows: z.coerce.number().int().min(1).max(MAX_EXEC_ROWS).default(24),
  /**
   * The command's argv, one `cmd` per argument, in order. Never joined into
   * a shell string. Default: a login bash, else a login sh.
   */
  cmd: z
    .union([z.string(), z.array(z.string()).max(MAX_EXEC_ARGS)])
    .optional()
    .openapi({ example: ["/bin/sh"] }),
  /** `TERM` for the process. */
  term: z
    .string()
    .regex(/^[A-Za-z0-9._+-]{1,64}$/, "expected a terminal name")
    .default("xterm-256color"),
});

/** Why the gate refuses; see `SHELL_DENIALS`. */
export const ShellDenialSchema = z.enum(SHELL_DENIALS).openapi("ShellDenial");

/** A replica a shell can open in. */
export const ShellTargetSchema = z
  .object({
    workload_id: z.string(),
    deployment_id: z.string(),
    replica: z.number().int(),
    node_id: z.string(),
    node_name: z.string(),
    /** The replica's last reported state. */
    state: z.string(),
    /** The node is online and its agent speaks the shell protocol. */
    shell_supported: z.boolean(),
  })
  .openapi("ShellTarget");

/** A service's shell targets in an environment, and whether the caller may open one. */
export const ShellTargetsSchema = z
  .object({
    targets: z.array(ShellTargetSchema),
    gate: z.object({ allowed: z.boolean(), reason: ShellDenialSchema.nullable() }),
  })
  .openapi("ShellTargets");

/** One shell session. Never carries terminal input or output, or the command's arguments. */
export const ShellSessionSchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
    environment_id: z.string(),
    service_id: z.string(),
    workload_id: z.string(),
    deployment_id: z.string().nullable(),
    replica: z.number().int(),
    node_id: z.string().nullable(),
    user_id: z.string().nullable(),
    token_id: z.string().nullable(),
    /** argv[0] only. */
    command: z.string(),
    container_user: z.string().nullable(),
    started_at: Millis,
    opened_at: Millis.nullable(),
    ended_at: Millis.nullable(),
    /** A `ShellExitReason`, or `terminated`; `null` while open. */
    end_reason: z.string().nullable(),
    exit_code: z.number().int().nullable(),
    bytes_in: z.number().int(),
    bytes_out: z.number().int(),
    /**
     * `none` (not recorded, or deleted by retention), `recording` (still
     * being written), `stored` (playable) or `failed`.
     */
    recording: z.enum(SHELL_RECORDING_STATES),
    /** Parts of the recording in storage. */
    recording_parts: z.number().int(),
  })
  .openapi("ShellSession");

/** A page of shell sessions, newest first. */
export const ShellSessionPageSchema = z
  .object({ sessions: z.array(ShellSessionSchema), next_cursor: z.string().nullable() })
  .openapi("ShellSessionPage");

/** Query of the session history. */
export const ShellSessionListQuery = z.object({
  project_id: z.string().optional(),
  cursor: CursorField,
  limit: LimitField,
});

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

/**
 * A WebSocket to a shell in one replica. Binary frames carry terminal bytes
 * both ways; JSON text frames carry `resize` and `close` (client) and
 * `opened` and `exit` (server), see `@roundhouse/shared` `shell`.
 *
 * A browser can't read a refused upgrade's status, so refusals complete the
 * upgrade and close with a `SHELL_CLOSE_CODES` code: 4401 (no valid
 * credential, or an OAuth token), 4403 (no `shell:open`), 4404 (no such
 * running workload), 4428 (re-authenticate), 4430 (enable 2FA), 4431 (API
 * token in a protected environment), 4409 (node busy), 4426 (agent too old),
 * 4503 (agent not connected), 1008 (invalid command). Only a non-upgrade
 * (426), a cross-origin cookie upgrade (403) and an invalid query (400) are
 * refused over HTTP.
 */
export const openShell = defineRoute(session("shell:open", ["shell.opened", "shell.closed"]), {
  method: "get",
  path: "/v1/workloads/{workloadId}/shell",
  tags: ["shell"],
  summary: "Shell socket",
  security: sessionAuth,
  request: { params: WorkloadParams, query: ShellQuery },
  responses: {
    101: { description: "Switching Protocols" },
    ...errors(400, 403, 426),
  },
});

/**
 * The running replicas of a service's active deployment in an environment,
 * and whether the caller would pass the shell gate there.
 */
export const listShellTargets = defineRoute(session("services:read"), {
  method: "get",
  path: "/v1/services/{serviceId}/shell-targets",
  tags: ["shell"],
  summary: "List shell targets",
  security: sessionAuth,
  request: { params: ServiceParams, query: EnvironmentQuery },
  responses: { 200: json(ShellTargetsSchema), ...errors(400, 401, 403, 404) },
});

/** A workspace's shell sessions, newest first. */
export const listShellSessions = defineRoute(session("audit:read"), {
  method: "get",
  path: "/v1/workspaces/{workspaceId}/shell-sessions",
  tags: ["shell"],
  summary: "List shell sessions",
  security: sessionAuth,
  request: { params: WorkspaceParams, query: ShellSessionListQuery },
  responses: { 200: json(ShellSessionPageSchema), ...errors(400, 401, 403, 404) },
});

/**
 * Ends an open session. Your own needs `shell:open` on its environment;
 * someone else's needs `members:manage`. 409 when it already ended.
 */
export const terminateShellSession = defineRoute(session("shell:open", ["shell.terminated"]), {
  method: "post",
  path: "/v1/shell-sessions/{sessionId}/terminate",
  tags: ["shell"],
  summary: "Terminate a shell session",
  security: sessionAuth,
  request: { params: ShellSessionParams },
  responses: { 200: json(ShellSessionSchema), ...errors(401, 403, 404, 409) },
});

/**
 * A session's recording, decrypted: asciicast v2 text (a header line, then
 * `[t, "o"|"i"|"r", text]` events), its parts joined. Needs `audit:read`
 * in the workspace, `shell:open` on the session's environment, and a fresh
 * browser session (403 `reauth_required`; API tokens never qualify). 404
 * when nothing is stored (not recorded, still being written, failed, or
 * deleted by retention). Audited `shell.recording_viewed` with ids only.
 */
export const getShellRecording = defineRoute(
  sessionOnly("audit:read", ["shell.recording_viewed"], { reauth: true }),
  {
    method: "get",
    path: "/v1/shell-sessions/{sessionId}/recording",
    tags: ["shell"],
    summary: "Play back a shell recording",
    security: sessionOnlyAuth,
    request: { params: ShellSessionParams },
    responses: {
      200: {
        description: "The recording (asciicast v2), never cached",
        content: { [ASCIICAST_CONTENT_TYPE]: { schema: z.string() } },
      },
      ...errors(401, 403, 404),
    },
  },
);

/** Every shell route, for the contract tests. */
export const SHELL_ROUTES = {
  openShell,
  listShellTargets,
  listShellSessions,
  terminateShellSession,
  getShellRecording,
} as const;

/** A shell session. */
export type ShellSession = z.infer<typeof ShellSessionSchema>;

/** A service's shell targets and gate preview. */
export type ShellTargets = z.infer<typeof ShellTargetsSchema>;
